/**
 * The regression suite for row editing: insert, update, delete against a
 * populated table, numeric(10,2) surviving the round trip, the validation
 * rejections, page clamping, and the identifier boundary.
 *
 * Creates its own table and drops it again, so it runs on an empty database,
 * never touches the user's data, and depends on no fixture that has to be set
 * up by hand.
 *
 * No model, no API credits.
 */
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { fetchTableData } from "@/lib/rows/read";
import { deleteRow, insertRow, updateCell } from "@/lib/rows/mutate";

/** Named so it cannot collide with anything the user made. */
const TABLE = "rows_probe";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

/**
 * The shape the checks below assume: a required column, a nullable one, a
 * numeric with precision to prove it survives, and a boolean.
 */
async function setup() {
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await pool.query(`
    CREATE TABLE ${TABLE} (
      id         serial PRIMARY KEY,
      email      text NOT NULL,
      full_name  text,
      score      numeric(10,2),
      is_active  boolean DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    INSERT INTO ${TABLE} (email, full_name, score, is_active) VALUES
      ('ana@example.com', 'Ana Ruiz', 91.50, true),
      ('bo@example.com',  'Bo Chen',  44.25, true);
  `);
}

async function cleanup() {
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
}

async function main() {
  await setup();

  const schema = await introspectSchema();

  // --- insert -------------------------------------------------------------
  const created = await insertRow(schema, TABLE, {
    email: "ada@example.com",
    full_name: "Ada Lovelace",
    score: "91.50",
    is_active: true,
  });
  check("insert a record", created.ok, created.ok ? `id=${created.id}` : created.reason);
  if (!created.ok) return;
  const id = created.id;

  // numeric(10,2) must survive the round trip
  const afterInsert = await fetchTableData(schema, TABLE);
  const row = afterInsert?.rows.find((r) => r.id === id);
  check("numeric(10,2) preserved", row?.cells.score === "91.50", String(row?.cells.score));
  check("boolean stays boolean", row?.cells.is_active === true, String(row?.cells.is_active));

  // --- update -------------------------------------------------------------
  const updated = await updateCell(schema, TABLE, id, "full_name", "Ada L.");
  check("update a cell", updated.ok, updated.ok ? "" : updated.reason);

  const nulled = await updateCell(schema, TABLE, id, "score", "");
  check("empty input clears a nullable cell", nulled.ok, nulled.ok ? "" : nulled.reason);

  // --- validation ---------------------------------------------------------
  const badNumber = await updateCell(schema, TABLE, id, "score", "not a number");
  check("rejects a non-numeric value", !badNumber.ok, badNumber.ok ? "" : badNumber.reason);

  const required = await updateCell(schema, TABLE, id, "email", "");
  check("rejects emptying a NOT NULL column", !required.ok, required.ok ? "" : required.reason);

  const missingRequired = await insertRow(schema, TABLE, { full_name: "No Email" });
  check(
    "rejects an insert missing a required column",
    !missingRequired.ok,
    missingRequired.ok ? "" : missingRequired.reason,
  );

  // --- the identifier boundary -------------------------------------------
  const injectedTable = await insertRow(
    schema,
    `${TABLE}; DROP TABLE ${TABLE}; --`,
    { email: "x@y.z" },
  );
  check(
    "unknown table name refused, not interpolated",
    !injectedTable.ok,
    injectedTable.ok ? "" : injectedTable.reason,
  );

  const injectedColumn = await updateCell(
    schema,
    TABLE,
    id,
    "full_name = 'pwned', email",
    "x",
  );
  check(
    "unknown column name refused",
    !injectedColumn.ok,
    injectedColumn.ok ? "" : injectedColumn.reason,
  );

  const stillThere = await pool.query(
    `SELECT to_regclass('public.${TABLE}') IS NOT NULL AS ok`,
  );
  check("the table survived both", stillThere.rows[0].ok === true);

  // A value that looks like SQL is just a value.
  const sqlish = await updateCell(
    schema,
    TABLE,
    id,
    "full_name",
    `'); DROP TABLE ${TABLE}; --`,
  );
  check("SQL-ish value stored literally", sqlish.ok, sqlish.ok ? "" : sqlish.reason);
  const still2 = await pool.query(
    `SELECT to_regclass('public.${TABLE}') IS NOT NULL AS ok`,
  );
  check("the table survived a SQL-ish value", still2.rows[0].ok === true);

  // --- managed columns ----------------------------------------------------
  const pk = await updateCell(schema, TABLE, id, "id", 999);
  check("refuses to edit id", !pk.ok, pk.ok ? "" : pk.reason);
  const ts = await updateCell(schema, TABLE, id, "created_at", "2020-01-01");
  check("refuses to edit created_at", !ts.ok, ts.ok ? "" : ts.reason);

  // --- missing row --------------------------------------------------------
  const ghost = await updateCell(schema, TABLE, 10_000_000, "full_name", "x");
  check("update on a missing row reports it", !ghost.ok, ghost.ok ? "" : ghost.reason);

  // --- pagination ---------------------------------------------------------
  const past = await fetchTableData(schema, TABLE, 999);
  check("page past the end clamps", past?.page === (past?.pageCount ?? 1) - 1, `page=${past?.page}`);

  // --- delete -------------------------------------------------------------
  const removed = await deleteRow(schema, TABLE, id);
  check("delete a record", removed.ok, removed.ok ? "" : removed.reason);
  const again = await deleteRow(schema, TABLE, id);
  check("deleting twice reports it", !again.ok, again.ok ? "" : again.reason);

  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .then(async () => {
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(failures === 0 ? 0 : 1);
  });
