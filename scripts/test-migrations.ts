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

/** The existing table an operation acts on, or null — createTables acts on
 *  none of them, every table in it is new. Mirrors actions.ts. */
function subjectTable(call: ToolCall): string | null {
  return "tableName" in call.args ? call.args.tableName : null;
}

async function roundTrip(label: string, call: ToolCall) {
  console.log(`\n# ${label}`);

  const before = await introspectSchema();
  const beforePrint = fingerprint(before);
  const subject = subjectTable(call);
  const count = subject ? await rowCount(subject) : 0;

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

  // Data must survive the forward migration. Creating tables is the exception:
  // there was nothing there to survive.
  const creates = call.name === "createTable" || call.name === "createTables";
  const survived = subject ? await rowCount(subject) : 0;
  check(
    "rows survived the up migration",
    survived === count || creates,
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
  const subject = subjectTable(call);
  const count = subject ? await rowCount(subject) : 0;
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

  await roundTrip("createTables, one table", {
    name: "createTables",
    args: {
      tables: [
        {
          tableName: "deals",
          columns: [
            { name: "title", type: "text", nullable: false },
            { name: "amount", type: "numeric", nullable: true },
          ],
        },
      ],
    },
  });

  // The case the plural tool exists for: a whole small domain in one migration,
  // created together and dropped together.
  await roundTrip("createTables, a whole domain at once", {
    name: "createTables",
    args: {
      tables: [
        {
          tableName: "animals",
          columns: [
            { name: "tag", type: "text", nullable: false },
            { name: "species", type: "text", nullable: true },
            { name: "born_on", type: "date", nullable: true },
          ],
        },
        {
          tableName: "paddocks",
          columns: [
            { name: "name", type: "text", nullable: false },
            { name: "hectares", type: "numeric", nullable: true },
          ],
        },
        {
          tableName: "treatments",
          columns: [
            { name: "animal_id", type: "integer", nullable: true },
            { name: "medicine", type: "text", nullable: true },
            { name: "given_on", type: "date", nullable: true },
          ],
        },
      ],
    },
  });

  // Still re-plannable, so a history row written before createTables existed
  // can still be read back and reversed.
  await roundTrip("createTable (legacy shape) still plans", {
    name: "createTable",
    args: {
      tableName: "invoices",
      columns: [{ name: "reference", type: "text", nullable: false }],
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

  await expectRejection("createTables listing the same table twice", {
    name: "createTables",
    args: {
      tables: [
        {
          tableName: "crops",
          columns: [{ name: "name", type: "text", nullable: true }],
        },
        {
          tableName: "crops",
          columns: [{ name: "variety", type: "text", nullable: true }],
        },
      ],
    },
  });

  // One bad table rejects the batch — there is no applying the good half.
  await expectRejection("createTables where one table already exists", {
    name: "createTables",
    args: {
      tables: [
        {
          tableName: "harvests",
          columns: [{ name: "kilos", type: "numeric", nullable: true }],
        },
        {
          tableName: "contacts",
          columns: [{ name: "whatever", type: "text", nullable: true }],
        },
      ],
    },
  });

  await expectRejection("createTables using a reserved column name", {
    name: "createTables",
    args: {
      tables: [
        {
          tableName: "silos",
          columns: [
            { name: "capacity", type: "numeric", nullable: true },
            { name: "created_at", type: "timestamptz", nullable: true },
          ],
        },
      ],
    },
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
