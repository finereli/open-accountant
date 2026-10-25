// CSV ingest CLI. Scans a directory, matches each CSV to the formats in
// ingest.config.json (by file name, confirmed by the header row), and pushes
// the rows to the Accountant API, where dedup and lock enforcement live.
//
//   npm run ingest -- [dir] [options]
//
//   dir                     directory of CSVs (default ~/Downloads)
//   --config FILE           formats file (default ./ingest.config.json)
//   --api URL               API base (default: "api" in the config file)
//   --local                 shorthand for --api http://localhost:8788
//   --since YYYY-MM-DD      ignore rows before this date
//   --dry-run               parse and report, push nothing
//
// Getting through Cloudflare Access: the CLI sends the service token from
// ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET (environment, or .dev.vars). The
// local dev server needs neither.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { parseCsv } from './csv'
import { matchesFile, parseWithFormat, type CsvFormat } from './formats'
import type { IngestRow, IngestResponse } from '../src/lib/types'

// --- args ---------------------------------------------------------------

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['api', 'config', 'since'])
const flags = new Map<string, string>()
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const name = a.slice(2)
    if (VALUE_FLAGS.has(name)) flags.set(name, argv[++i])
    else flags.set(name, '')
  } else {
    positional.push(a)
  }
}
const flag = (name: string) => flags.get(name)
const has = (name: string) => flags.has(name)

const root = join(import.meta.dirname, '..')
const configPath = flag('config') ?? join(root, 'ingest.config.json')
if (!existsSync(configPath)) {
  console.error(`No ${configPath}. Copy ingest.config.example.json and describe your bank's CSVs (see README).`)
  process.exit(1)
}
const config = JSON.parse(readFileSync(configPath, 'utf8')) as { api?: string; formats: CsvFormat[] }

const dir = positional[0] ?? join(homedir(), 'Downloads')
const api = has('local') ? 'http://localhost:8788' : (flag('api') ?? config.api)
const since = flag('since') ?? '0000-01-01'
const dryRun = has('dry-run')
if (!api && !dryRun) {
  console.error('No API. Set "api" in the config, or pass --api URL or --local.')
  process.exit(1)
}

// Service token: environment first, then the local .dev.vars.
function secret(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  const devVars = join(root, '.dev.vars')
  if (!existsSync(devVars)) return undefined
  return readFileSync(devVars, 'utf8').match(new RegExp(`^${name}=["']?([^"'\\s]+)`, 'm'))?.[1]
}
const authHeaders: Record<string, string> = {}
const clientId = secret('ACCESS_CLIENT_ID')
const clientSecret = secret('ACCESS_CLIENT_SECRET')
if (clientId && clientSecret) {
  authHeaders['CF-Access-Client-Id'] = clientId
  authHeaders['CF-Access-Client-Secret'] = clientSecret
}

// --- match + parse ------------------------------------------------------

interface FileReport {
  file: string
  kind: string
  rows: number
  skipped: Record<string, number>
  error?: string
}

const reports: FileReport[] = []
const allRows: IngestRow[] = []

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'))
for (const file of files.sort()) {
  const name = basename(file)
  // Every matching format reads the file: a multi-currency export can feed
  // one account per currency, each format keeping its rows with "only".
  const formats = config.formats.filter((f) => matchesFile(f, name))
  // Not ours - stay quiet about the rest of the downloads folder.
  if (formats.length === 0) continue
  const text = readFileSync(join(dir, file), 'utf8')
  for (const format of formats) {
    try {
      const res = parseWithFormat(text, format, name, since)
      reports.push({ file, kind: `${format.name} -> ${format.account}`, rows: res.rows.length, skipped: res.skipped })
      allRows.push(...res.rows)
    } catch (e) {
      reports.push({ file, kind: format.name, rows: 0, skipped: {}, error: e instanceof Error ? e.message : String(e) })
    }
  }
}

// Cross-file dedup before pushing: overlapping downloads carry the same rows.
const seen = new Set<string>()
const unique: IngestRow[] = []
let crossFileDupes = 0
for (const r of allRows) {
  const key = `${r.account_id}|${r.semantic_hash}`
  if (seen.has(key)) crossFileDupes++
  else {
    seen.add(key)
    unique.push(r)
  }
}

// --- report + push ------------------------------------------------------

console.log(`\nScanned ${dir} (${files.length} CSVs, ${reports.length} matched a format)\n`)
for (const r of reports) {
  const sk = Object.entries(r.skipped)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
  console.log(`  ${r.file}`)
  console.log(`     ${r.error ?? `${r.kind}: ${r.rows} rows${sk ? ` (skipped: ${sk})` : ''}`}`)
}
console.log(`\n  ${allRows.length} rows parsed, ${crossFileDupes} cross-file duplicates, ${unique.length} to push`)

if (dryRun) {
  console.log('\nDry run - nothing pushed.')
  process.exit(0)
}
if (unique.length === 0) {
  console.log('\nNothing to push.')
  process.exit(0)
}

const CHUNK = 500
let inserted = 0
let duplicates = 0
const flagged: IngestResponse['flagged'] = []
const unknown = new Set<string>()

for (let i = 0; i < unique.length; i += CHUNK) {
  const chunk = unique.slice(i, i + CHUNK)
  const res = await fetch(`${api}/api/ingest`, {
    method: 'POST',
    redirect: 'manual', // an Access login redirect means the service token is missing or wrong
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ rows: chunk }),
  })
  if (!res.ok) {
    const hint = res.status >= 300 && res.status < 400 ? ' - Cloudflare Access sent a login page: check ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET' : ''
    console.error(`\nPush failed (${res.status})${hint}: ${(await res.text()).slice(0, 300)}`)
    process.exit(1)
  }
  const out = (await res.json()) as IngestResponse
  inserted += out.inserted
  duplicates += out.duplicates
  flagged.push(...out.flagged)
  out.unknown_accounts.forEach((a) => unknown.add(a))
  process.stdout.write(`  pushed ${Math.min(i + CHUNK, unique.length)}/${unique.length}\r`)
}

console.log(`\n\nDone against ${api}`)
console.log(`  inserted:   ${inserted}`)
console.log(`  duplicates: ${duplicates} (already in the ledger)`)
if (unknown.size) console.log(`  unknown accounts (rows dropped - create them first): ${[...unknown].join(', ')}`)
if (flagged.length) {
  console.log(`  FLAGGED (${flagged.length} rows dated inside a reconciled period - NOT inserted):`)
  for (const f of flagged) console.log(`    ${f.account_id} ${f.date} ${(f.amount_cents / 100).toFixed(2)} ${f.description}`)
}
