# Accountant

A personal finance PWA built to be extended: trusted per-account ledgers
feeding a categorized spending view, a cash forecast, and a read-only MCP
server for agents. Svelte 5 + Vite + Cloudflare Pages Functions + D1 +
Workers AI. Money is integer minor units everywhere; dates are YYYY-MM-DD
strings. README.md has the setup steps and the reasoning behind the design.

## Commands

- `npm run check` - svelte-check (the typecheck; run before pushing)
- `npm test` - vitest; API query logic is tested against the real
  schema.sql via a node:sqlite-backed D1 shim (tests/d1.ts)
- `npm run build && npm run dev` - the app on http://localhost:8788 with a
  local D1 (`.dev.vars` sets DEV_AUTH_EMAIL so localhost needs no sign-in)
- `npm run db:local` / `npm run db:remote` - create the schema and seed
- `npm run sample` - load the sample household into the local DB (dev server running)
- `npm run ingest -- <dir>` - import bank CSVs described in ingest.config.json
- `npm run plaid:link` - link a bank through Plaid (setup, desktop)
- `npm run deploy` - build + deploy to Cloudflare Pages (production)
- `npx wrangler d1 execute accountant-db --remote --command "..."` - prod DB

## UI patterns

### Editing surfaces (the standard)

Every create/edit interaction opens the same surface, and there is exactly
one behavior for it:

- **Mobile**: a bottom sheet sliding up over a scrim - rounded top corners,
  `calc(var(--safe-bottom) + 18px)` bottom padding, capped at `80dvh` with
  internal scroll. Sheets whose main content is a picker/list also set
  `min-height: 50dvh` (a shorter sheet reads as "didn't finish sliding
  out"); short forms don't.
- **Desktop (≥768px)**: the same markup renders as a centered modal -
  `max-width: 520px`, pop-in animation instead of slide-up, and both the
  scrim and the panel are offset by `inset-inline-start: min(78vw, 300px)`
  to clear the persistent nav drawer.
- Scrim tap and Escape both close. No OK/Cancel pairs: mutations apply on
  their own buttons, closing is always safe.

The reusable shell is `src/ui/Sheet.svelte` (scrim + panel + animations;
content is a snippet). Every sheet uses it.

Never introduce a second modal/dialog style. If something feels too small
for a sheet, it's an inline expansion (see Spending's merchant drill-down);
if too big, it's a screen.

### Navigation

Three tiers: **top-level screens** (Dashboard, Spending, Settings) show the
hamburger and live in the drawer - main group for destinations, footer for
meta (Settings, Logout, styled like the entries); **sub-screens** (accounts,
Reconcile, Settings children like Categories and Sync) show a back arrow
whose handler pops history with an explicit fallback for cold deep links;
**editing** happens in sheets, never new screens. New management screens
become rows on the Settings hub.

### Other conventions

- Dates are entered with `src/ui/DateField.svelte` (yyyy-mm-dd, inline Cally
  calendar), never `<input type="date">` - Android's native picker fights
  the keyboard inside sheets.
- Toasts are error-only (`toasts.error`): success is shown by the UI
  changing, not by a pill. Optimistic updates revert on failure.
- Money in the Spending view: expenses plain with a minus, money-in gets a
  `+` and steel blue `#35679e` - no red/green, no brackets. Red stays
  reserved for genuine trouble (reconcile mismatches).
- Data mutations go through the API; the single ledger write path is
  `ingestRows` in `functions/api/_lib.ts` - never insert transactions
  another way.

## Access

- Cloudflare Access stands in front of the whole site. `functions/_owner.ts`
  verifies the Access JWT itself (team certs, AUD) and lets in only
  OWNER_EMAIL (comma-separated for a household) or the Access service token
  ACCESS_CLIENT_ID (the CLI, and the import job's requests to itself). On
  localhost, DEV_AUTH_EMAIL stands in. `tests/access.test.ts` pins all of this.
- The app has no sign-in screen: an expired Access session makes API calls
  redirect, and `src/lib/auth.svelte.ts` sends the browser through
  `/api/auth/check?next=...` so Access can sign in again.
- `/mcp` is a read-only MCP server (`functions/_mcp.ts` tools,
  `functions/_mcp-auth.ts` OAuth 2.1 + PKCE + dynamic registration). It and
  `/oauth/token`, `/oauth/register`, `/.well-known/*` bypass Access; the owner
  approves an agent on `/oauth/authorize`, which stays behind Access. Tools
  reuse the app's queries and `src/lib/forecast.ts` math, so agents see what
  the screens show; add a tool there when an agent needs a new view.
  Settings -> Agents lists and revokes clients.
- No setup screens and no secrets in the app: accounts are created with SQL
  (or by a sync), secrets are Pages secrets. Keep it that way.

## Data sources

Every source writes through `ingestRows` and dedups the same way
(account|date|amount + occurrence, never the description), so CSVs,
screenshots and feeds of the same account never double each other.

- CSV: `cli/ingest.ts` + `cli/formats.ts`, formats described as data in
  ingest.config.json. A new bank is a new format entry, not code.
- Wise: `functions/api/wise-sync.ts`, WISE_API_KEYS.
- Plaid: `functions/api/plaid/`, PLAID_* secrets; accounts match on
  `accounts.external_ref` (`plaid:<account_id>`), new ones are created.
- Screenshots: `functions/api/import/` reads bank-app screenshots with a
  vision model (Workers AI) - the fallback for banks with no usable export.

## Merchants and categories

Every transaction has a merchant and a category, decided independently.
The auto-categorizer (`functions/api/_classify.ts`, Qwen on Workers AI)
fills `auto_merchant_id`/`auto_category_id` per row from the whole row plus
what it knows about the household: the **rules** table (plain language,
Settings → Rules), category **descriptions**, merchant names in use, and
**corrections** logged whenever a person overrides a pick. People's
decisions live in separate columns and always win; the `tx_resolved` view
in `schema/schema.sql` is the one resolver - read merchant/category through
it, never re-derive them in a query. To improve accuracy, add a rule or a
description, not prompt code (bigger models scored the same; the limit is
information). 