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
import { applyMigration, listMigrations } from "@/lib/migrations/apply";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
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

  const plan = planMigration(
    result.call,
    schema,
    await rowCount(result.call.args.tableName),
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
  await propose("I want to track deals, with a title and an amount", "createTable");
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
    console.log(`  FAIL apply failed — ${applied.reason}`);
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

  // --- put it back, using the stored reverse ---
  console.log("=== reverting with the stored down_sql ===");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(record!.downSql);
    await client.query(`UPDATE _meta.migrations SET reverted_at = now() WHERE id = $1`, [
      record!.id,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    failures++;
    console.log(`  FAIL revert failed — ${(err as Error).message}`);
  } finally {
    client.release();
  }

  const reverted = await introspectSchema();
  check(
    "schema is back to where it started",
    JSON.stringify(reverted) === JSON.stringify(before),
  );
  check("data still intact", (await rowCount("contacts")) === 2);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
