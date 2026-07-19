/**
 * Round-trips every operation against a table that has data in it:
 * plan -> apply up -> verify -> apply down -> verify the schema is back.
 *
 * Creates its own table and drops it again, so it runs on an empty database,
 * never touches the user's data, and depends on no fixture that has to be set
 * up by hand.
 */
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { planMigration } from "@/lib/migrations/sql";
import type { ToolCall } from "@/lib/migrations/tools";

/** The table the alter operations run against. Named so it cannot collide with
 *  anything the user made. Every table this suite creates is dropped again. */
const TABLE = "migrations_probe";

/** Created by the round trips below and removed at the end, in case a run dies
 *  before its own `down` migration puts them back. */
const CREATED_TABLES = ["deals", "invoices", "animals", "paddocks", "treatments"];

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

/**
 * The table the alter operations need: a column to rename, a numeric one to
 * change the type of, and rows in both. An ALTER on an empty table proves
 * nothing, which is why this seeds before it starts.
 */
async function setup() {
  await cleanup();
  await pool.query(`
    CREATE TABLE ${TABLE} (
      id         serial PRIMARY KEY,
      email      text NOT NULL,
      full_name  text,
      score      numeric(10,2),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    INSERT INTO ${TABLE} (email, full_name, score) VALUES
      ('ana@example.com', 'Ana Ruiz', 91.50),
      ('bo@example.com',  'Bo Chen',  44.25);
  `);
}

async function cleanup() {
  for (const name of [TABLE, ...CREATED_TABLES]) {
    await pool.query(`DROP TABLE IF EXISTS ${name}`);
  }
}

async function main() {
  await setup();
  console.log(`${TABLE} has ${await rowCount(TABLE)} rows\n`);

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

  // The unoffered single-table form still plans, so a history row holding
  // arguments in that shape can be read back and reversed.
  await roundTrip("createTable (single-table form) still plans", {
    name: "createTable",
    args: {
      tableName: "invoices",
      columns: [{ name: "reference", type: "text", nullable: false }],
    },
  });

  await roundTrip("addColumn a column to the probe table", {
    name: "addColumn",
    args: {
      tableName: TABLE,
      columnName: "company",
      type: "text",
      nullable: true,
    },
  });

  await roundTrip("renameColumn full_name -> name", {
    name: "renameColumn",
    args: { tableName: TABLE, from: "full_name", to: "name" },
  });

  await roundTrip("changeColumnType score numeric -> text", {
    name: "changeColumnType",
    args: { tableName: TABLE, columnName: "score", newType: "text" },
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
          tableName: TABLE,
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
      tableName: TABLE,
      columnName: "phone",
      type: "text",
      nullable: false,
    },
  });

  await expectRejection("renameColumn on a column that does not exist", {
    name: "renameColumn",
    args: { tableName: TABLE, from: "nope", to: "whatever" },
  });

  await expectRejection("changeColumnType to the type it already is", {
    name: "changeColumnType",
    args: { tableName: TABLE, columnName: "email", newType: "text" },
  });

  await expectRejection("renameColumn on the reserved id column", {
    name: "renameColumn",
    args: { tableName: TABLE, from: "id", to: "contact_id" },
  });

  console.log(
    failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .then(async () => {
    // Leaves the database as it found it, whether or not the checks passed.
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(failures === 0 ? 0 : 1);
  });
