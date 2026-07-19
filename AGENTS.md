<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# crmllm

## What this is

A CRM whose schema is modified in natural language. The user writes a request, an
LLM proposes a structured schema change, the user reviews it and applies it. The
panel on the right renders itself from the live database schema: **there are no
hand-written components per entity**.

The core idea is not "a CRM". It is: _an agent that proposes schema changes
reliably_. Everything else is scaffolding.

## The two rules that don't bend

1. **The LLM executes nothing.** It only picks a tool and its arguments. Applying
   is always an explicit user action, in a separate server action.
2. **Every migration is persisted as a file with its reverse.** `up_sql` and
   `down_sql` are generated together or the migration does not exist.

If a change you're about to make violates either one, stop and say so.

## The technical detail everything rests on

**We never ask the LLM for free-form SQL.** We define typed tools (`createTable`,
`addColumn`, `renameColumn`, `changeColumnType`), pass it the current schema as
context, and **our code generates the SQL** from the chosen tool and its arguments.

This buys three things:

- It cannot hallucinate SQL syntax, because it never writes SQL.
- It cannot execute a `DROP` we didn't enable — the tool vocabulary is the
  security boundary, not a prompt asking it to behave.
- The plain-language summary is derived from the tool arguments, not from a
  second model call: cheaper, and it cannot contradict the SQL it describes.

When adding a new operation: the typed tool first, then the SQL generator, then
the reverse generator. In that order.

## Stack

- Next.js 16 (App Router) + TypeScript. Server actions, no separate REST API.
- Postgres in Docker, **port 5433** (see `docker-compose.yml`).
- Drizzle ORM — chosen over Prisma because we need to generate and execute DDL
  programmatically at runtime, not a closed migration cycle.
- Anthropic SDK with tool calling. **No LangChain**, deliberately.
- shadcn/ui.

Note on Drizzle: user tables are created at runtime, so no TypeScript schema file
describes them and `drizzle-kit` cannot generate the diffs. Introspection reads
`information_schema` directly, and Drizzle acts as the query/execution layer. The
SQL generators for the four operations are code we own.

## Layout

**Read `docs/ARCHITECTURE.md` before adding a file** — it documents every
directory and file, and why each exists. Keep it current when you add one.

The short version:

```
src/db/               connection + internal _meta tables
src/lib/schema/       reading the live database
src/lib/rows/         reading + writing the data inside it (not migrations)
src/lib/migrations/   the engine: tools, model call, SQL generation
scripts/              dev utilities + the regression suite
migrations/           generated .sql files, one per applied migration
```

Important convention: **user entities live in `public`, internal tables in
`_meta`.** Introspection reads only `public`, so it never sees its own tables.
Don't move anything between schemas without updating introspection.

Run `npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/test-migrations.ts`
after any change to `sql.ts` or `introspect.ts`, and `scripts/test-rows.ts` after
any change to `rows/mutate.ts` or `rows/read.ts`.

One constraint that typecheck will not catch: `src/lib/rows/cells.ts` must not
import anything that reaches `@/db`. Both views are client components and import
it to render, so a database import there pulls `pg` into the browser bundle and
the build fails.

## Commands

```bash
npm run db:up       # start postgres
npm run db:init     # create the _meta schema (idempotent)
npm run db:fixture  # recreate the contacts table the test suites need
npm run db:reset    # drop the volume and start clean
npm run db:psql     # psql shell inside the container
npm run dev
```

**Starting from an empty database** — the three commands go together, and the
`migrations/` files are part of the state:

```bash
npm run db:reset && npm run db:init && npm run db:fixture
rm migrations/*.sql          # keep .gitkeep
```

`db:reset` destroys the volume, so it takes the `contacts` fixture with it.
`db:fixture` puts it back: the regression suites hardcode that table, and
without it they fail on a clean database for reasons that look like real bugs.
Delete the `.sql` files in the same breath — they describe migrations that the
new database has no history rows for, and leaving them makes the folder claim a
past the database does not have.

To test the app itself from nothing (no `contacts`, no `leads`), skip
`db:fixture` — just remember the suites will not pass until you run it.

## Conventions

- Everything in English: code, comments, UI copy, docs.
- Schema changes are applied inside a transaction. If the SQL fails, neither the
  file nor the `_meta.migrations` row is written.
- Every operation must work **with data in the tables**. Test against populated
  tables: an `ALTER TYPE` on an empty table proves nothing.

## v0 scope (three days)

Exactly four **schema** operations: create tables, add column, rename column,
change column type. Nothing else.

**Creating tables is plural.** `createTables` takes an array, so "a CRM to track
my farm" becomes one tool call, one proposal, one migration and one undo,
instead of a stack of them. A single table is an array of one — there is no
singular version of the tool. This is still four operations, not five.

Two consequences worth keeping in mind:

- **One bad table rejects the whole request.** They are created in a single
  transaction, so there is no applying the good half. A partial CRM is worse
  than a clear refusal.
- **The batch is capped** (`MAX_TABLES_PER_REQUEST`). Not a database limit — a
  review limit. Applying is a user action and rule 1 assumes the user *reads*
  what they apply; a twenty-table proposal gets approved by scrolling.

`createTable` (singular) still exists in `toolSchemas` but is not offered to the
model. It is there so history rows written before the change can still be read
and reversed.

Editing rows — add, edit, delete a record from the CRM view — is in scope and
built. It does not widen the four operations: it is data, not schema. No
proposal, no migration, no model, no `_meta.migrations` row. The tool vocabulary
is still the security boundary for everything the model can reach, and the model
cannot reach this.

Explicitly out: authentication, multi-tenant, RLS, permissions, production,
importing from other CRMs. Don't add them even if they look easy — they add
complexity without touching the core idea.

Voice is in and is dictation only: the browser's Web Speech API turns speech
into text that fills the chat box, and the user still presses Send. The model
never receives audio — the Claude API has no `audio_input` capability and no
transcription endpoint — so this adds no provider, no key, and no new path to
the tools.

## v1 (in progress)

**Undo — built.** The History tab lists every applied migration and runs the
reverse it was stored with. It adds no tool and the model is not involved:
undoing is a user action on a row of `_meta.migrations`, the way editing a
record is a user action on a row of a table. Two things to know before touching
it, both explained in `docs/ARCHITECTURE.md` → "Undo":

- **It is last-in-first-out.** Only the newest migration still in effect can be
  undone. That is what makes it safe without a dependency graph, and the check
  that enforces it runs inside the transaction, not in the UI.
- **It restores the schema, never the values.** Undoing an `addColumn` drops
  the column and everything typed into it. `describeRevert()` marks those
  destructive and the UI takes a second click.

Run `npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/test-undo.ts`
after any change to `revert.ts` or `apply.ts`.

**Multi-table creation — built.** See `createTables` under v0 scope above.

Dropped from v1 deliberately: drop column, relations between entities, a real
CRM seed. Not "not yet" — decided against for this version.

**The relations gap is now visible to users**, and that is the main thing to
know if you pick relations up later. A generated farm CRM has `field_id` on
`crops` because the model was told to express references as plain integer
columns; nothing enforces that the id points at a row that exists, and nothing
cascades when the target is deleted. The prompt requires the model to say so out
loud when it designs one. If you add foreign keys, that instruction goes stale
and the `createTables` reverse has to drop tables in an order that respects
them — it already drops in reverse creation order for exactly this reason.

**Drop column is the first destructive tool.** Today the security story is that
deletion is *absent* from the vocabulary, not disabled — that is the boundary.
Adding `dropColumn` changes the claim, and its reverse cannot restore the data,
only the column. Decide what `down_sql` means there before building it, and keep
the order: typed tool, then SQL generator, then reverse generator.
