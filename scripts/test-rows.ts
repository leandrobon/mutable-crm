import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { fetchTableData } from "@/lib/rows/read";
import { deleteRow, insertRow, updateCell } from "@/lib/rows/mutate";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const schema = await introspectSchema();

  // --- insert -------------------------------------------------------------
  const created = await insertRow(schema, "contacts", {
    email: "ada@example.com",
    full_name: "Ada Lovelace",
    score: "91.50",
    is_active: true,
  });
  check("insert a record", created.ok, created.ok ? `id=${created.id}` : created.reason);
  if (!created.ok) return;
  const id = created.id;

  // numeric(10,2) must survive the round trip
  const afterInsert = await fetchTableData(schema, "contacts");
  const row = afterInsert?.rows.find((r) => r.id === id);
  check("numeric(10,2) preserved", row?.cells.score === "91.50", String(row?.cells.score));
  check("boolean stays boolean", row?.cells.is_active === true, String(row?.cells.is_active));

  // --- update -------------------------------------------------------------
  const updated = await updateCell(schema, "contacts", id, "full_name", "Ada L.");
  check("update a cell", updated.ok, updated.ok ? "" : updated.reason);

  const nulled = await updateCell(schema, "contacts", id, "score", "");
  check("empty input clears a nullable cell", nulled.ok, nulled.ok ? "" : nulled.reason);

  // --- validation ---------------------------------------------------------
  const badNumber = await updateCell(schema, "contacts", id, "score", "not a number");
  check("rejects a non-numeric value", !badNumber.ok, badNumber.ok ? "" : badNumber.reason);

  const required = await updateCell(schema, "contacts", id, "email", "");
  check("rejects emptying a NOT NULL column", !required.ok, required.ok ? "" : required.reason);

  const missingRequired = await insertRow(schema, "contacts", { full_name: "No Email" });
  check(
    "rejects an insert missing a required column",
    !missingRequired.ok,
    missingRequired.ok ? "" : missingRequired.reason,
  );

  // --- the identifier boundary -------------------------------------------
  const injectedTable = await insertRow(
    schema,
    "contacts; DROP TABLE contacts; --",
    { email: "x@y.z" },
  );
  check(
    "unknown table name refused, not interpolated",
    !injectedTable.ok,
    injectedTable.ok ? "" : injectedTable.reason,
  );

  const injectedColumn = await updateCell(
    schema,
    "contacts",
    id,
    "full_name = 'pwned', email",
    "x",
  );
  check(
    "unknown column name refused",
    !injectedColumn.ok,
    injectedColumn.ok ? "" : injectedColumn.reason,
  );

  const stillThere = await pool.query(`SELECT to_regclass('public.contacts') IS NOT NULL AS ok`);
  check("contacts table survived both", stillThere.rows[0].ok === true);

  // A value that looks like SQL is just a value.
  const sqlish = await updateCell(schema, "contacts", id, "full_name", "'); DROP TABLE contacts; --");
  check("SQL-ish value stored literally", sqlish.ok, sqlish.ok ? "" : sqlish.reason);
  const still2 = await pool.query(`SELECT to_regclass('public.contacts') IS NOT NULL AS ok`);
  check("contacts table survived a SQL-ish value", still2.rows[0].ok === true);

  // --- managed columns ----------------------------------------------------
  const pk = await updateCell(schema, "contacts", id, "id", 999);
  check("refuses to edit id", !pk.ok, pk.ok ? "" : pk.reason);
  const ts = await updateCell(schema, "contacts", id, "created_at", "2020-01-01");
  check("refuses to edit created_at", !ts.ok, ts.ok ? "" : ts.reason);

  // --- missing row --------------------------------------------------------
  const ghost = await updateCell(schema, "contacts", 10_000_000, "full_name", "x");
  check("update on a missing row reports it", !ghost.ok, ghost.ok ? "" : ghost.reason);

  // --- pagination ---------------------------------------------------------
  const past = await fetchTableData(schema, "contacts", 999);
  check("page past the end clamps", past?.page === (past?.pageCount ?? 1) - 1, `page=${past?.page}`);

  // --- delete -------------------------------------------------------------
  const removed = await deleteRow(schema, "contacts", id);
  check("delete a record", removed.ok, removed.ok ? "" : removed.reason);
  const again = await deleteRow(schema, "contacts", id);
  check("deleting twice reports it", !again.ok, again.ok ? "" : again.reason);

  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
