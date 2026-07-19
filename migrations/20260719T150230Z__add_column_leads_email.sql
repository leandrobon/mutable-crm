-- 20260719T150230Z__add_column_leads_email
-- Add an optional text field "email" to "leads".

-- +up
ALTER TABLE leads ADD COLUMN email text;

-- +down
ALTER TABLE leads DROP COLUMN email;
