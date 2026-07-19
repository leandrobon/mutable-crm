# crmllm

A CRM whose schema you change by talking to it.

You write *"contacts need a company field"*. The model proposes a structured
change, you review it, you apply it. The table re-renders itself from the live
database schema — **there is no hand-written UI per entity**, and no code is
generated or deployed.

Ask for something broader — *"a CRM to keep track of my farm"* — and you get one
proposal containing the whole set of tables, applied as one migration and undone
with one click.

---

## The interesting part

**The model is never asked for SQL.**

It gets four typed tools — `createTables`, `addColumn`, `renameColumn`,
`changeColumnType` — and the current schema as context. It picks a tool and its
arguments. **The application generates the SQL**, not the model.

That one decision buys three things:

- **It cannot hallucinate SQL syntax**, because it never writes SQL.
- **It cannot ask for a `DROP` we didn't implement.** There is no drop tool, so
  there is no way to express the request. Safety lives in the tool vocabulary,
  not in a prompt asking the model to behave.
- **The plain-language summary can't lie.** It is derived from the same arguments
  the SQL is generated from, not from a second model call that might describe
  something else.

Two rules the code holds to:

1. **The model executes nothing.** It proposes. Applying is always a user click,
   in a separate server action.
2. **Every migration is stored with its reverse.** `up_sql` and `down_sql` are
   generated together or the migration does not exist.

Validation happens twice, and the two passes are not interchangeable. The API's
`strict: true` guarantees the arguments match the tool's schema — that stops
malformed input. Then `planMigration()` checks them against reality: does this
table exist, is that column name taken, is the new type actually different, does
this table have rows that a `NOT NULL` column would break. The API cannot know
any of that. The first pass stops nonsense; the second protects the database.

## Undo

Every applied change is listed in a History tab and can be reversed using the
`down_sql` it was stored with.

Undo is **last-in-first-out** — only the newest change still in effect can be
undone. That is the whole safety story: reverting migration N while N+1 builds on
it would either fail halfway or leave the schema somewhere neither migration
describes, so rather than detect that with a dependency graph, the case is
removed. The eligibility check runs *inside* the transaction, not in the UI, so a
stale page or two tabs racing cannot slip past it.

A reverse that no longer fits the data fails loudly instead of quietly destroying
it. Change a column from `numeric` to `text`, write `"n/a"` into it, then undo:

```
The database refused the undo, so nothing was changed:
invalid input syntax for type numeric: "n/a"
```

Undo restores the *shape* of the schema, never the values. Undoing an added
column drops that column and everything written into it, so those undos are
marked destructive and take a second click.

## Running it

You need Docker and Node 20+.

```bash
cp .env.example .env.local   # then paste your ANTHROPIC_API_KEY
npm install
npm run db:up                # postgres on localhost:5433
npm run db:init              # create the _meta schema
npm run dev
```

Open http://localhost:3000. The database starts empty — the first thing you do is
ask for some tables.

## Tests

Three suites run against a real Postgres with no API calls and no credits spent.
Each creates its own table, seeds it with rows, and drops it afterwards, so they
work on an empty database and leave it as they found it.

```bash
npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/test-migrations.ts
npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/test-rows.ts
npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/test-undo.ts
```

They test against **populated** tables on purpose — an `ALTER TYPE` on an empty
table proves nothing. `test-migrations.ts` round-trips every operation (plan →
apply → verify → reverse → verify the schema is byte-identical to where it
started). `test-undo.ts` covers the ugly cases: out-of-order undo refused before
any SQL runs, a reverse that no longer fits the data, undoing something already
undone.

A fourth, `scripts/test-end-to-end.ts`, runs the real model and **costs API
credits**.

## Stack

Next.js 16 (App Router), TypeScript, Postgres in Docker, Drizzle, the Anthropic
SDK, shadcn/ui. No LangChain, deliberately.

Drizzle is the query and execution layer, not the migration layer: user tables
are created at runtime, so no TypeScript schema file describes them and
`drizzle-kit` cannot diff them. Introspection reads `information_schema` and
`pg_catalog` directly — the `pg_catalog` half is what preserves `numeric(10,2)`
precision, which `information_schema` alone reports as bare `numeric` and would
silently drop when generating a reverse.

Voice input is dictation only, via the browser's Web Speech API. The transcript
fills the textarea and you still press Send.

## Scope

Four schema operations: create tables, add column, rename column, change column
type. Plus undo, and editing rows in the CRM view.

There is **no drop**, for either a table or a column. Deletion is absent from the
vocabulary rather than disabled behind a check — that absence *is* the security
boundary.

There are **no relationships**. When one entity refers to another the model uses
a plain integer column (`animal_id`) and says in its reply that nothing enforces
it. The schema can imply relationships that it does not enforce.

Deliberately out of scope: authentication, multi-tenant, permissions, RLS,
production deployment, importing from other CRMs. It is single-user and local.
These are decisions, not a backlog.

## Architecture

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) documents every directory and file
and why each exists — including the parts that are easy to get wrong, like why
transactions must run on a single checked-out connection, and why the migration
file is written *after* the commit rather than inside it.

## License

MIT — see [LICENSE](LICENSE).
