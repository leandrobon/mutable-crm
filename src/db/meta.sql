-- Internal application tables. They live in the `_meta` schema so that
-- introspection of the `public` schema only ever sees the user's entities.
CREATE SCHEMA IF NOT EXISTS _meta;

CREATE TABLE IF NOT EXISTS _meta.migrations (
  id          serial PRIMARY KEY,
  filename    text        NOT NULL UNIQUE,
  summary     text        NOT NULL,
  tool_name   text        NOT NULL,
  tool_args   jsonb       NOT NULL,
  up_sql      text        NOT NULL,
  down_sql    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz
);
