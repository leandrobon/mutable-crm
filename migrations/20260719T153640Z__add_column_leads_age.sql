-- 20260719T153640Z__add_column_leads_age
-- Add an optional integer field "age" to "leads".

-- +up
ALTER TABLE leads ADD COLUMN age integer;

-- +down
ALTER TABLE leads DROP COLUMN age;
