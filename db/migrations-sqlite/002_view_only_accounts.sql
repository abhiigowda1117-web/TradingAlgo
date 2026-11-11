-- Accounts that can see the dashboard but not control the engine or place paper orders.
ALTER TABLE users ADD COLUMN can_control INTEGER NOT NULL DEFAULT 1;
