import { pool } from "@/db";
import type { Column, DbSchema, Table } from "@/lib/schema/types";
import { baseType, isEditable, type CellValue } from "./cells";

/**
 * Writing rows.
 *
 * This is data, not schema: nothing here produces a migration, writes a file,
 * or touches `_meta.migrations`. The model is not involved at any point, these
 * run from direct user action in the CRM view. The two rules in AGENTS.md are
 * about schema changes and are untouched by this file, which is exactly why
 * row editing does not need a propose/apply cycle.
 *
 * Two separate concerns keep the SQL safe, and they are not interchangeable:
 *
 * - Identifiers (table and column names) cannot be parameterized in Postgres,
 *   so every one is resolved against the introspected schema first. The string
 *   that reaches the SQL came from pg_catalog, never from the request. An
 *   unknown name is an error, not an escaped identifier.
 * - Values are always parameters. They are never interpolated, whatever they
 *   contain.
 */

export type MutateResult =
  | { ok: true; id: number }
  | { ok: false; reason: string };

type Resolved = { table: Table; column: Column };

function resolveTable(schema: DbSchema, tableName: unknown): Table | null {
  if (typeof tableName !== "string") return null;
  return schema.tables.find((t) => t.name === tableName) ?? null;
}

function resolveColumn(table: Table, columnName: unknown): Column | null {
  if (typeof columnName !== "string") return null;
  return table.columns.find((c) => c.name === columnName) ?? null;
}

function resolve(
  schema: DbSchema,
  tableName: unknown,
  columnName: unknown,
): Resolved | { error: string } {
  const table = resolveTable(schema, tableName);
  if (!table)
    return { error: `There is no table called "${String(tableName)}".` };

  const column = resolveColumn(table, columnName);
  if (!column) {
    return { error: `"${table.name}" has no column "${String(columnName)}".` };
  }
  if (!isEditable(column)) {
    return {
      error: `"${column.name}" is managed automatically and cannot be edited.`,
    };
  }
  return { table, column };
}

type Coerced = { ok: true; value: CellValue } | { ok: false; reason: string };

/**
 * Turns what the form sent into a value Postgres will accept for this column.
 *
 * We validate here rather than letting the cast fail in the database, so a
 * mistyped number comes back as a sentence instead of a driver error. An empty
 * input means null: in a form there is no way to type "absent" otherwise.
 */
export function coerce(column: Column, input: unknown): Coerced {
  const empty =
    input === null ||
    input === undefined ||
    (typeof input === "string" && input.trim() === "");

  if (empty) {
    if (!column.nullable) {
      return { ok: false, reason: `${column.name} is required.` };
    }
    return { ok: true, value: null };
  }

  const type = baseType(column.type);
  const text = typeof input === "string" ? input.trim() : input;

  switch (type) {
    case "boolean": {
      if (typeof text === "boolean") return { ok: true, value: text };
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false, reason: `${column.name} must be true or false.` };
    }

    case "integer":
    case "bigint": {
      const asString = String(text);
      if (!/^-?\d+$/.test(asString)) {
        return { ok: false, reason: `${column.name} must be a whole number.` };
      }
      return { ok: true, value: asString };
    }

    case "numeric": {
      const asString = String(text);
      if (!/^-?\d+(\.\d+)?$/.test(asString)) {
        return { ok: false, reason: `${column.name} must be a number.` };
      }
      return { ok: true, value: asString };
    }

    case "date": {
      const asString = String(text);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asString)) {
        return {
          ok: false,
          reason: `${column.name} must be a date (YYYY-MM-DD).`,
        };
      }
      return { ok: true, value: asString };
    }

    case "uuid": {
      const asString = String(text);
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuid.test(asString)) {
        return { ok: false, reason: `${column.name} must be a UUID.` };
      }
      return { ok: true, value: asString };
    }

    case "timestamptz":
    case "timestamp": {
      const asString = String(text);
      if (Number.isNaN(Date.parse(asString))) {
        return {
          ok: false,
          reason: `${column.name} is not a valid date and time.`,
        };
      }
      return { ok: true, value: asString };
    }

    default:
      // text, and anything introspection surfaced that we do not special-case.
      return { ok: true, value: String(text) };
  }
}

/**
 * Inserts a row.
 *
 * Columns the user left empty are omitted rather than sent as null, so a column
 * with a default gets its default instead of being overwritten with nothing.
 */
export async function insertRow(
  schema: DbSchema,
  tableName: string,
  values: Record<string, unknown>,
): Promise<MutateResult> {
  const table = resolveTable(schema, tableName);
  if (!table)
    return { ok: false, reason: `There is no table called "${tableName}".` };

  const columns: string[] = [];
  const params: CellValue[] = [];

  for (const column of table.columns) {
    if (!isEditable(column)) continue;

    const raw = values[column.name];
    const provided =
      raw !== undefined && !(typeof raw === "string" && raw.trim() === "");

    if (!provided) {
      // Nothing typed. Fine if the database can fill it in; not if it can't.
      if (column.nullable || column.defaultValue !== null) continue;
      return { ok: false, reason: `${column.name} is required.` };
    }

    const coerced = coerce(column, raw);
    if (!coerced.ok) return { ok: false, reason: coerced.reason };

    columns.push(column.name);
    params.push(coerced.value);
  }

  const sql =
    columns.length === 0
      ? `INSERT INTO ${table.name} DEFAULT VALUES RETURNING id`
      : `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${columns
          .map((_, i) => `$${i + 1}`)
          .join(", ")}) RETURNING id`;

  try {
    const { rows } = await pool.query<{ id: number }>(sql, params);
    return { ok: true, id: Number(rows[0].id) };
  } catch (err) {
    return { ok: false, reason: dbMessage(err) };
  }
}

/** Updates a single cell. The CRM view saves one cell at a time. */
export async function updateCell(
  schema: DbSchema,
  tableName: string,
  rowId: number,
  columnName: string,
  input: unknown,
): Promise<MutateResult> {
  const found = resolve(schema, tableName, columnName);
  if ("error" in found) return { ok: false, reason: found.error };

  const { table, column } = found;

  const coerced = coerce(column, input);
  if (!coerced.ok) return { ok: false, reason: coerced.reason };

  try {
    const { rowCount } = await pool.query(
      `UPDATE ${table.name} SET ${column.name} = $1 WHERE id = $2`,
      [coerced.value, rowId],
    );
    if (rowCount === 0) {
      return { ok: false, reason: "That record no longer exists." };
    }
    return { ok: true, id: rowId };
  } catch (err) {
    return { ok: false, reason: dbMessage(err) };
  }
}

export async function deleteRow(
  schema: DbSchema,
  tableName: string,
  rowId: number,
): Promise<MutateResult> {
  const table = resolveTable(schema, tableName);
  if (!table)
    return { ok: false, reason: `There is no table called "${tableName}".` };

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ${table.name} WHERE id = $1`,
      [rowId],
    );
    if (rowCount === 0) {
      return { ok: false, reason: "That record no longer exists." };
    }
    return { ok: true, id: rowId };
  } catch (err) {
    return { ok: false, reason: dbMessage(err) };
  }
}

/** Postgres errors that are the user's problem, phrased as such. */
function dbMessage(err: unknown): string {
  const code = (err as { code?: string }).code;
  switch (code) {
    case "23505":
      return "That value has to be unique, and another record already uses it.";
    case "23502":
      return "That field is required.";
    case "23503":
      return "Another record refers to this one.";
    case "22P02":
    case "22003":
      return "That value does not fit the column's type.";
    default:
      return (err as Error).message;
  }
}
