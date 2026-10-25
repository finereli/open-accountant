-- The sample household, in the plain sentences the categorizer reads.
DELETE FROM rules;
INSERT INTO rules (text, sort, created_at, updated_at) VALUES
  ('Alex is a freelance designer. Clients (Brightline Studio, Acme Health, Northside Coffee) pay invoices into checking, and Stripe pays out template sales: all of it is Income.', 1, datetime('now'), datetime('now')),
  ('Alex lived in Lisbon until late July 2026 and in Mexico City since. Globe Wallet is Alex''s own multi-currency wallet, topped up from checking: those top-ups are Transfers.', 2, datetime('now'), datetime('now')),
  ('Money sent to Maria Costa (Lisbon) and Diego Hernández (Mexico City) is rent: Housing. Coworking spaces (Second Home, WeWork) are Business.', 3, datetime('now'), datetime('now')),
  ('SafetyWing is travel health insurance: Health. Ads on Facebook or Meta promote Alex''s work: Business.', 4, datetime('now'), datetime('now'));
