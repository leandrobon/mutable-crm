# Architecture

How the code is organised and why each piece exists. Read this before adding a
file — most things have an obvious home, and the ones that don't are usually a
sign the design needs a conversation first.

## The shape of the whole thing

One request flows through four layers, each depending only on the one above it:

```
  you type a request
        │
        ▼
  introspection ──── reads the live schema from Postgres
        │
        ▼
  propose ────────── model picks ONE typed tool + arguments   (no SQL involved)
        │
        ▼
  sql ────────────── our code turns that into up SQL + down SQL + a summary
        │
        ▼
  apply ──────────── runs it in a transaction, writes the file and the history row
        │
        ▼
  the right-hand panel re-renders from the new schema
```

The important property: **SQL only ever exists below the `propose` line.** The
model neither reads nor writes it.

## Directories

```
src/
  db/                 database connection and internal tables
  lib/
    schema/           reading the live database
    migrations/       the engine: tools, SQL generation, the model call
  components/ui/      shadcn primitives (generated — don't hand-edit)
  app/                Next.js routes, server actions, the UI
scripts/              dev utilities and the regression suite
migrations/           generated .sql files, one per applied migration
docs/                 this file
```

## Files

### `src/db/`

| File | What it does |
|---|---|
| `index.ts` | Creates the pg connection pool and the Drizzle client. A singleton, because Next reloads modules on every edit in dev and would otherwise leak a pool per reload. Throws if `DATABASE_URL` is missing, which also guarantees it can never be bundled into the browser. |
| `meta.sql` | Defines the `_meta` schema and the `migrations` history table. Applied by `npm run db:init`. |

**The `public` / `_meta` split matters.** The user's entities live in `public`;
our own tables live in `_meta`. Introspection reads only `public`, so the app
can never display its own migration history as if it were a CRM entity. Moving a
table between the two breaks that guarantee.

### `src/lib/schema/`

Everything about reading the database as it actually is.

| File | What it does |
|---|---|
| `types.ts` | `ALLOWED_TYPES` — the eight Postgres types we permit — plus the `Column` / `Table` / `DbSchema` shapes every other layer speaks in. The type list is a boundary: a type not on it cannot be requested. |
| `introspect.ts` | `introspectSchema()` reads `public` from `information_schema` joined with `pg_catalog`. The `pg_catalog` half is what preserves `numeric(10,2)` precision — `information_schema` alone reports bare `numeric`, which would silently drop precision when generating a reverse migration. Also holds `formatSchemaForPrompt()`, which renders the schema as the compact text the model sees; it lives here because it is effectively part of the prompt. |

This layer is why there is no hand-written UI per entity. Every table rendered
on the right comes from `introspectSchema()`.

### `src/lib/migrations/`

The engine. Four files, and the order they run in is the order they're listed.

| File | What it does |
|---|---|
| `tools.ts` | The four typed operations — `createTable`, `addColumn`, `renameColumn`, `changeColumnType` — as Anthropic tool definitions with `strict: true`, plus Zod schemas for parsing the arguments back. **This file is the security boundary.** There is no `dropTable` or `dropColumn`; the model has no way to express the request. Also defines the identifier rule (lowercase snake_case, ≤63 chars) that keeps us from ever emitting a quoted identifier. |
| `propose.ts` | Sends the schema and the tools to the model and returns either a validated `ToolCall` or plain text. The only file that talks to the Anthropic API. Contains no SQL and never asks for any. |
| `sql.ts` | `planMigration(call, schema, rowCount)` → a `Proposal` (summary, impact, `upSql`, `downSql`) or a rejection with a plain-language reason. Pure — no database access — so every branch is directly testable. This is where the "must work with data in the table" rules live, e.g. refusing a required column on a populated table. |
| `apply.ts` | *(not written yet)* Runs the SQL in a transaction and records the migration. |

**Two-pass validation, and the difference between them:**

1. `strict: true` makes the API guarantee the arguments match the tool's JSON
   Schema. Free, and it means malformed arguments are impossible.
2. `planMigration` checks them against reality — does this table exist, is that
   column already taken, is the new type actually different. The API cannot know
   any of this.

Pass 1 stops nonsense. Pass 2 is what protects the database.

### `scripts/`

| File | What it does |
|---|---|
| `init-db.ts` | Applies `meta.sql`. Idempotent. |
| `introspect-dump.ts` | Prints what introspection currently sees, raw and as the model sees it. Useful when the schema changes under you. |
| `test-migrations.ts` | The regression suite. Round-trips all four operations against a table with rows in it — plan, apply `up`, verify, apply `down`, verify the schema is byte-identical to where it started — plus the rejection cases. Run it after any change to `sql.ts` or `introspect.ts`. |

### `migrations/`

One `.sql` file per applied migration, holding both directions. Generated, never
hand-written.

Note: this directory does not work on Vercel, whose filesystem is read-only. The
durable record is the `_meta.migrations` row, which stores the same `up_sql` and
`down_sql`; the file is a developer-facing artifact. See the README's scope
section — the project is meant to be run locally.

## Conventions

- **Everything in English** — code, comments, UI copy, docs.
- **Schema changes run in a transaction.** If the SQL fails, no file is written
  and no history row is inserted.
- **Test against populated tables.** An `ALTER TYPE` on an empty table proves
  nothing. `test-migrations.ts` seeds rows for exactly this reason.
- **New operation? Three steps, in order:** the typed tool, then the SQL
  generator, then the reverse generator. A migration without a reverse does not
  get to exist.
