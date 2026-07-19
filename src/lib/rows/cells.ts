import type { Column, Table } from "@/lib/schema/types";

/**
 * Row types and the pure helpers over them.
 *
 * Deliberately free of any database import. Both views are client components
 * and need `formatCell` and `baseType` to render; if these lived beside the
 * queries, importing them would pull `pg` into the browser bundle, which fails
 * to build. Reading rows is in `read.ts`, writing them in `mutate.ts`, both
 * server-only, both importing from here.
 */

/**
 * A cell as it travels to the client: JSON-serializable, and still typed enough
 * to put in the right kind of input.
 *
 * These are raw values, not display strings. The CRM view writes cells back to
 * the database, and formatting a boolean to "yes" on the way out would mean
 * parsing "yes" back to a boolean on the way in, a lossy round trip through a
 * human-readable form. Each view formats at render time instead.
 */
export type CellValue = string | number | boolean | null;

export type RowRecord = {
  /** Every table has one; it is what update and delete target. */
  id: number;
  cells: Record<string, CellValue>;
};

export type TableData = {
  table: Table;
  rows: RowRecord[];
  totalRows: number;
  page: number;
  pageCount: number;
};

/** The base type without its modifier: "numeric(10,2)" -> "numeric". */
export function baseType(type: string): string {
  return type.replace(/\(.*$/, "").trim();
}

/**
 * `id` and `created_at` are created by us on every table and the model cannot
 * touch them; the user does not get to edit them by hand either.
 */
export function isEditable(column: Column): boolean {
  return !column.isPrimaryKey && column.name !== "created_at";
}

/** How a cell reads on screen. Both views share this; neither writes it back. */
export function formatCell(value: CellValue, type: string): string | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (baseType(type) === "timestamptz" && typeof value === "string") {
    return value.replace("T", " ").slice(0, 19);
  }
  return String(value);
}
