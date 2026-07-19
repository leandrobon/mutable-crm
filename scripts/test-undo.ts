/**
 * The regression suite for undo.
 *
 * Applies a real stack of migrations against a scratch table with rows in it,
 * then reverts back down it: out-of-order refused, the reverse restoring the
 * schema byte for byte, data surviving, a lossy reverse failing loudly instead
 * of truncating.
 *
 * No model, no API credits. Everything it creates — the table, the history
 * rows, the .sql files — is removed at the end, so it can be run repeatedly.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { planMigration } from "@/lib/migrations/sql";
import { applyMigration, revertMigration } from "@/lib/migrations/apply";
import { describeRevert, undoableId } from "@/lib/migrations/revert";
import type { ToolCall } from "@/lib/migrations/tools";

const TABLE = "undo_probe";
/** Created by the multi-table case at the end, dropped by cleanup if it fails. */
const BATCH_TABLES = ["undo_probe_barns", "undo_probe_herds"];

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fingerprint(schema: Awaited<ReturnType<typeof introspectSchema>>) {
  return JSON.stringify(schema);
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

/** Everything this script creates, so it can undo itself at the end. */
const created: { id: number; filename: string }[] = [];

/** Applies a change through the real path — plan, then apply — and returns the
 *  history row it wrote. */
async function applyStep(call: ToolCall): Promise<number> {
  const schema = await introspectSchema();
  // createTables acts on no existing table, so there are no rows to count.
  const subject = "tableName" in call.args ? call.args.tableName : null;
  const plan = planMigration(
    call,
    schema,
    subject ? await rowCount(subject) : 0,
  );
  if (!plan.ok) throw new Error(`setup failed to plan: ${plan.reason}`);

  const result = await applyMigration(plan.proposal);
  if (!result.ok) throw new Error(`setup failed to apply: ${result.reason}`);

  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM _meta.migrations WHERE filename = $1`,
    [result.filename],
  );
  created.push({ id: rows[0].id, filename: result.filename });
  return rows[0].id;
}

async function revertedAt(id: number): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT reverted_at FROM _meta.migrations WHERE id = $1`,
    [id],
  );
  return rows[0]?.reverted_at ?? null;
}

async function cleanup() {
  for (const name of [TABLE, ...BATCH_TABLES]) {
    await pool.query(`DROP TABLE IF EXISTS ${name}`);
  }
  for (const { id, filename } of created) {
    await pool.query(`DELETE FROM _meta.migrations WHERE id = $1`, [id]);
    await unlink(join(process.cwd(), "migrations", filename)).catch(() => {});
  }
}

async function main() {
  await cleanup(); // in case a previous run died half way

  /* ---- setup: a three-migration stack on a table that has data ---------- */

  console.log("# setup");

  const createId = await applyStep({
    name: "createTable",
    args: {
      tableName: TABLE,
      columns: [
        { name: "title", type: "text", nullable: false },
        { name: "score", type: "numeric", nullable: true },
      ],
    },
  });

  await pool.query(
    `INSERT INTO ${TABLE} (title, score) VALUES ('first', 10), ('second', 20)`,
  );

  const addId = await applyStep({
    name: "addColumn",
    args: { tableName: TABLE, columnName: "note", type: "text", nullable: true },
  });

  await pool.query(`UPDATE ${TABLE} SET note = 'written by hand'`);

  // The schema as it is with two migrations applied — reverting the third must
  // come back to exactly this.
  const afterTwo = fingerprint(await introspectSchema());

  const renameId = await applyStep({
    name: "renameColumn",
    args: { tableName: TABLE, from: "title", to: "name" },
  });

  console.log(`  applied ${createId}, ${addId}, ${renameId} on ${TABLE}`);
  check("the table has rows to protect", (await rowCount(TABLE)) === 2);

  /* ---- out of order is refused before any SQL runs ---------------------- */

  console.log("\n# reverting anything but the top of the stack");

  const beforeRefusal = fingerprint(await introspectSchema());
  const outOfOrder = await revertMigration(addId);

  check("refused", !outOfOrder.ok);
  if (!outOfOrder.ok) console.log(`  reason: ${outOfOrder.reason}`);
  check(
    "names the change that has to go first",
    !outOfOrder.ok && outOfOrder.reason.includes("title"),
    !outOfOrder.ok ? outOfOrder.reason : "",
  );
  check(
    "the schema was not touched",
    fingerprint(await introspectSchema()) === beforeRefusal,
  );
  check("and it is still in effect", (await revertedAt(addId)) === null);

  /* ---- reverting the top restores the schema exactly -------------------- */

  console.log("\n# reverting the newest change");

  const undoRename = await revertMigration(renameId);
  check("succeeded", undoRename.ok, undoRename.ok ? "" : undoRename.reason);
  check(
    "the schema is byte-identical to before it was applied",
    fingerprint(await introspectSchema()) === afterTwo,
  );
  check("the rows are untouched", (await rowCount(TABLE)) === 2);
  check("it is marked reverted", (await revertedAt(renameId)) !== null);

  const values = await pool.query<{ note: string }>(
    `SELECT note FROM ${TABLE} ORDER BY id LIMIT 1`,
  );
  check(
    "values written by hand survived the undo",
    values.rows[0].note === "written by hand",
  );

  /* ---- undoing the same thing twice ------------------------------------ */

  console.log("\n# undoing something already undone");

  const again = await revertMigration(renameId);
  check("refused", !again.ok);
  if (!again.ok) console.log(`  reason: ${again.reason}`);

  const missing = await revertMigration(2_000_000_000);
  check("an id that is not in the history is refused", !missing.ok);

  /* ---- undoing addColumn drops the column, keeps the rows --------------- */

  console.log("\n# undoing a column that has values in it");

  const plan = describeRevert({
    toolName: "addColumn",
    toolArgs: { tableName: TABLE, columnName: "note", type: "text", nullable: true },
  });
  check("is described as destructive", plan.destructive);
  check("and says the values go", plan.impact.join(" ").includes("deleted"));

  const undoAdd = await revertMigration(addId);
  check("succeeded", undoAdd.ok, undoAdd.ok ? "" : undoAdd.reason);

  const schemaNow = await introspectSchema();
  const probe = schemaNow.tables.find((t) => t.name === TABLE);
  check(
    "the column is gone",
    probe !== undefined && !probe.columns.some((c) => c.name === "note"),
  );
  check("the rows are still there", (await rowCount(TABLE)) === 2);

  /* ---- a reverse that would lose data fails, and changes nothing -------- */

  console.log("\n# a reverse that no longer fits the data");

  const typeId = await applyStep({
    name: "changeColumnType",
    args: { tableName: TABLE, columnName: "score", newType: "text" },
  });

  // Only possible now that the column is text. Going back to numeric cannot
  // work, and must not half-work.
  await pool.query(`INSERT INTO ${TABLE} (title, score) VALUES ('third', 'n/a')`);

  const beforeLossy = fingerprint(await introspectSchema());
  const lossy = await revertMigration(typeId);

  check("refused rather than truncating", !lossy.ok);
  if (!lossy.ok) console.log(`  reason: ${lossy.reason}`);
  check(
    "the schema is unchanged",
    fingerprint(await introspectSchema()) === beforeLossy,
  );
  check("the migration is still in effect", (await revertedAt(typeId)) === null);
  check("the row that caused it is still there", (await rowCount(TABLE)) === 3);

  /* ---- undoing several tables created together -------------------------- */

  console.log("\n# undoing a change that created several tables");

  const batchId = await applyStep({
    name: "createTables",
    args: {
      tables: [
        {
          tableName: BATCH_TABLES[0],
          columns: [{ name: "name", type: "text", nullable: false }],
        },
        {
          tableName: BATCH_TABLES[1],
          columns: [{ name: "head_count", type: "integer", nullable: true }],
        },
      ],
    },
  });

  const withBatch = await introspectSchema();
  check(
    "both tables exist after applying",
    BATCH_TABLES.every((n) => withBatch.tables.some((t) => t.name === n)),
  );

  // Rows in them, because dropping empty tables proves nothing.
  await pool.query(`INSERT INTO ${BATCH_TABLES[0]} (name) VALUES ('north barn')`);
  await pool.query(`INSERT INTO ${BATCH_TABLES[1]} (head_count) VALUES (42)`);

  const batchPlan = describeRevert({
    toolName: "createTables",
    toolArgs: {
      tables: BATCH_TABLES.map((n) => ({
        tableName: n,
        // A real column: the schema requires at least one, and an empty list
        // would fail to parse and silently fall back to the generic wording.
        columns: [{ name: "name", type: "text", nullable: true }],
      })),
    },
  });
  check("undoing it is described as destructive", batchPlan.destructive);
  check(
    "and names both tables",
    BATCH_TABLES.every((n) => batchPlan.summary.includes(n)),
    batchPlan.summary,
  );

  const undoBatch = await revertMigration(batchId);
  check("undo succeeded", undoBatch.ok, undoBatch.ok ? "" : undoBatch.reason);

  const withoutBatch = await introspectSchema();
  check(
    "both tables are gone, in one undo",
    BATCH_TABLES.every((n) => !withoutBatch.tables.some((t) => t.name === n)),
  );

  /* ---- undoableId agrees with what the server enforces ------------------ */

  console.log("\n# which change the UI offers");

  const records = (
    await pool.query(
      `SELECT id, reverted_at FROM _meta.migrations ORDER BY id DESC`,
    )
  ).rows.map((r) => ({
    id: r.id as number,
    revertedAt: r.reverted_at as Date | null,
  }));

  check(
    "the newest change still in effect is the one on offer",
    undoableId(records) === typeId,
    `got ${undoableId(records)}, expected ${typeId}`,
  );

  await cleanup();

  console.log(
    failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`,
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
