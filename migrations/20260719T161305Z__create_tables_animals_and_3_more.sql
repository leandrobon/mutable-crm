-- 20260719T161305Z__create_tables_animals_and_3_more
-- Create 4 tables: animals, fields, tasks, contacts.

-- +up
CREATE TABLE animals (
  id serial PRIMARY KEY,
  name text,
  tag text,
  species text,
  breed text,
  sex text,
  birth_date date,
  status text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fields (
  id serial PRIMARY KEY,
  name text,
  area_acres numeric,
  crop text,
  planted_on date,
  expected_harvest date,
  status text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  due_date date,
  done boolean,
  animal_id integer,
  field_id integer,
  contact_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id serial PRIMARY KEY,
  name text NOT NULL,
  role text,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +down
DROP TABLE contacts;
DROP TABLE tasks;
DROP TABLE fields;
DROP TABLE animals;
