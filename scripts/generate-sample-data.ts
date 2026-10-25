// Sample data: six months of a fictional household, as the CSV exports
// three kinds of institution would produce. Deterministic - the same seed
// writes the same files, so screenshots and docs stay reproducible.
//
//   npx tsx scripts/generate-sample-data.ts
//
// Alex is a freelance designer paid in USD by a handful of clients (uneven
// invoices plus Stripe payouts), living in Lisbon from April to July and in
// Mexico City from August. Day-to-day spending runs through a multi-currency
// wallet (EUR, then MXN) topped up from US checking; software, flights and
// ads go on the Visa. Amounts and frequencies are modelled on a real
// household's exports; every name, merchant and number here is invented.
//
// Writes sample-data/: three CSVs, accounts.sql, rules.sql and ingest.config.json.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'sample-data')
const START = '2026-04-01'
const END = '2026-10-20'

// --- deterministic randomness -------------------------------------------

let seed = 20261025
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
const cents = (lo: number, hi: number) => Math.round(between(lo, hi) * 100)
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
const chance = (p: number) => rand() < p

// --- calendar -----------------------------------------------------------

const days: string[] = []
for (let d = new Date(START + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= END; d.setUTCDate(d.getUTCDate() + 1))
  days.push(d.toISOString().slice(0, 10))
const dom = (d: string) => Number(d.slice(8, 10))
const month = (d: string) => d.slice(0, 7)
const inLisbon = (d: string) => d < '2026-07-28'
const shift = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z')
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}

interface Row {
  date: string
  description: string
  cents: number // signed: + is money in
  pending?: boolean
}

const checking: Row[] = []
const visa: Row[] = []
const wallet: Array<Row & { currency: 'EUR' | 'MXN' }> = []

const FX = { EUR: 0.924, MXN: 18.4 } // per USD

// --- income: uneven, several sources -------------------------------------

const CLIENTS = [
  { name: 'ACH CREDIT BRIGHTLINE STUDIO INV', lo: 1800, hi: 3200, p: 0.04 },
  { name: 'WIRE IN ACME HEALTH INC', lo: 3500, hi: 5200, p: 0.018 },
  { name: 'ACH CREDIT NORTHSIDE COFFEE CO', lo: 600, hi: 1100, p: 0.035 },
]
for (const d of days) {
  for (const c of CLIENTS) if (chance(c.p)) checking.push({ date: d, description: `${c.name} ${Math.floor(between(1000, 9999))}`, cents: cents(c.lo, c.hi) })
  // Stripe pays out small template sales most weeks.
  if (new Date(d).getUTCDay() === 2 && chance(0.7)) checking.push({ date: d, description: 'STRIPE TRANSFER ST-' + Math.floor(between(100000, 999999)), cents: cents(60, 480) })
}

// --- checking: fixed outflows, transfers, taxes ---------------------------

for (const d of days) {
  if (dom(d) === 1) checking.push({ date: d, description: 'SAFETYWING NOMAD INSURANCE', cents: -5600 })
  if (dom(d) === 3) checking.push({ date: d, description: 'GOOGLE *FI MOBILE G.CO/HELPPAY#', cents: -cents(35, 42) })
  if (dom(d) === 28 && chance(0.6)) checking.push({ date: d, description: 'MONTHLY MAINTENANCE FEE', cents: -1200 })
  if (d === '2026-06-15' || d === '2026-09-15') checking.push({ date: d, description: 'IRS USATAXPYMT ESTIMATED TAX', cents: -cents(1700, 2100) })
}

// Wallet top-ups: USD leaves checking, local currency lands a day later.
function topUp(d: string, usd: number, cur: 'EUR' | 'MXN') {
  checking.push({ date: d, description: 'ONLINE TRANSFER TO GLOBE WALLET', cents: -usd * 100 })
  const local = Math.round(usd * FX[cur] * between(0.995, 1.0) * 100)
  wallet.push({ date: shift(d, 1), currency: cur, description: `Topped up account with ${usd.toFixed(2)} USD`, cents: local })
}
for (const d of ['2026-04-02', '2026-04-24', '2026-05-15', '2026-06-05', '2026-06-26', '2026-07-10']) topUp(d, 1500, 'EUR')
// Before the move: money waiting in pesos for the first rent.
for (const d of ['2026-07-24', '2026-08-18', '2026-09-08', '2026-09-29', '2026-10-14']) topUp(d, d === '2026-07-24' ? 2500 : 1500, 'MXN')

// --- the Visa: software, online, flights, ads ----------------------------

const SUBS = [
  { name: 'FIGMA MONTHLY SAN FRANCISCO CA', day: 4, lo: 15, hi: 15 },
  { name: 'ADOBE *CREATIVE CLOUD 800-833-6687', day: 6, lo: 59.99, hi: 59.99 },
  { name: 'GITHUB, INC. GITHUB.COM', day: 8, lo: 4, hi: 4 },
  { name: 'NOTION LABS, INC.', day: 9, lo: 10, hi: 10 },
  { name: 'GOOGLE *WORKSPACE_ALEXRIV', day: 11, lo: 14, hi: 14 },
  { name: 'NETFLIX.COM', day: 14, lo: 15.49, hi: 15.49 },
  { name: 'SPOTIFY P2A91C3E', day: 17, lo: 11.99, hi: 11.99 },
  { name: 'CLAUDE.AI SUBSCRIPTION', day: 19, lo: 20, hi: 20 },
  { name: 'DROPBOX*7H2KQ', day: 22, lo: 11.99, hi: 11.99 },
]
for (const d of days) {
  for (const s of SUBS) if (dom(d) === s.day) visa.push({ date: d, description: s.name, cents: -cents(s.lo, s.hi) })
  if (dom(d) === 2) visa.push({ date: d, description: 'AWS EMEA aws.amazon.co', cents: -cents(8, 26) })
  if (dom(d) === 5) visa.push({ date: d, description: 'OPENAI *API USAGE', cents: -cents(3, 41) })
  if (chance(0.05)) visa.push({ date: d, description: pick(['AMAZON.COM*2K4LP', 'AMAZON.COM*7Q81Z', 'AMAZON MKTPL*RT5Y0']), cents: -cents(9, 120) })
  if (chance(0.03)) visa.push({ date: d, description: 'TEMU.COM', cents: -cents(4, 38) })
  if (chance(0.025)) visa.push({ date: d, description: 'FACEBK *ADS 7X2LMQ', cents: -cents(60, 210) })
  if (dom(d) === 24) visa.push({ date: d, description: 'INTEREST CHARGE ON PURCHASES', cents: -cents(9, 24) })
}
visa.push({ date: '2026-06-30', description: 'TAP AIR PORTUGAL LISBOA', cents: -98240 })
visa.push({ date: '2026-07-02', description: 'BOOKING.COM HOTEL AMSTERDAM', cents: -31890 })
visa.push({ date: '2026-07-29', description: 'AEROMEXICO MEXICO CITY', cents: -41250 })
visa.push({ date: '2026-09-12', description: 'DISCOVERCARS.COM', cents: -17861 })
visa.push({ date: '2026-09-13', description: 'PEMEX GASOLINERA OAXACA', cents: -cents(38, 52) })
visa.push({ date: '2026-10-02', description: 'AIRBNB * HMZK4TQX', cents: -cents(240, 290) })

// Paying off the card from checking: about the last month's charges, on the 20th.
for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
  const d = `${m}-20`
  const owed = -visa.filter((r) => r.date < d && r.date >= shift(d, -31) && r.cents < 0).reduce((s, r) => s + r.cents, 0)
  const pay = Math.round(owed / 100) * 100
  if (pay <= 0) continue
  checking.push({ date: d, description: 'ONLINE PAYMENT TO NORTHWIND VISA', cents: -pay })
  visa.push({ date: shift(d, 1), description: 'PAYMENT - THANK YOU', cents: pay })
}
// The last few days haven't posted yet.
for (const r of visa) if (r.date > '2026-10-16' && r.cents < 0) r.pending = true

// --- the wallet: daily life in two currencies ----------------------------

const LISBON = {
  groceries: ['Pingo Doce Alvalade', 'Continente Bom Dia Arroios', 'Mercado de Campo de Ourique', 'Lidl Avenidas Novas'],
  bakery: ['Padaria Portuguesa', 'Pastelaria Versailles', 'Manteigaria Chiado'],
  cafe: ['Fabrica Coffee Roasters', 'Copenhagen Coffee Lab', 'Hello Kristof'],
  restaurant: ['Taberna da Rua das Flores', 'Cervejaria Ramiro', 'O Velho Eurico', 'Tasca do Chico', 'Time Out Market Lisboa'],
  transport: ['Uber *Trip Lisboa', 'Bolt.eu/o/2604', 'Metropolitano de Lisboa'],
}
const CDMX = {
  groceries: ['Walmart Superama Condesa', 'Mercado Medellín', 'La Comer Roma', 'Oxxo Álvaro Obregón'],
  bakery: ['Panadería Rosetta', 'Pastelería Ideal'],
  cafe: ['Café Avellaneda', 'Quentin Café', 'Blend Station'],
  restaurant: ['Taquería Orinoco', 'El Califa de León', 'Contramar', 'Fonda Fina', 'Por Siempre Vegana Taquería'],
  transport: ['Uber *Trip Ciudad de Mexico', 'DiDi Rides', 'Metro CDMX recarga'],
}

for (const d of days) {
  if (inLisbon(d)) {
    const eur = (lo: number, hi: number) => -cents(lo, hi)
    if (chance(0.32)) wallet.push({ date: d, currency: 'EUR', description: `Card transaction of ${pick(LISBON.groceries)}`, cents: eur(8, 46) })
    if (chance(0.35)) wallet.push({ date: d, currency: 'EUR', description: pick(LISBON.bakery), cents: eur(1.6, 7.5) })
    if (chance(0.4)) wallet.push({ date: d, currency: 'EUR', description: pick(LISBON.cafe), cents: eur(2.8, 9) })
    if (chance(0.22)) wallet.push({ date: d, currency: 'EUR', description: pick(LISBON.restaurant), cents: eur(12, 48) })
    if (chance(0.3)) wallet.push({ date: d, currency: 'EUR', description: pick(LISBON.transport), cents: eur(1.8, 14) })
    if (dom(d) === 1) wallet.push({ date: d, currency: 'EUR', description: 'Sent money to Maria Costa with reference renda', cents: -115000 })
    if (dom(d) === 2) wallet.push({ date: d, currency: 'EUR', description: 'Second Home Lisboa coworking', cents: -22000 })
    if (dom(d) === 10) wallet.push({ date: d, currency: 'EUR', description: 'EDP Comercial', cents: eur(38, 61) })
    if (dom(d) === 12) wallet.push({ date: d, currency: 'EUR', description: 'Navegante passe mensal', cents: -4000 })
    if (chance(0.035)) wallet.push({ date: d, currency: 'EUR', description: 'ATM withdrawal Millennium BCP', cents: -pick([6000, 8000, 10000]) })
    if (chance(0.03)) wallet.push({ date: d, currency: 'EUR', description: 'Farmácia Estácio', cents: eur(5, 32) })
  } else {
    const mxn = (lo: number, hi: number) => -cents(lo, hi)
    if (chance(0.34)) wallet.push({ date: d, currency: 'MXN', description: `Card transaction of ${pick(CDMX.groceries)}`, cents: mxn(45, 1150) })
    if (chance(0.3)) wallet.push({ date: d, currency: 'MXN', description: pick(CDMX.bakery), cents: mxn(30, 140) })
    if (chance(0.42)) wallet.push({ date: d, currency: 'MXN', description: pick(CDMX.cafe), cents: mxn(55, 130) })
    if (chance(0.26)) wallet.push({ date: d, currency: 'MXN', description: pick(CDMX.restaurant), cents: mxn(90, 780) })
    if (chance(0.32)) wallet.push({ date: d, currency: 'MXN', description: pick(CDMX.transport), cents: mxn(5, 190) })
    if (dom(d) === 1 && d > '2026-08-01') wallet.push({ date: d, currency: 'MXN', description: 'Sent money to Diego Hernández with reference renta', cents: -2200000 })
    if (dom(d) === 3) wallet.push({ date: d, currency: 'MXN', description: 'WeWork Reforma 222', cents: -350000 })
    if (dom(d) === 7) wallet.push({ date: d, currency: 'MXN', description: 'Telcel recarga', cents: -20000 })
    if (chance(0.04)) wallet.push({ date: d, currency: 'MXN', description: 'Cajero BBVA retiro', cents: -pick([100000, 150000, 200000]) })
    if (chance(0.03)) wallet.push({ date: d, currency: 'MXN', description: 'Farmacia del Ahorro', cents: mxn(60, 480) })
  }
}
// First rent in Mexico City went out with the August top-up.
wallet.push({ date: '2026-07-31', currency: 'MXN', description: 'Sent money to Diego Hernández with reference renta', cents: -2200000 })

// --- write ---------------------------------------------------------------

const byDate = (a: Row, b: Row) => a.date.localeCompare(b.date)
const money = (c: number) => (c / 100).toFixed(2)
const usDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
const euDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

const OPEN = { checking: 820000, visa: -41230, EUR: 186000, MXN: 0 }

mkdirSync(OUT, { recursive: true })

// Checking: US-style dates, one signed amount, running balance; newest first
// like most bank downloads.
{
  let bal = OPEN.checking
  const rows = checking.sort(byDate).map((r) => {
    bal += r.cents
    return `${usDate(r.date)},${q(r.description)},${money(r.cents)},${money(bal)}`
  })
  writeFileSync(join(OUT, 'northwind-checking-2026.csv'), ['Posting Date,Description,Amount,Balance', ...rows.reverse()].join('\n') + '\n')
}

// Visa: debit and credit columns, a status, and pending rows on top.
{
  const rows = visa.sort(byDate).map((r) =>
    [usDate(r.date), q(r.description), r.pending ? 'Pending' : 'Posted', r.cents < 0 ? money(-r.cents) : '', r.cents > 0 ? money(r.cents) : ''].join(',')
  )
  writeFileSync(join(OUT, 'northwind-visa-2026.csv'), ['Transaction Date,Description,Status,Debit,Credit', ...rows.reverse()].join('\n') + '\n')
}

// Wallet: one file for every currency, European dates, oldest first.
{
  const bal: Record<string, number> = { EUR: OPEN.EUR, MXN: OPEN.MXN }
  const rows = wallet.sort(byDate).map((r) => {
    bal[r.currency] += r.cents
    if (bal[r.currency] < 0) throw new Error(`wallet ${r.currency} went negative on ${r.date}`)
    return `${euDate(r.date)},${r.currency},${q(r.description)},${money(r.cents)},${money(bal[r.currency])}`
  })
  writeFileSync(join(OUT, 'globe-wallet-statement.csv'), ['Date,Currency,Description,Amount,Running Balance', ...rows].join('\n') + '\n')
}

writeFileSync(
  join(OUT, 'accounts.sql'),
  `-- The sample household's accounts, each ledger starting on ${START}.
INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
  ('checking',   'Alex', 'Northwind Bank', 'checking',    'USD', 'Everyday Checking', 1, 1),
  ('visa',       'Alex', 'Northwind Bank', 'credit_card', 'USD', 'Northwind Visa',    2, 1),
  ('wallet-eur', 'Alex', 'Globe Wallet',   'wallet',      'EUR', 'Wallet EUR',        3, 1),
  ('wallet-mxn', 'Alex', 'Globe Wallet',   'wallet',      'MXN', 'Wallet MXN',        4, 1);
INSERT INTO ledger_anchors (account_id, date, balance_cents, source) VALUES
  ('checking',   '${START}', ${OPEN.checking}, 'manual'),
  ('visa',       '${START}', ${OPEN.visa}, 'manual'),
  ('wallet-eur', '${START}', ${OPEN.EUR}, 'manual'),
  ('wallet-mxn', '${START}', ${OPEN.MXN}, 'manual');
`
)

// What the categorizer should know about this household - the Rules screen.
writeFileSync(
  join(OUT, 'rules.sql'),
  `-- The sample household, in the plain sentences the categorizer reads.
DELETE FROM rules;
INSERT INTO rules (text, sort, created_at, updated_at) VALUES
  ('Alex is a freelance designer. Clients (Brightline Studio, Acme Health, Northside Coffee) pay invoices into checking, and Stripe pays out template sales: all of it is Income.', 1, datetime('now'), datetime('now')),
  ('Alex lived in Lisbon until late July 2026 and in Mexico City since. Globe Wallet is Alex''s own multi-currency wallet, topped up from checking: those top-ups are Transfers.', 2, datetime('now'), datetime('now')),
  ('Money sent to Maria Costa (Lisbon) and Diego Hernández (Mexico City) is rent: Housing. Coworking spaces (Second Home, WeWork) are Business.', 3, datetime('now'), datetime('now')),
  ('SafetyWing is travel health insurance: Health. Ads on Facebook or Meta promote Alex''s work: Business.', 4, datetime('now'), datetime('now'));
`
)

// The plan: what Alex expects to come and go, and a monthly fun allowance.
writeFileSync(
  join(OUT, 'plan.sql'),
  `-- The sample household's plan: expected money and the fun allowance.
DELETE FROM expected_items; DELETE FROM plan_items; DELETE FROM allowance_months;
INSERT INTO expected_items (name, kind, amount_cents, currency, day_of_month, date, account_id, created_at) VALUES
  ('Brightline Studio retainer', 'income', 250000, 'USD', 15, NULL, 'checking', datetime('now')),
  ('Template sales (Stripe)', 'income', 90000, 'USD', 28, NULL, 'checking', datetime('now')),
  ('Estimated tax, Q4', 'expense', 190000, 'USD', NULL, '2027-01-15', 'checking', datetime('now'));
INSERT INTO allowance_months (month, amount_cents, currency) VALUES ('default', 30000, 'USD');
INSERT INTO plan_items (month, name, amount_cents, currency, date, active, created_at) VALUES
  ('2026-11', 'Day trip to Teotihuacán', 120000, 'MXN', '2026-11-08', 1, datetime('now')),
  ('2026-12', 'Lucha libre tickets', 90000, 'MXN', NULL, 1, datetime('now'));
`
)

writeFileSync(
  join(OUT, 'ingest.config.json'),
  JSON.stringify(
    {
      api: 'http://localhost:8788',
      formats: [
        {
          name: 'northwind checking',
          file: '^northwind-checking.*\\.csv$',
          account: 'checking',
          header: ['Posting Date', 'Description', 'Amount', 'Balance'],
          date: { column: 'Posting Date', format: 'MM/DD/YYYY' },
          description: 'Description',
          amount: 'Amount',
          balance: 'Balance',
        },
        {
          name: 'northwind visa',
          file: '^northwind-visa.*\\.csv$',
          account: 'visa',
          date: { column: 'Transaction Date', format: 'MM/DD/YYYY' },
          description: 'Description',
          debit: 'Debit',
          credit: 'Credit',
          only: { column: 'Status', equals: 'Posted' },
        },
        ...(['EUR', 'MXN'] as const).map((c) => ({
          name: `globe wallet ${c}`,
          file: '^globe-wallet.*\\.csv$',
          account: `wallet-${c.toLowerCase()}`,
          date: { column: 'Date', format: 'DD/MM/YYYY' },
          description: 'Description',
          amount: 'Amount',
          balance: 'Running Balance',
          only: { column: 'Currency', equals: c },
        })),
      ],
    },
    null,
    2
  ) + '\n'
)

console.log(`checking ${checking.length} rows, visa ${visa.length}, wallet ${wallet.length} -> ${OUT}`)
