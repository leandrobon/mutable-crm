-- 20260719T155055Z__add_column_contacts_notes
-- Add an optional text field "notes" to "contacts".

-- +up
ALTER TABLE contacts ADD COLUMN notes text;

-- +down
ALTER TABLE contacts DROP COLUMN notes;
