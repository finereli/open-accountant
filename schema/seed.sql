-- Starter categories. Everything here is meant to be edited on the
-- Categories screen: rename, merge, describe, reorder. The descriptions
-- matter more than the names - the auto-categorizer reads them on every
-- run, so "what belongs here, in plain words" is how you teach it.
--
-- kind: income sums at the top of Spending, expense in the body, excluded
--   shows but counts nowhere (money moving between your own accounts).
-- flow (the Forecast's view of the category):
--   run_rate      averages into a daily burn (food, transport)
--   subscriptions each merchant projects monthly at its usual day/amount
--   discrete      lumpy; plan these as expected items instead
--   off           ignored by the forecast (reimbursable, transfers)
--
-- Three names are load-bearing - keep them: Transfers, Debt Repay and Debt
-- Borrow (the Spending view and categorizer use them for money moving
-- between your own accounts and in/out of debt).

INSERT INTO categories (name, kind, flow, sort, description) VALUES
  ('Income',          'income',   'discrete',      0,   'Money received for work: salary, client payments, invoices paid, payouts from Stripe, PayPal or marketplaces, plus refunds and government benefits.'),
  ('Food',            'expense',  'run_rate',      10,  'Groceries, supermarkets, markets, bakeries, restaurants, cafes, bars, street food, food delivery.'),
  ('Housing',         'expense',  'run_rate',      20,  'Rent or mortgage, often a transfer to a landlord (a person); utilities, internet at home, home insurance.'),
  ('Transport',       'expense',  'run_rate',      30,  'Getting around day to day: fuel, parking, tolls, taxis and ride-hailing, buses and public transit, car rental.'),
  ('Travel',          'expense',  'run_rate',      40,  'Costs that exist only because of travel: hotels and short-stay lodging, travel insurance, travel eSIMs, visas.'),
  ('Flights',         'expense',  'discrete',      50,  'Airline tickets.'),
  ('Subscriptions',   'expense',  'subscriptions', 60,  'Personal RECURRING charges: streaming, apps, software, phone plans, cloud storage, memberships.'),
  ('Shopping',        'expense',  'discrete',      70,  'Physical goods: clothing, electronics, household items, marketplaces, sports gear.'),
  ('Online',          'expense',  'run_rate',      80,  'One-off digital purchases: apps, in-app and game purchases, ebooks, usage-billed online services.'),
  ('Health',          'expense',  'discrete',      90,  'Doctors, dentists, pharmacies, health insurance, therapy.'),
  ('Learning',        'expense',  'discrete',      100, 'Courses, coaching, books for learning, conferences.'),
  ('Business',        'expense',  'subscriptions', 110, 'Tools and services the work needs: business software, hosting, domains, accounting, coworking.'),
  ('Taxes',           'expense',  'discrete',      120, 'Income tax, sales tax and social contributions paid to any government.'),
  ('Fees',            'expense',  'run_rate',      130, 'Fees charged by banks and payment providers: account fees, transfer and conversion fees, ATM fees.'),
  ('Debt Cost',       'expense',  'discrete',      140, 'Interest and charges on credit cards, lines of credit and loans.'),
  ('Cash',            'expense',  'run_rate',      150, 'ATM cash withdrawals.'),
  ('Reimbursable',    'expense',  'off',           160, 'Expenses paid on behalf of a client or employer who pays them back.'),
  ('Debt Repay',      'excluded', 'off',           890, 'Paying down a credit card or line of credit from a cash account.'),
  ('Debt Borrow',     'excluded', 'off',           891, 'Drawing money from a line of credit, or a credit card cash advance, into a cash account.'),
  ('Transfers',       'excluded', 'off',           900, 'Money moving between the household''s own accounts, and currency conversions.');

-- A first rule, to show the shape. Rules are plain sentences about the
-- household the categorizer reads on every run (Settings -> Rules).
INSERT INTO rules (text, sort, created_at, updated_at) VALUES
  ('Describe the household here: who the account holders are, what they do for work, where they live, and anything unusual about how money moves.', 1, datetime('now'), datetime('now'));
