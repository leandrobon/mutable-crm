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

/**
 * Last line of defence before an identifier reaches a SQL string.
 *
 * Identifiers cannot be parameterized in Postgres, so every table and column
 * name that gets interpolated goes through here first. Callers have already
 * validated the name (the tool schemas upstream of a migration, the
 * introspected schema upstream of a row edit), so reaching this throw means a
 * bug upstream, not bad input. It lives here rather than in the migrations
 * engine because the rows layer needs it too.
 */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`Refusing to build SQL with the identifier "${name}".`);
  }
  return name;
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
