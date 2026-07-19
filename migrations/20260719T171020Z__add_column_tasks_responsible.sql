-- 20260719T171020Z__add_column_tasks_responsible
-- Add an optional text field "responsible" to "tasks".

-- +up
ALTER TABLE tasks ADD COLUMN responsible text;

-- +down
ALTER TABLE tasks DROP COLUMN responsible;
