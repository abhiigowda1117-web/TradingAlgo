-- Accounts that can see the dashboard but not control the engine or place paper orders.
-- Existing accounts keep full control.
ALTER TABLE users ADD COLUMN can_control BOOLEAN NOT NULL DEFAULT TRUE;
