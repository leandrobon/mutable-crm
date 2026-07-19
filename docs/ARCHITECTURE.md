# Architecture

How the code is organised and why each piece exists. Read this before adding a
file. Most things have an obvious home, and the ones that don't are usually a
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
  components/ui/      shadcn primitives (generated, don't hand-edit)
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
| `types.ts` | `ALLOWED_TYPES` (the eight Postgres types we permit) plus the `Column` / `Table` / `DbSchema` shapes every other layer speaks in. The type list is a boundary: a type not on it cannot be requested. Also `ident()`, the last check every table and column name passes before it is interpolated into a SQL string. It lives here because both the migrations engine and the rows layer need it. |
| `introspect.ts` | `introspectSchema()` reads `public` from `information_schema` joined with `pg_catalog`. The `pg_catalog` half is what preserves `numeric(10,2)` precision. `information_schema` alone reports bare `numeric`, which would silently drop precision when generating a reverse migration. Also holds `formatSchemaForPrompt()`, which renders the schema as the compact text the model sees; it lives here because it is effectively part of the prompt. |

This layer is why there is no hand-written UI per entity. Every table rendered
on the right comes from `introspectSchema()`.

### `src/lib/rows/`

The data inside the tables, as opposed to their shape. **Nothing here is a
migration**: no file is written, `_meta.migrations` is untouched, and the model
is not involved. Row edits run straight from a user action in the CRM view,
which is why they need no propose/apply cycle: the two rules in AGENTS.md
govern schema changes, and this is not one.

| File | What it does |
|---|---|
| `cells.ts` | `CellValue` / `RowRecord` / `TableData`, plus `baseType()`, `isEditable()` and `formatCell()`. Deliberately imports no database module: both views are client components and need these to render, so anything here that reached for `pool` would pull `pg` into the browser bundle and fail the build. |
| `read.ts` | `fetchTableData()` reads one page of a table, `fetchAllTableData()` the first page of each. Returns **raw** values, not display strings. The CRM view writes cells back, and formatting a boolean to `"yes"` on the way out would mean parsing `"yes"` back on the way in. Table names reach a SQL string here, so each is looked up in the introspected schema first; that lookup is what makes the interpolation safe. |
| `mutate.ts` | `insertRow()`, `updateCell()`, `deleteRow()`, and the `coerce()` that turns form input into a value the column accepts. |

**The two halves of SQL safety here are not interchangeable.** Identifiers
cannot be parameterized in Postgres, so every table and column name is resolved
against the introspected schema first. The string that reaches the SQL came
from `pg_catalog`, never from the request, and an unknown name is an error
rather than an escaped identifier. Values are always parameters and are never
interpolated, whatever they contain. `scripts/test-rows.ts` asserts both.

`id` and `created_at` are rejected by `isEditable()`: we create them on every
table, the model cannot touch them, and neither can the user by hand.

### `src/lib/migrations/`

The engine. Four files, and the order they run in is the order they're listed.

| File | What it does |
|---|---|
| `tools.ts` | The four typed operations (`createTables`, `addColumn`, `renameColumn`, `changeColumnType`) as Anthropic tool definitions with `strict: true`, plus Zod schemas for parsing the arguments back. **This file is the security boundary.** There is no `dropTable` or `dropColumn`; the model has no way to express the request. Also defines the identifier rule (lowercase snake_case, ≤63 chars) that keeps us from ever emitting a quoted identifier, and the batch caps. See "Creating several tables at once". |
| `propose.ts` | Sends the schema and the tools to the model and returns either a validated `ToolCall` or plain text. The only file that talks to the Anthropic API. Contains no SQL and never asks for any. |
| `sql.ts` | `planMigration(call, schema, rowCount)` → a `Proposal` (summary, impact, `upSql`, `downSql`) or a rejection with a plain-language reason. Pure (no database access), so every branch is directly testable. This is where the "must work with data in the table" rules live, e.g. refusing a required column on a populated table. |
| `apply.ts` | `applyMigration(proposal)` runs the `up` SQL and inserts the history row in one transaction on a single checked-out connection. `listMigrations()` reads the history back, `revertMigration(id)` runs a stored reverse. The `.sql` file is written after the commit, on purpose. See below. |
| `revert-plan.ts` | The undo half that touches no database: `MigrationRecord`, `describeRevert()` (what undoing a change does to the data, derived from the stored tool arguments) and `undoableId()` (which entry the UI may offer). See "Undo" below. |

**Two-pass validation, and the difference between them:**

1. `strict: true` makes the API guarantee the arguments match the tool's JSON
   Schema. Free, and it means malformed arguments are impossible.
2. `planMigration` checks them against reality: does this table exist, is that
   column already taken, is the new type actually different. The API cannot know
   any of this.

Pass 1 stops nonsense. Pass 2 is what protects the database.

**Transactions run on one connection.** `pool.query("BEGIN")` sends BEGIN to
whatever connection the pool hands out, and the next statement can land on a
different one, and the transaction then covers nothing. Always `pool.connect()`,
run the statements on that client, and `release()` in a `finally`.

**The file is written after the commit, not inside the transaction.** The
durable record is the `_meta.migrations` row, which stores the same `up_sql` and
`down_sql`. A filesystem that refuses writes should not roll back a schema
change that already succeeded, so `applyMigration` reports `fileWritten: false`
and carries on rather than failing.

### `src/app/` and `src/components/`

| File | What it does |
|---|---|
| `app/page.tsx` | Server component. Introspects, reads the rows and the migration history, renders the split screen. `dynamic = "force-dynamic"` because the schema can change on any request and a cached page would show a stale one. |
| `app/actions.ts` | Every server action, in three groups. Schema: `propose(message, history)` and `apply(call)`, the only bridge between the browser and the engine. History: `revertChange(id)`. Records: `loadTable`, `createRecord`, `updateRecordCell`, `deleteRecord`, which re-introspect on each call so names are resolved against the live schema rather than trusted from the request. |
| `components/workspace.tsx` | The split screen and the button that collapses the chat. Takes both halves as props so `page.tsx` can stay a server component and render them there. **The chat is hidden with CSS, never unmounted**. The conversation lives in `Chat`'s own state, so unmounting it would throw away every message and any proposal waiting to be applied. |
| `components/panel.tsx` | The right-hand side, and the toggle between its three readings of the same database. The toggle changes the presentation, never the source. |
| `components/history-view.tsx` | The History tab. Every applied migration newest first, its up and down SQL folded away, and an undo button on the single entry that is eligible. Entries below it say what is blocking them instead of offering a control that would be refused. |
| `components/crm-view.tsx` | The non-technical view: entities down the side, records in the middle, edited in place. Cells become inputs on click; booleans are checkboxes and save immediately; new records are a draft row at the bottom. Deleting takes two clicks, because a row has no reverse the way a migration does. |
| `components/entity-panel.tsx` | The technical view. Every table, its column types, raw values, read-only. Contains nothing specific to any entity. This is the file that would not exist if the UI were hand-written per table. |
| `components/chat.tsx` | Message list, proposal cards with the SQL folded away, and the apply button. Also holds the conversation: `transcriptOf()` flattens what is on screen into the turns sent back with the next request, rendering past proposals as `[proposed ...]` lines so the model can see what it offered and whether the user took it. |
| `components/use-dictation.ts` | Speech-to-text via the browser's Web Speech API. **The model has no ears**. The Claude API accepts text, images and PDFs, and exposes no `audio_input` capability and no transcription endpoint, so speech has to become text before the app is involved. Doing it in the browser keeps the stack Anthropic-only: no second provider, no API key, no upload route. The transcript fills the textarea rather than sending, because recognition mangles exactly this app's vocabulary (`snake_case`, `numeric`, column names) and a wrong transcript sent straight to the model costs a call and yields a proposal you have to reject. Declares its own types (TypeScript 5.9's `lib.dom` has none) and hides the button where the API is missing (Firefox). |

**`apply` takes the tool call, not the SQL.** The browser sends back
`{name, args}`; the server re-validates them and regenerates the SQL. Two
reasons. First, a client cannot hand the server a statement to execute. The SQL
that runs is always the SQL this server produced. Second, re-planning re-checks
the change against the schema *as it is now*, so a proposal that went stale
while it sat on screen is rejected cleanly instead of failing halfway through.

**`revertChange` takes only the id**, for the same reason. The reverse that runs
is the one this server generated and stored when the migration was applied; the
browser has no way to supply it or influence it, and which migration is eligible
is decided inside the transaction rather than by the page that asked.

After a successful apply the action calls `revalidatePath("/")` and the client
calls `router.refresh()`, which re-runs the server component, so the right-hand
panel redraws from the new schema with no client-side schema state to keep in
sync.

### `scripts/`

| File | What it does |
|---|---|
| `init-db.ts` | Applies `meta.sql`. Idempotent. |
| `introspect-dump.ts` | Prints what introspection currently sees, raw and as the model sees it. Useful when the schema changes under you. |
| `test-migrations.ts` | The regression suite. Round-trips all four operations against a table with rows in it (plan, apply `up`, verify, apply `down`, verify the schema is byte-identical to where it started), plus the rejection cases. No model, no API credits. Run it after any change to `sql.ts` or `introspect.ts`. |
| `test-rows.ts` | The regression suite for row editing: insert, update, delete against a populated table, `numeric(10,2)` surviving the round trip, the validation rejections, page clamping, and the identifier boundary: a table or column name that is really a SQL fragment must be refused, not escaped. No model, no API credits. Run it after any change to `rows/mutate.ts` or `rows/read.ts`. |
| `test-undo.ts` | The regression suite for undo. Builds a real three-migration stack on a populated scratch table, then walks back down it: out-of-order refused before any SQL, the reverse restoring the schema byte for byte, hand-written values surviving, a column drop taking its values but not its rows, and a reverse that no longer fits the data failing with nothing changed. Removes the table, the history rows and the `.sql` files it created, so it can be run repeatedly. No model, no API credits. Run it after any change to `revert-plan.ts` or `apply.ts`. |
| `test-end-to-end.ts` | The full path with the real model: request → tool choice → SQL → apply → history row and file → revert. **Costs API credits**, so run it deliberately, not on every save. Run it after changing `tools.ts` or `propose.ts`, since those are what shape the model's judgment. |

### `migrations/`

One `.sql` file per applied migration, holding both directions. Generated, never
hand-written.

The project runs locally from a cloned repo (there is no deployment), so these
files are readable artifacts you can open, diff, and commit. They are the
visible half of the "every migration has a reverse" rule.

The `_meta.migrations` row holds the same `up_sql` and `down_sql` and is what
undo will actually read, so the two are redundant by design: the row is the
source of truth, the file is what a human looks at.

## Creating several tables at once

`createTables` takes an array, so a broad request ("a CRM to keep track of my
farm") produces one tool call rather than several.

**Why one call and not several.** Every layer below `propose` assumes one
proposal is one migration: one review card, one apply, one `_meta.migrations`
row, one `.sql` file, one entry in the History tab. Letting the model emit
several tool calls would break that assumption in all of them at once, and undo
being last-in-first-out would turn "undo my farm CRM" into six clicks in the
right order. A plural tool leaves every one of those layers untouched: the only
place the shape matters is the two spots that read `args.tableName`, which is
absent on this tool and handled by `subjectTable()`.

**It is four operations, not five.** There is no singular `createTable`; one
table is an array of one. Having both would make the model choose between
overlapping tools for no benefit.

**All or nothing.** `planOneTable()` validates each table, and the first
rejection rejects the whole request. They are created in a single transaction,
so there is no such thing as applying the good half. `planOneTable` also carries
the set of names claimed earlier in the same batch, because the live schema
cannot catch a request that asks for the same table twice, since neither exists yet.

**The reverse drops in reverse creation order.** It makes no difference today,
since nothing references anything. It is written that way so it still reads
correctly the day tables can reference each other.

**The caps are about review, not about Postgres.** `MAX_TABLES_PER_REQUEST` and
`MAX_COLUMNS_PER_TABLE` exist because rule 1 (the user reviews the proposal
before applying) degrades quietly as the proposal grows. The mechanism is
identical at any size; the human is not. This is the honest cost of the feature.

**No relations, stated out loud.** There is no foreign key tool, so the prompt
tells the model to express references as plain integer columns (`field_id`) and
to say in its reply that nothing enforces them. The schema the user gets implies
relationships it does not enforce, and the reply is the only place that gap is
disclosed.

## Undo

Undo runs the reverse that was stored when the migration was applied. It adds no
tool and the model is not involved. Undoing is a user action on a row of
`_meta.migrations`, the same way editing a record is a user action on a row of a
table.

```
  History tab ──── lists _meta.migrations, newest first
        │
        ▼
  undoableId() ──── decides which single entry gets a button   (pure)
        │
        ▼
  describeRevert() ─ what undoing does to the data            (pure, no model)
        │
        ▼
  revertMigration(id) ── locks the row, re-checks, runs down_sql, stamps
                         reverted_at, one transaction
```

| File | What it does |
|---|---|
| `migrations/revert-plan.ts` | Pure and database-free. Holds `MigrationRecord`, `describeRevert()` and `undoableId()`. **The type lives here, not in `apply.ts`**, because `history-view.tsx` is a client component and needs both. Importing them from `apply.ts` would pull `pg` into the browser bundle, the same constraint that governs `rows/cells.ts`. |
| `migrations/apply.ts` → `revertMigration(id)` | The database half. One transaction on one connection. |
| `components/history-view.tsx` | The History tab: every migration, its reverse folded away, and the undo button on the one entry that may be undone. |

**Undo is last-in-first-out, and that is the whole safety story.** The open
question was never how to run `down_sql`. It is what to do when running it is
no longer safe. Reverting migration N while N+1 builds on it (undoing the
`addColumn` that a later `renameColumn` renamed) would either fail halfway or
leave the schema somewhere neither migration describes. Rather than detect that
with a dependency graph, only the newest migration still in effect can be
undone, which removes the case instead of handling it.

**The eligibility check runs inside the transaction, not in the UI.**
`undoableId()` decides what to draw; the authoritative check re-reads the row
`FOR UPDATE` and re-derives the top of the stack after taking the lock. A page
that has been open for an hour, or two tabs clicking at once, cannot get past
it. This is the same reasoning as `apply` re-planning against the live schema
rather than trusting the proposal on screen.

**A reverse that no longer fits the data fails loudly.** This is the recorded
decision for the `changeColumnType` case: store the reverse anyway, and let
Postgres reject it inside the transaction rather than silently truncating. The
undo rolls back, the schema is untouched, and `reverted_at` stays null. The
migration is still in effect and the error names the value that blocked it.

**Undo restores the schema, never the values.** `addColumn` reverses to
`DROP COLUMN`, which deletes everything anyone typed into that column;
`createTables` reverses to `DROP TABLE`. `describeRevert()` marks those
`destructive: true` and the UI requires a second click, the same convention as
deleting a record. A migration argument that no longer parses also counts as
destructive, because an unreadable change is not one to reassure anyone about.

**The model is told that undo exists, and told it is not his to run.** The
system prompt in `propose.ts` describes the History tab and the LIFO rule, so a
request to revert is answered with where the button is instead of a refusal.
This is prompt text only. There is no revert tool, and the vocabulary is still
the boundary. It is the one place a prompt makes a claim about the UI, so if the
undo control moves or stops being last-in-first-out, that paragraph is wrong and
the model will confidently say so to the user.

**The `.sql` file is left in place when a migration is undone.** It records that
the migration was applied, which stays true; `reverted_at` on the row records
that it was later undone. The row remains the source of truth, the file remains
the thing a human reads.

## Conventions

- **Everything in English**: code, comments, UI copy, docs.
- **Schema changes run in a transaction.** If the SQL fails, no file is written
  and no history row is inserted.
- **Test against populated tables.** An `ALTER TYPE` on an empty table proves
  nothing. `test-migrations.ts` seeds rows for exactly this reason.
- **New operation? Three steps, in order:** the typed tool, then the SQL
  generator, then the reverse generator. A migration without a reverse does not
  get to exist.
