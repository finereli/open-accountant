// A minimal D1Database stand-in backed by node:sqlite, covering exactly the
// surface ingestRows/lastVerifiedDate use: prepare().bind().all()/first()/
// run() and batch(). Real schema, real SQL, no Workers runtime needed.

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

type Param = string | number | null

// D1 accepts numbered parameters (?1, ?2), but node:sqlite in some Node
// versions (23.7 at least) fails to bind them with "column index out of
// range". So numbered SQL is rewritten to named parameters (:p1, :p2) and
// bound by name. Plain `?` SQL passes through as-is.
function prepared(db: DatabaseSync, sql: string, params: Param[]) {
  if (!/\?\d/.test(sql)) return { stmt: db.prepare(sql), args: params }
  const named = sql.replace(/\?(\d+)/g, ':p$1')
  const args: Record<string, Param> = {}
  params.forEach((v, i) => (args[`p${i + 1}`] = v))
  return { stmt: db.prepare(named), args: [args] }
}

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: Param[] = []
  ) {}

  bind(...params: Param[]) {
    return new Stmt(this.db, this.sql, params)
  }

  private p() {
    return prepared(this.db, this.sql, this.params)
  }

  async all() {
    const { stmt, args } = this.p()
    return { results: stmt.all(...(args as Param[])) }
  }

  async first() {
    const { stmt, args } = this.p()
    return stmt.get(...(args as Param[])) ?? null
  }

  async run() {
    const { stmt, args } = this.p()
    const info = stmt.run(...(args as Param[]))
    return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }
  }
}

export function makeTestDb() {
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../schema/schema.sql'), 'utf8')
  db.exec(schema)
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database & { exec: (sql: string) => void }
}
