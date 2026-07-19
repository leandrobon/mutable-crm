-- 20260719T152053Z__add_column_leads_status
-- Add an optional text field "status" to "leads".

-- +up
ALTER TABLE leads ADD COLUMN status text;

-- +down
ALTER TABLE leads DROP COLUMN status;
