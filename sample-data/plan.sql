-- The sample household's plan: expected money and the fun allowance.
DELETE FROM expected_items; DELETE FROM plan_items; DELETE FROM allowance_months;
INSERT INTO expected_items (name, kind, amount_cents, currency, day_of_month, date, account_id, created_at) VALUES
  ('Brightline Studio retainer', 'income', 250000, 'USD', 15, NULL, 'checking', datetime('now')),
  ('Template sales (Stripe)', 'income', 90000, 'USD', 28, NULL, 'checking', datetime('now')),
  ('Estimated tax, Q4', 'expense', 190000, 'USD', NULL, '2027-01-15', 'checking', datetime('now'));
INSERT INTO allowance_months (month, amount_cents, currency) VALUES ('default', 30000, 'USD');
INSERT INTO plan_items (month, name, amount_cents, currency, date, active, created_at) VALUES
  ('2026-11', 'Day trip to Teotihuacán', 120000, 'MXN', '2026-11-08', 1, datetime('now')),
  ('2026-12', 'Lucha libre tickets', 90000, 'MXN', NULL, 1, datetime('now'));
