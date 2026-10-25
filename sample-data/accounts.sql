-- The sample household's accounts, each ledger starting on 2026-04-01.
INSERT INTO accounts (id, owner, institution, kind, currency, display_name, sort, in_spending) VALUES
  ('checking',   'Alex', 'Northwind Bank', 'checking',    'USD', 'Everyday Checking', 1, 1),
  ('visa',       'Alex', 'Northwind Bank', 'credit_card', 'USD', 'Northwind Visa',    2, 1),
  ('wallet-eur', 'Alex', 'Globe Wallet',   'wallet',      'EUR', 'Wallet EUR',        3, 1),
  ('wallet-mxn', 'Alex', 'Globe Wallet',   'wallet',      'MXN', 'Wallet MXN',        4, 1);
INSERT INTO ledger_anchors (account_id, date, balance_cents, source) VALUES
  ('checking',   '2026-04-01', 820000, 'manual'),
  ('visa',       '2026-04-01', -41230, 'manual'),
  ('wallet-eur', '2026-04-01', 186000, 'manual'),
  ('wallet-mxn', '2026-04-01', 0, 'manual');
