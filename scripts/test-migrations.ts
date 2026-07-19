/**
 * Round-trips every operation against a table that has data in it:
 * plan -> apply up -> verify -> apply down -> verify the schema is back.
 */
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { planMigration } from "@/lib/migrations/sql";
import type { ToolCall } from "@/lib/migrations/tools";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A transaction has to run on one checked-out connection — pool.query("BEGIN")
 *  may put the following statements on a different connection entirely. */
async function runInTransaction(sql: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function rowCount(table: string): Promise<number> {
  const exists = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${table}`],
  );
  if (!exists.rows[0].present) return 0;
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

function fingerprint(schema: Awaited<ReturnType<typeof introspectSchema>>) {
  return JSON.stringify(schema);
}

async function roundTrip(label: string, call: ToolCall) {
  console.log(`\n# ${label}`);

  const before = await introspectSchema();
  const beforePrint = fingerprint(before);
  const count = await rowCount(call.args.tableName);

  const result = planMigration(call, before, count);
  if (!result.ok) {
    failures++;
    console.log(`  FAIL rejected unexpectedly — ${result.reason}`);
    return;
  }

  const { proposal } = result;
  console.log(`  summary: ${proposal.summary}`);
  console.log(`  up:   ${proposal.upSql.replace(/\n/g, "\n        ")}`);
  console.log(`  down: ${proposal.downSql}`);

  try {
    await runInTransaction(proposal.upSql);
  } catch (err) {
    failures++;
    console.log(`  FAIL up failed — ${(err as Error).message}`);
    return;
  }

  const afterUp = await introspectSchema();
  check("up changed the schema", fingerprint(afterUp) !== beforePrint);

  // Data must survive the forward migration.
  const survived = await rowCount(call.args.tableName);
  check(
    "rows survived the up migration",
    survived === count || call.name === "createTable",
    `${count} -> ${survived}`,
  );

  try {
    await runInTransaction(proposal.downSql);
  } catch (err) {
    failures++;
    console.log(`  FAIL down failed — ${(err as Error).message}`);
    return;
  }

  const afterDown = await introspectSchema();
  check("down restored the original schema", fingerprint(afterDown) === beforePrint);
}

async function expectRejection(label: string, call: ToolCall) {
  const schema = await introspectSchema();
  const count = await rowCount(call.args.tableName);
  const result = planMigration(call, schema, count);
  console.log(`\n# ${label}`);
  check(
    "rejected before any SQL",
    !result.ok,
    result.ok ? "it produced a proposal" : "",
  );
  if (!result.ok) console.log(`  reason: ${result.reason}`);
}

async function main() {
  console.log(`contacts has ${await rowCount("contacts")} rows\n`);

  await roundTrip("createTable deals", {
    name: "createTable",
    args: {
      tableName: "deals",
      columns: [
        { name: "title", type: "text", nullable: false },
        { name: "amount", type: "numeric", nullable: true },
      ],
    },
  });

  await roundTrip("addColumn contacts.company", {
    name: "addColumn",
    args: {
      tableName: "contacts",
      columnName: "company",
      type: "text",
      nullable: true,
    },
  });

  await roundTrip("renameColumn contacts.full_name -> name", {
    name: "renameColumn",
    args: { tableName: "contacts", from: "full_name", to: "name" },
  });

  await roundTrip("changeColumnType contacts.score numeric -> text", {
    name: "changeColumnType",
    args: { tableName: "contacts", columnName: "score", newType: "text" },
  });

  await expectRejection("addColumn required, on a table with rows", {
    name: "addColumn",
    args: {
      tableName: "contacts",
      columnName: "phone",
      type: "text",
      nullable: false,
    },
  });

  await expectRejection("renameColumn on a column that does not exist", {
    name: "renameColumn",
    args: { tableName: "contacts", from: "nope", to: "whatever" },
  });

  await expectRejection("changeColumnType to the type it already is", {
    name: "changeColumnType",
    args: { tableName: "contacts", columnName: "email", newType: "text" },
  });

  await expectRejection("renameColumn on the reserved id column", {
    name: "renameColumn",
    args: { tableName: "contacts", from: "id", to: "contact_id" },
  });

  console.log(
    failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`,
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
