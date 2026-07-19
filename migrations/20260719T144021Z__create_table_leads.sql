-- 20260719T144021Z__create_table_leads
-- Create a table "leads" with 3 fields: phone_number, name, state.

-- +up
CREATE TABLE leads (
  id serial PRIMARY KEY,
  phone_number text,
  name text,
  state text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +down
DROP TABLE leads;
