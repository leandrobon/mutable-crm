/** The subset of Postgres types this app is allowed to work with. */
export const ALLOWED_TYPES = [
  "text",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "date",
  "timestamptz",
  "uuid",
] as const;

export type AllowedType = (typeof ALLOWED_TYPES)[number];

export function isAllowedType(value: string): value is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(value);
}

export type Column = {
  name: string;
  /** Normalized to one of ALLOWED_TYPES when possible, else the raw Postgres type. */
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
};

export type Table = {
  name: string;
  columns: Column[];
};

export type DbSchema = {
  tables: Table[];
};
