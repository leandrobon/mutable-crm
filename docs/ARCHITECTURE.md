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
    rows/             reading and writing the data inside it
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

### `src/lib/rows/`

The data inside the tables, as opposed to their shape. **Nothing here is a
migration**: no file is written, `_meta.migrations` is untouched, and the model
is not involved. Row edits run straight from a user action in the CRM view,
which is why they need no propose/apply cycle — the two rules in AGENTS.md
govern schema changes, and this is not one.

| File | What it does |
|---|---|
| `cells.ts` | `CellValue` / `RowRecord` / `TableData`, plus `baseType()`, `isEditable()` and `formatCell()`. Deliberately imports no database module: both views are client components and need these to render, so anything here that reached for `pool` would pull `pg` into the browser bundle and fail the build. |
| `read.ts` | `fetchTableData()` reads one page of a table, `fetchAllTableData()` the first page of each. Returns **raw** values, not display strings — the CRM view writes cells back, and formatting a boolean to `"yes"` on the way out would mean parsing `"yes"` back on the way in. Table names reach a SQL string here, so each is looked up in the introspected schema first; that lookup is what makes the interpolation safe. |
| `mutate.ts` | `insertRow()`, `updateCell()`, `deleteRow()`, and the `coerce()` that turns form input into a value the column accepts. |

**The two halves of SQL safety here are not interchangeable.** Identifiers
cannot be parameterized in Postgres, so every table and column name is resolved
against the introspected schema first — the string that reaches the SQL came
from `pg_catalog`, never from the request, and an unknown name is an error
rather than an escaped identifier. Values are always parameters and are never
interpolated, whatever they contain. `scripts/test-rows.ts` asserts both.

`id` and `created_at` are rejected by `isEditable()`: we create them on every
table, the model cannot touch them, and neither can the user by hand.

### `src/lib/migrations/`

The engine. Four files, and the order they run in is the order they're listed.

| File | What it does |
|---|---|
| `tools.ts` | The four typed operations — `createTable`, `addColumn`, `renameColumn`, `changeColumnType` — as Anthropic tool definitions with `strict: true`, plus Zod schemas for parsing the arguments back. **This file is the security boundary.** There is no `dropTable` or `dropColumn`; the model has no way to express the request. Also defines the identifier rule (lowercase snake_case, ≤63 chars) that keeps us from ever emitting a quoted identifier. |
| `propose.ts` | Sends the schema and the tools to the model and returns either a validated `ToolCall` or plain text. The only file that talks to the Anthropic API. Contains no SQL and never asks for any. |
| `sql.ts` | `planMigration(call, schema, rowCount)` → a `Proposal` (summary, impact, `upSql`, `downSql`) or a rejection with a plain-language reason. Pure — no database access — so every branch is directly testable. This is where the "must work with data in the table" rules live, e.g. refusing a required column on a populated table. |
| `apply.ts` | `applyMigration(proposal)` runs the `up` SQL and inserts the history row in one transaction on a single checked-out connection. `listMigrations()` reads the history back. The `.sql` file is written after the commit, on purpose — see below. |

**Two-pass validation, and the difference between them:**

1. `strict: true` makes the API guarantee the arguments match the tool's JSON
   Schema. Free, and it means malformed arguments are impossible.
2. `planMigration` checks them against reality — does this table exist, is that
   column already taken, is the new type actually different. The API cannot know
   any of this.

Pass 1 stops nonsense. Pass 2 is what protects the database.

**Transactions run on one connection.** `pool.query("BEGIN")` sends BEGIN to
whatever connection the pool hands out, and the next statement can land on a
different one — the transaction then covers nothing. Always `pool.connect()`,
run the statements on that client, and `release()` in a `finally`.

**The file is written after the commit, not inside the transaction.** The
durable record is the `_meta.migrations` row, which stores the same `up_sql` and
`down_sql`. A filesystem that refuses writes should not roll back a schema
change that already succeeded, so `applyMigration` reports `fileWritten: false`
and carries on rather than failing.

### `src/app/` and `src/components/`

| File | What it does |
|---|---|
| `app/page.tsx` | Server component. Introspects, reads the rows, renders the split screen. `dynamic = "force-dynamic"` because the schema can change on any request and a cached page would show a stale one. |
| `app/actions.ts` | Every server action, in two groups. Schema: `propose(message, history)` and `apply(call)` — the only bridge between the browser and the engine. Records: `loadTable`, `createRecord`, `updateRecordCell`, `deleteRecord`, which re-introspect on each call so names are resolved against the live schema rather than trusted from the request. |
| `components/panel.tsx` | The right-hand side, and the toggle between its two readings of the same data. The toggle changes the presentation, never the source. |
| `components/crm-view.tsx` | The non-technical view: entities down the side, records in the middle, edited in place. Cells become inputs on click; booleans are checkboxes and save immediately; new records are a draft row at the bottom. Deleting takes two clicks, because a row has no reverse the way a migration does. |
| `components/entity-panel.tsx` | The technical view. Every table, its column types, raw values, read-only. Contains nothing specific to any entity — this is the file that would not exist if the UI were hand-written per table. |
| `components/chat.tsx` | Message list, proposal cards with the SQL folded away, and the apply button. Also holds the conversation: `transcriptOf()` flattens what is on screen into the turns sent back with the next request, rendering past proposals as `[proposed ...]` lines so the model can see what it offered and whether the user took it. |

**`apply` takes the tool call, not the SQL.** The browser sends back
`{name, args}`; the server re-validates them and regenerates the SQL. Two
reasons. First, a client cannot hand the server a statement to execute — the SQL
that runs is always the SQL this server produced. Second, re-planning re-checks
the change against the schema *as it is now*, so a proposal that went stale
while it sat on screen is rejected cleanly instead of failing halfway through.

After a successful apply the action calls `revalidatePath("/")` and the client
calls `router.refresh()`, which re-runs the server component — the right-hand
panel redraws from the new schema with no client-side schema state to keep in
sync.

### `scripts/`

| File | What it does |
|---|---|
| `init-db.ts` | Applies `meta.sql`. Idempotent. |
| `introspect-dump.ts` | Prints what introspection currently sees, raw and as the model sees it. Useful when the schema changes under you. |
| `test-migrations.ts` | The regression suite. Round-trips all four operations against a table with rows in it — plan, apply `up`, verify, apply `down`, verify the schema is byte-identical to where it started — plus the rejection cases. No model, no API credits. Run it after any change to `sql.ts` or `introspect.ts`. |
| `test-rows.ts` | The regression suite for row editing: insert, update, delete against a populated table, `numeric(10,2)` surviving the round trip, the validation rejections, page clamping, and the identifier boundary — a table or column name that is really a SQL fragment must be refused, not escaped. No model, no API credits. Run it after any change to `rows/mutate.ts` or `rows/read.ts`. |
| `test-end-to-end.ts` | The full path with the real model: request → tool choice → SQL → apply → history row and file → revert. **Costs API credits** — run it deliberately, not on every save. Run it after changing `tools.ts` or `propose.ts`, since those are what shape the model's judgment. |

### `migrations/`

One `.sql` file per applied migration, holding both directions. Generated, never
hand-written.

The project runs locally from a cloned repo — there is no deployment — so these
files are readable artifacts you can open, diff, and commit. They are the
visible half of the "every migration has a reverse" rule.

The `_meta.migrations` row holds the same `up_sql` and `down_sql` and is what
undo will actually read, so the two are redundant by design: the row is the
source of truth, the file is what a human looks at.

## Conventions

- **Everything in English** — code, comments, UI copy, docs.
- **Schema changes run in a transaction.** If the SQL fails, no file is written
  and no history row is inserted.
- **Test against populated tables.** An `ALTER TYPE` on an empty table proves
  nothing. `test-migrations.ts` seeds rows for exactly this reason.
- **New operation? Three steps, in order:** the typed tool, then the SQL
  generator, then the reverse generator. A migration without a reverse does not
  get to exist.
