# crmllm

A CRM whose schema you change by talking to it. You write "contacts need a company
field", the model proposes the change, you review it, you apply it. The table
re-renders itself from the live schema — there is no hand-written UI per entity.

## The interesting part

The model is never asked for SQL.

It gets four typed tools — `createTable`, `addColumn`, `renameColumn`,
`changeColumnType` — and the current schema as context. It picks a tool and its
arguments. **The application code generates the SQL**, not the model.

The result:

- It cannot hallucinate SQL syntax, because it never writes SQL.
- It cannot execute a `DROP` we didn't enable. Safety lives in the tool
  vocabulary, not in a prompt asking the model to behave.
- The plain-language summary is derived from the tool arguments, so it cannot
  contradict the migration it describes.

And two rules that don't bend:

1. **The model executes nothing.** It proposes. Applying is always a user click.
2. **Every migration is stored as a file with its reverse.** They are generated
   together.

## Running it

You need Docker and Node 20+.

```bash
cp .env.example .env.local   # then paste your ANTHROPIC_API_KEY
npm install
npm run db:up                # postgres on localhost:5433
npm run db:init              # create the _meta schema
npm run dev
```

## Scope

**v0** supports exactly four operations: create table, add column, rename column,
change column type. All of them work with data already in the tables, not just
against an empty database.

**v1** (planned): undo using the stored reverses, drop column with explicit
confirmation and a data-loss warning, relations between entities, and a real CRM
seed — contacts, deals, notes.

**Deliberately out of scope:** production, authentication, permissions,
multi-tenant, importing from other CRMs. It is single-user and local. These are
decisions, not a backlog.
