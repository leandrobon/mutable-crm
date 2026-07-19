/**
 * End-to-end: a real request -> the model picks a tool -> we generate SQL ->
 * we apply it -> the history row and file exist -> we put it back.
 *
 * Costs API credits. Run it deliberately, not in a loop.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { proposeChange } from "@/lib/migrations/propose";
import { planMigration } from "@/lib/migrations/sql";
import {
  applyMigration,
  listMigrations,
  revertMigration,
} from "@/lib/migrations/apply";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function rowCount(table: string): Promise<number> {
  const exists = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    `public.${table}`,
  ]);
  if (!exists.rows[0].present) return 0;
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

/** Sends one request and reports which tool the model reached for. */
async function propose(request: string, expected: string | null) {
  console.log(`\n# "${request}"`);
  const schema = await introspectSchema();
  const result = await proposeChange(request, schema);

  if (result.type === "message") {
    check(
      `no operation proposed (expected ${expected ?? "none"})`,
      expected === null,
      `model replied: ${result.text.slice(0, 120)}`,
    );
    if (expected === null) console.log(`  reply: ${result.text.slice(0, 200)}`);
    return null;
  }

  check(`chose ${expected}`, result.call.name === expected, `got ${result.call.name}`);
  console.log(`  args: ${JSON.stringify(result.call.args)}`);

  // createTables acts on no existing table, so there are no rows to count.
  const subject =
    "tableName" in result.call.args ? result.call.args.tableName : null;

  const plan = planMigration(
    result.call,
    schema,
    subject ? await rowCount(subject) : 0,
  );
  if (!plan.ok) {
    console.log(`  rejected: ${plan.reason}`);
    return null;
  }

  console.log(`  summary: ${plan.proposal.summary}`);
  console.log(`  up:      ${plan.proposal.upSql.replace(/\n/g, "\n           ")}`);
  console.log(`  down:    ${plan.proposal.downSql}`);
  return plan.proposal;
}

async function main() {
  await propose("the contacts need a field for the company they work at", "addColumn");
  await propose("full_name should just be called name", "renameColumn");
  await propose(
    "I want to track deals, with a title and an amount",
    "createTables",
  );
  await propose("score should be text instead of a number", "changeColumnType");
  await propose("delete the contacts table, I don't need it anymore", null);
  await propose("what tables do I have right now?", null);

  // --- apply, for real ---
  console.log("\n\n=== applying one migration for real ===");
  const proposal = await propose(
    "add an optional notes field to contacts",
    "addColumn",
  );
  if (!proposal) {
    console.log("no proposal to apply");
    await pool.end();
    process.exit(1);
  }

  const before = await introspectSchema();
  const applied = await applyMigration(proposal);

  if (!applied.ok) {
    failures++;
    console.log(`  FAIL apply failed: ${applied.reason}`);
    await pool.end();
    process.exit(1);
  }

  console.log(`\n  wrote ${applied.filename}`);
  check("file was written", applied.fileWritten);

  const after = await introspectSchema();
  const addedColumn =
    "columnName" in proposal.args ? proposal.args.columnName : null;
  check(
    "column exists after apply",
    Boolean(addedColumn) &&
      after.tables
        .find((t) => t.name === "contacts")!
        .columns.some((c) => c.name === addedColumn),
  );
  check(
    "data survived",
    (await rowCount("contacts")) === 2,
    `${await rowCount("contacts")} rows`,
  );

  const history = await listMigrations();
  const record = history.find((m) => m.filename === applied.filename);
  check("history row recorded", Boolean(record));
  check("history row stores the reverse", Boolean(record?.downSql));

  const contents = await readFile(
    join(process.cwd(), "migrations", applied.filename),
    "utf8",
  );
  check("file contains both directions", contents.includes("-- +up") && contents.includes("-- +down"));
  console.log(`\n--- ${applied.filename} ---\n${contents}`);

  // --- put it back, through the same undo the History tab calls ---
  //
  // Deliberately revertMigration() rather than executing down_sql by hand:
  // running the SQL directly would leave the one script that covers the whole
  // real path as the one script that never touches the undo code, and it would
  // keep passing with undo completely broken.
  console.log("=== reverting through revertMigration ===");

  const reverting = await revertMigration(record!.id);
  check("revert succeeded", reverting.ok, reverting.ok ? "" : reverting.reason);

  const reverted = await introspectSchema();
  check(
    "schema is back to where it started",
    JSON.stringify(reverted) === JSON.stringify(before),
  );
  check("data still intact", (await rowCount("contacts")) === 2);

  const afterRevert = (await listMigrations()).find((m) => m.id === record!.id);
  check("the history row is stamped reverted", afterRevert?.revertedAt != null);

  // The stack is now empty of this migration, so asking again must be refused
  // rather than running the reverse a second time.
  const twice = await revertMigration(record!.id);
  check("undoing it again is refused", !twice.ok);
  if (!twice.ok) console.log(`  reason: ${twice.reason}`);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
