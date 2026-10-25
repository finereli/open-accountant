// Background reading for screenshot imports. The phone uploads every strip
// at once and may then leave the app (mobile browsers freeze a backgrounded
// page, which used to stop the import). Each claimed strip is read in its
// OWN request (a fetch back to /api/import/jobs/:id/strips/:idx), all at
// once: work after a response only gets ~30s, and several reads sharing one
// invocation's budget ran out together. A strip whose reader died anyway
// stays 'working' until its claim goes stale; the next status poll - the
// phone polls while it's open and again when it comes back - claims it again.

import type { Env } from "../_lib";
import type { ReadRow } from "../../../src/lib/statement-import";
import { readStrip, isCardAccount } from "./_vision";
import { serviceHeaders } from "../../_owner";

const STALE_MS = 45_000;
const MAX_ATTEMPTS = 3;

export async function createJob(
  db: D1Database,
  accountId: string,
  strips: string[],
): Promise<number> {
  const now = new Date().toISOString();
  // Abandoned imports don't pile up.
  await db
    .prepare(
      `DELETE FROM import_strips WHERE job_id IN (SELECT id FROM import_jobs WHERE created_at < ?)`,
    )
    .bind(new Date(Date.now() - 2 * 86400000).toISOString())
    .run();
  await db
    .prepare(`DELETE FROM import_jobs WHERE created_at < ?`)
    .bind(new Date(Date.now() - 2 * 86400000).toISOString())
    .run();
  // One open import per account: a new screenshot replaces the old one.
  await db
    .prepare(
      `DELETE FROM import_strips WHERE job_id IN (SELECT id FROM import_jobs WHERE account_id = ?)`,
    )
    .bind(accountId)
    .run();
  await db
    .prepare(`DELETE FROM import_jobs WHERE account_id = ?`)
    .bind(accountId)
    .run();

  const res = await db
    .prepare(
      "INSERT INTO import_jobs (account_id, total, created_at) VALUES (?, ?, ?)",
    )
    .bind(accountId, strips.length, now)
    .run();
  const id = Number(res.meta.last_row_id);
  // One strip per statement: a strip is a few hundred KB.
  for (let i = 0; i < strips.length; i++)
    await db
      .prepare(
        "INSERT INTO import_strips (job_id, idx, image) VALUES (?, ?, ?)",
      )
      .bind(id, i, strips[i])
      .run();
  return id;
}

// Claims every strip that's waiting (or whose worker went quiet) and reads
// them in parallel. Safe to call any number of times: a claim is an atomic
// UPDATE, so two pollers never read the same strip twice at once.
// `fanout` reads each strip in a request of its own (production); without
// it the strips are read here, in parallel (tests, or if fan-out fails).
export async function workJob(
  env: Env,
  jobId: number,
  fanout?: (idx: number) => Promise<void>,
): Promise<void> {
  const db = env.DB;
  const job = await db
    .prepare("SELECT account_id FROM import_jobs WHERE id = ?")
    .bind(jobId)
    .first<{ account_id: string }>();
  if (!job) return;
  const now = Date.now();
  const claimed = (
    await db
      .prepare(
        `UPDATE import_strips SET status = 'working', claimed_at = ?, attempts = attempts + 1
         WHERE job_id = ? AND attempts < ?
           AND (status = 'pending' OR (status = 'working' AND claimed_at < ?))
         RETURNING idx, image, attempts`,
      )
      .bind(
        new Date(now).toISOString(),
        jobId,
        MAX_ATTEMPTS,
        new Date(now - STALE_MS).toISOString(),
      )
      .all<{ idx: number; image: string; attempts: number }>()
  ).results;
  // Out of attempts while stuck: give up on those so the job can finish.
  await db
    .prepare(
      `UPDATE import_strips SET status = 'failed', image = NULL
       WHERE job_id = ? AND status = 'working' AND attempts >= ? AND claimed_at < ?`,
    )
    .bind(jobId, MAX_ATTEMPTS, new Date(now - STALE_MS).toISOString())
    .run();
  if (claimed.length === 0) return;
  const card = await isCardAccount(db, job.account_id);
  await Promise.all(
    claimed.map(async (s) => {
      if (fanout) {
        try {
          return await fanout(s.idx);
        } catch {
          // Couldn't hand it off: read it here instead.
        }
      }
      return readClaimed(env, jobId, s, card);
    }),
  );
}

// Reads one strip that's already claimed and saves the outcome.
export async function readClaimed(
  env: Env,
  jobId: number,
  s: { idx: number; image: string; attempts: number },
  card: boolean,
): Promise<void> {
  const db = env.DB;
  try {
    const rows = await readStrip(env, s.image, card);
    await db
      .prepare(
        `UPDATE import_strips SET status = 'done', rows = ?, image = NULL WHERE job_id = ? AND idx = ?`,
      )
      .bind(JSON.stringify(rows), jobId, s.idx)
      .run();
  } catch {
    const last = s.attempts >= MAX_ATTEMPTS;
    await db
      .prepare(
        `UPDATE import_strips SET status = ?, image = CASE WHEN ? THEN NULL ELSE image END WHERE job_id = ? AND idx = ?`,
      )
      .bind(last ? "failed" : "pending", last ? 1 : 0, jobId, s.idx)
      .run();
  }
}

// The strip endpoint's half: read a strip this job claimed for it.
export async function readOne(
  env: Env,
  jobId: number,
  idx: number,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT s.idx, s.image, s.attempts, j.account_id FROM import_strips s JOIN import_jobs j ON j.id = s.job_id
     WHERE s.job_id = ? AND s.idx = ? AND s.status = 'working' AND s.image IS NOT NULL`,
  )
    .bind(jobId, idx)
    .first<{
      idx: number;
      image: string;
      attempts: number;
      account_id: string;
    }>();
  if (!row) return;
  await readClaimed(
    env,
    jobId,
    row,
    await isCardAccount(env.DB, row.account_id),
  );
}

// Hands each strip to its own request on this same site.
export function selfFanout(env: Env, requestUrl: string, jobId: number) {
  const origin = new URL(requestUrl).origin;
  return async (idx: number) => {
    const res = await fetch(
      `${origin}/api/import/jobs/${jobId}/strips/${idx}`,
      {
        method: "POST",
        headers: serviceHeaders(env),
      },
    );
    if (!res.ok) throw new Error(`strip ${idx}: ${res.status}`);
  };
}

export interface JobStatus {
  id: number;
  account_id: string;
  total: number;
  done: number;
  failed: number[]; // 1-based strip numbers that couldn't be read
  finished: boolean;
  needs_work: boolean; // something is waiting or went stale
  strips: ReadRow[][] | null; // per strip, once finished
}

export async function jobStatus(
  db: D1Database,
  jobId: number,
): Promise<JobStatus | null> {
  const job = await db
    .prepare("SELECT id, account_id, total FROM import_jobs WHERE id = ?")
    .bind(jobId)
    .first<{ id: number; account_id: string; total: number }>();
  if (!job) return null;
  const strips = (
    await db
      .prepare(
        "SELECT idx, status, claimed_at, rows FROM import_strips WHERE job_id = ? ORDER BY idx",
      )
      .bind(jobId)
      .all<{
        idx: number;
        status: string;
        claimed_at: string | null;
        rows: string | null;
      }>()
  ).results;
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const done = strips.filter((s) => s.status === "done").length;
  const failed = strips
    .filter((s) => s.status === "failed")
    .map((s) => s.idx + 1);
  const finished = done + failed.length === job.total;
  return {
    id: job.id,
    account_id: job.account_id,
    total: job.total,
    done,
    failed,
    finished,
    needs_work: strips.some(
      (s) =>
        s.status === "pending" ||
        (s.status === "working" && (s.claimed_at ?? "") < staleBefore),
    ),
    strips: finished
      ? strips.map((s) => (s.rows ? (JSON.parse(s.rows) as ReadRow[]) : []))
      : null,
  };
}

export async function deleteJob(db: D1Database, jobId: number): Promise<void> {
  await db
    .prepare("DELETE FROM import_strips WHERE job_id = ?")
    .bind(jobId)
    .run();
  await db.prepare("DELETE FROM import_jobs WHERE id = ?").bind(jobId).run();
}
