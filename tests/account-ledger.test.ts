// Category resolution in the account ledger view: same override -> alias ->
// price-gate logic as /api/spending, so the ledger and the spending view
// never disagree about what's categorized.

import { describe, it, expect } from 'vitest'
import { makeTestDb } from './d1'
import { ledgerTransactions } from '../functions/api/accounts/[id]/transactions'

describe('ledgerTransactions', () => {
  it('resolves category via override/alias, applies price gates, excludes transfers', async () => {
    const db = makeTestDb()
    db.exec(`
      INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
        ('wise-eur','alex','wise','wallet','EUR','Wise EUR',0,1);
      INSERT INTO categories (id, name, kind, sort) VALUES
        (1,'Food','expense',10), (2,'Coffee','expense',11);
      INSERT INTO merchants (id, household_name, created_at, category_id, small_category_id, small_max_cents) VALUES
        (10,'Lidl','2026-01-01',1,NULL,NULL),
        (11,'Minimarket','2026-01-01',1,2,500),
        (12,'No Category Yet','2026-01-01',NULL,NULL,NULL);
      INSERT INTO merchants (id, household_name, transfer_account_id, created_at) VALUES
        (13,NULL,'wise-eur','2026-01-01');
      INSERT INTO merchant_aliases (normalized_raw, merchant_id, confirmed, created_at) VALUES
        ('lidl',10,1,'2026-01-01'), ('minimarket',11,1,'2026-01-01'),
        ('mystery',12,1,'2026-01-01'), ('topup',13,1,'2026-01-01');
      INSERT INTO transactions (id, account_id, date, description, amount_cents, source_file, semantic_hash, merchant_key, merchant_override_id) VALUES
        (1,'wise-eur','2026-08-10','a',-2000,'t','h1','lidl',NULL),          -- Food
        (2,'wise-eur','2026-08-11','b',-300,'t','h2','minimarket',NULL),     -- under gate -> Coffee
        (3,'wise-eur','2026-08-12','c',-900,'t','h3','minimarket',NULL),     -- over gate -> Food
        (4,'wise-eur','2026-08-13','d',-500,'t','h4','mystery',NULL),        -- merchant has no category
        (5,'wise-eur','2026-08-14','e',-1000,'t','h5','topup',NULL),         -- transfer: not "uncategorized"
        (6,'wise-eur','2026-08-15','f',-700,'t','h6',NULL,NULL),             -- no merchant at all
        (7,'wise-eur','2026-08-16','g',-400,'t','h7','lidl',12);             -- override beats alias -> no category
    `)
    const rows = await ledgerTransactions(db, 'wise-eur')
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))

    expect(byId[1]).toMatchObject({ category_id: 1, category_name: 'Food', is_transfer: 0 })
    expect(byId[2]).toMatchObject({ category_id: 2, category_name: 'Coffee' })
    expect(byId[3]).toMatchObject({ category_id: 1, category_name: 'Food' })
    expect(byId[4]).toMatchObject({ category_id: null, category_name: null, is_transfer: 0 })
    expect(byId[5]).toMatchObject({ category_id: null, is_transfer: 1 })
    expect(byId[6]).toMatchObject({ category_id: null, merchant_id: null, is_transfer: 0 })
    expect(byId[7]).toMatchObject({ category_id: null, merchant_id: 12 }) // override wins over the aliased Lidl
  })
})
