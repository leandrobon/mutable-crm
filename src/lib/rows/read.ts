import { pool } from "@/db";
import type { DbSchema } from "@/lib/schema/types";
import { baseType, type CellValue, type TableData } from "./cells";

export const PAGE_SIZE = 25;

/** pg's driver returns Dates and numerics-as-strings; flatten to plain JSON. */
function toCell(value: unknown, type: string): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // A date column has no meaningful time part, and <input type="date">
    // expects exactly this shape.
    return baseType(type) === "date"
      ? value.toISOString().slice(0, 10)
      : value.toISOString();
  }
  if (typeof value === "boolean" || typeof value === "number") return value;
  return String(value);
}

/**
 * Reads one page of a table.
 *
 * The table name is not interpolated from user input. It comes from the
 * introspected schema, and we look it up there first. That lookup is what makes
 * the interpolation safe; there is no other path into this string.
 */
export async function fetchTableData(
  schema: DbSchema,
  tableName: string,
  page = 0,
): Promise<TableData | null> {
  const table = schema.tables.find((t) => t.name === tableName);
  if (!table) return null;

  const { rows: countRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table.name}`,
  );
  const totalRows = countRows[0].n;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  // A page that no longer exists (rows were deleted, or the client asked for
  // one past the end) reads as the last page rather than as an empty table.
  const safePage = Math.min(Math.max(0, page), pageCount - 1);

  const { rows } = await pool.query(
    `SELECT * FROM ${table.name} ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, safePage * PAGE_SIZE],
  );

  return {
    table,
    totalRows,
    page: safePage,
    pageCount,
    rows: rows.map((row) => {
      const cells: Record<string, CellValue> = {};
      for (const column of table.columns) {
        cells[column.name] = toCell(row[column.name], column.type);
      }
      return { id: Number(row.id), cells };
    }),
  };
}

/** Every table with its first page of rows, in schema order. */
export async function fetchAllTableData(schema: DbSchema): Promise<TableData[]> {
  const results = await Promise.all(
    schema.tables.map((t) => fetchTableData(schema, t.name)),
  );
  return results.filter((r): r is TableData => r !== null);
}
