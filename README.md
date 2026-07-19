# mutable-crm

A CRM whose schema you change by talking to it.

[![Watch the demo](https://cdn.loom.com/sessions/thumbnails/7609ac9acd2f4be0803b654f8b80708e-with-play.gif)](https://www.loom.com/share/7609ac9acd2f4be0803b654f8b80708e)

You write _"contacts need a company field"_. The model proposes a structured
change, you review it, you apply it, and the table re-renders itself from the
live database schema. **There is no hand-written UI per entity**, and no code is
generated or deployed. Ask for something broader (_"a CRM to keep track of my
farm"_) and the whole set of tables arrives as one proposal.

---

## The interesting part

**The model is never asked for SQL.** It gets four typed tools (`createTables`,
`addColumn`, `renameColumn`, `changeColumnType`) and the current schema as
context, and picks a tool and its arguments. **The application generates the
SQL.** So:

- It cannot hallucinate SQL syntax, because it never writes SQL.
- It cannot ask for a `DROP` we didn't implement, because there is no drop tool
  to express the request with. Safety lives in the tool vocabulary, not in a
  prompt asking the model to behave.
- The plain-language summary can't lie: it is derived from the same arguments
  the SQL is generated from, not from a second model call.

**The model never sees your data.** `formatSchemaForPrompt()` sends table and
column names and types only, so no value stored in the CRM reaches the model's
context.

Two rules the code holds to:

1. **The model executes nothing.** It proposes. Applying is always a user click,
   in a separate server action.
2. **Every migration is stored with its reverse.** `up_sql` and `down_sql` are
   generated together or the migration does not exist.

Validation happens twice: `strict: true` makes the API guarantee the arguments
match the tool's schema, then `planMigration()` checks them against the live
database (does the table exist, is the column name taken, is the new type
different, would a `NOT NULL` column break existing rows) which the API cannot
know.

## Undo

Every applied change is listed in a History tab and reversed with the `down_sql`
it was stored with. Undo is **last-in-first-out**: only the newest change still
in effect can be undone, because reverting migration N while N+1 builds on it
would fail halfway or leave the schema somewhere neither migration describes.
The eligibility check runs _inside_ the transaction, so a stale page or two tabs
racing cannot slip past it.

Undo restores the _shape_ of the schema, never the values: undoing an added
column drops everything written into it, so those undos are marked destructive
and take a second click. A reverse that no longer fits the data fails loudly
rather than destroying it. Change a `numeric` column to `text`, write `"n/a"`
into it, then undo:

```
The database refused the undo, so nothing was changed:
invalid input syntax for type numeric: "n/a"
```

## Running it

You need Docker and Node 20+.

```bash
cp .env.example .env.local   # then paste your ANTHROPIC_API_KEY
npm install
npm run db:up                # postgres on localhost:5433
npm run db:init              # create the _meta schema
npm run dev
```

Open http://localhost:3000. The database starts empty, so the first thing you do
is ask for some tables.

## Tests

Three suites run against a real Postgres with no API calls and no credits spent.
Each creates its own table, seeds it with rows, and drops it afterwards. They run
against **populated** tables on purpose: an `ALTER TYPE` on an empty table proves
nothing.

```bash
npm test                  # all three, stopping at the first failure
npm run test:migrations   # or one at a time
npm run test:rows
npm run test:undo
```

`test-migrations.ts` round-trips every operation and checks the schema comes back
byte-identical to where it started. `test-undo.ts` covers out-of-order undo
refused before any SQL runs, a reverse that no longer fits the data, and undoing
something already undone. A fourth, `npm run test:e2e`, runs the real model and
**costs API credits**; it is deliberately left out of `npm test`.

## Stack

Next.js 16 (App Router), TypeScript, Postgres in Docker, Drizzle, the Anthropic
SDK, shadcn/ui. No LangChain, deliberately.

Drizzle is the query and execution layer, not the migration layer: user tables
are created at runtime, so no TypeScript schema file describes them and
`drizzle-kit` cannot diff them. Introspection reads `information_schema` and
`pg_catalog` directly, so a type it did not create is not silently flattened.

Voice input is dictation only, via the browser's Web Speech API. The transcript
fills the textarea and you still press Send.

## Scope

Four schema operations: create tables, add column, rename column, change column
type. Plus undo, and editing rows in the CRM view.

There is **no drop**, for either a table or a column: deletion is absent from the
vocabulary rather than disabled behind a check.

There are **no relationships**. When one entity refers to another the model uses
a plain integer column (`animal_id`) and says in its reply that nothing enforces
it. The schema can imply relationships that it does not enforce.

Out of scope: authentication, multi-tenant, permissions, RLS, production
deployment, importing from other CRMs. It is single-user and local.

## Architecture

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) documents every directory and file
and why each exists, including why transactions must run on a single checked-out
connection, and why the migration file is written _after_ the commit.

## License

MIT, see [LICENSE](LICENSE).
