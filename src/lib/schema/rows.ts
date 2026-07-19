import { pool } from "@/db";
import type { DbSchema, Table } from "./types";

export type TableData = {
  table: Table;
  rows: Record<string, string | null>[];
  totalRows: number;
};

/** How many rows the panel shows per table. */
const ROW_LIMIT = 25;

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Reads the rows of one table for display.
 *
 * The table name is not interpolated from user input — it comes from the
 * introspected schema, and we look it up there first. That lookup is what makes
 * the interpolation safe; there is no other path into this string.
 */
export async function fetchTableData(
  schema: DbSchema,
  tableName: string,
): Promise<TableData | null> {
  const table = schema.tables.find((t) => t.name === tableName);
  if (!table) return null;

  const { rows: countRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table.name}`,
  );

  const { rows } = await pool.query(
    `SELECT * FROM ${table.name} ORDER BY id DESC LIMIT ${ROW_LIMIT}`,
  );

  return {
    table,
    totalRows: countRows[0].n,
    rows: rows.map((row) => {
      const formatted: Record<string, string | null> = {};
      for (const column of table.columns) {
        formatted[column.name] = formatValue(row[column.name]);
      }
      return formatted;
    }),
  };
}

/** Every table with its rows, in schema order. */
export async function fetchAllTableData(schema: DbSchema): Promise<TableData[]> {
  const results = await Promise.all(
    schema.tables.map((t) => fetchTableData(schema, t.name)),
  );
  return results.filter((r): r is TableData => r !== null);
}
