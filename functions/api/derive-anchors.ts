// POST /api/derive-anchors - solve for starting balances from the bank's own
// balance column, where the source carries one (many bank CSVs and Wise do).
//
// For the true chronologically-last transaction of a day D,
//   balance_after = anchor + sum(all amounts on dates <= D)
// so every day with balance data yields one correct candidate
//   anchor = balance_after - endOfDaySum
// (plus noise candidates from intra-day rows, whose CSV order we don't trust).
// The candidate that recurs across the most days is the anchor; the number of
// days it explains is a completeness check - if a day's balances can't be
// explained by the winning anchor, transactions are missing around that day.
//
// Accounts with a reconciliation checkpoint are skipped: their anchor is
// vouched for by a human and locked. Pass { dry_run: true } to preview.

import type { Env } from './_lib'
import { json, error, lastCheckpointDate } from './_lib'

interface Row {
  date: string
  amount_cents: number
  balance_after_cents: number | null
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  let dryRun = false
  let force = false
  try {
    const body = (await request.json()) as { dry_run?: boolean; force?: boolean }
    dryRun = body.dry_run === true
    force = body.force === true
  } catch {
    // empty body is fine
  }

  const db = env.DB
  const accounts = (
    await db
      .prepare(
        `SELECT DISTINCT account_id FROM transactions WHERE balance_after_cents IS NOT NULL`
      )
      .all()
  ).results as Array<{ account_id: string }>

  const report: Array<Record<string, unknown>> = []

  for (const { account_id } of accounts) {
    if (await lastCheckpointDate(db, account_id)) {
      report.push({ account_id, status: 'skipped: checkpointed (anchor locked)' })
      continue
    }

    // The anchor is the balance at the start of its date, so only rows from
    // that date on count. No anchor yet: it starts at the first row.
    const current = await db
      .prepare('SELECT date, balance_cents, source FROM ledger_anchors WHERE account_id = ?')
      .bind(account_id)
      .first<{ date: string; balance_cents: number; source: string | null }>()
    const rows = (
      await db
        .prepare(
          `SELECT date, amount_cents, balance_after_cents FROM transactions
           WHERE account_id = ?1 AND date >= ?2 ORDER BY date ASC, id ASC`
        )
        .bind(account_id, current?.date ?? '0000-01-01')
        .all()
    ).results as unknown as Row[]
    if (rows.length === 0) continue

    // Sum of amounts through the END of each date.
    const endOfDaySum = new Map<string, number>()
    let cum = 0
    for (const r of rows) {
      cum += r.amount_cents
      endOfDaySum.set(r.date, cum) // last write per date wins = end of day
    }

    // One vote per (candidate, day): the true last row of a day votes for the
    // real anchor; intra-day rows vote for junk values that don't recur.
    const votes = new Map<number, Set<string>>()
    for (const r of rows) {
      if (r.balance_after_cents === null) continue
      const candidate = r.balance_after_cents - endOfDaySum.get(r.date)!
      if (!votes.has(candidate)) votes.set(candidate, new Set())
      votes.get(candidate)!.add(r.date)
    }

    const daysWithBalance = new Set(
      rows.filter((r) => r.balance_after_cents !== null).map((r) => r.date)
    ).size
    let best: { anchor: number; days: number } | null = null
    for (const [anchor, days] of votes) {
      if (!best || days.size > best.days) best = { anchor, days: days.size }
    }
    if (!best) continue


    const entry: Record<string, unknown> = {
      account_id,
      derived_anchor_cents: best.anchor,
      days_explained: best.days,
      days_with_balance_data: daysWithBalance,
      complete: best.days === daysWithBalance,
      previous_anchor_cents: current?.balance_cents ?? null,
      previous_source: current?.source ?? null,
    }

    // A deliberately-set anchor that disagrees is a finding, not a thing to
    // overwrite: either the old anchor was wrong or transactions are
    // missing/duplicated. Surface it; force=true overrides.
    const conflict =
      current?.source != null && current.balance_cents !== best.anchor && !force

    if (dryRun) {
      entry.status = 'dry run'
    } else if (conflict) {
      entry.status = `conflict: anchor was set (${current!.source}) and differs; investigate or pass force:true`
    } else {
      await db
        .prepare(
          `INSERT INTO ledger_anchors (account_id, date, balance_cents, source)
           VALUES (?, ?, ?, 'derived')
           ON CONFLICT(account_id) DO UPDATE
             SET balance_cents = excluded.balance_cents, source = 'derived'`
        )
        .bind(account_id, current?.date ?? rows[0].date, best.anchor)
        .run()
      entry.status = 'anchor set'
    }
    report.push(entry)
  }

  if (report.length === 0) return error('No accounts with balance data found', 404)
  return json({ report })
}
