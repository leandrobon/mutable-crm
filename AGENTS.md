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

The core idea is not "a CRM". It is: *an agent that proposes schema changes
reliably*. Everything else is scaffolding.

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
src/lib/migrations/   the engine: tools, model call, SQL generation
scripts/              dev utilities + the regression suite
migrations/           generated .sql files, one per applied migration
```

Important convention: **user entities live in `public`, internal tables in
`_meta`.** Introspection reads only `public`, so it never sees its own tables.
Don't move anything between schemas without updating introspection.

Run `npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/test-migrations.ts`
after any change to `sql.ts` or `introspect.ts`.

## Commands

```bash
npm run db:up      # start postgres
npm run db:init    # create the _meta schema (idempotent)
npm run db:reset   # drop the volume and start clean
npm run db:psql    # psql shell inside the container
npm run dev
```

## Conventions

- Everything in English: code, comments, UI copy, docs.
- Schema changes are applied inside a transaction. If the SQL fails, neither the
  file nor the `_meta.migrations` row is written.
- Every operation must work **with data in the tables**. Test against populated
  tables: an `ALTER TYPE` on an empty table proves nothing.

## v0 scope (three days)

Exactly four operations: create table, add column, rename column, change column
type. Nothing else.

Explicitly out: authentication, multi-tenant, RLS, permissions, production,
importing from other CRMs. Don't add them even if they look easy — they add
complexity without touching the core idea.

v1 (later, if v0 works): undo using the reverses, drop column with explicit
confirmation, relations between entities, a real CRM seed (contacts, deals, notes).
