import { pool } from "@/db";
import type { Column, DbSchema, Table } from "./types";

/**
 * Maps Postgres' internal type names onto the vocabulary we expose.
 * `format_type` returns e.g. "timestamp with time zone"; we say "timestamptz".
 */
const TYPE_ALIASES: Record<string, string> = {
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "character varying": "text",
  "double precision": "numeric",
  int4: "integer",
  int8: "bigint",
};

function normalizeType(pgType: string): string {
  return TYPE_ALIASES[pgType] ?? pgType;
}

type Row = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_primary_key: boolean;
  ordinal_position: number;
};

/**
 * Reads the live schema from `public`. Internal tables live in `_meta`, so this
 * never sees them, see AGENTS.md.
 */
export async function introspectSchema(): Promise<DbSchema> {
  const { rows } = await pool.query<Row>(`
    SELECT
      c.table_name,
      c.column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      c.is_nullable,
      c.column_default,
      c.ordinal_position,
      COALESCE(pk.is_primary_key, false) AS is_primary_key
    FROM information_schema.columns c
    JOIN pg_class cls
      ON cls.relname = c.table_name
      AND cls.relnamespace = 'public'::regnamespace
    JOIN pg_attribute a
      ON a.attrelid = cls.oid
      AND a.attname = c.column_name
    LEFT JOIN (
      SELECT
        con.conrelid,
        unnest(con.conkey) AS attnum,
        true AS is_primary_key
      FROM pg_constraint con
      WHERE con.contype = 'p'
    ) pk
      ON pk.conrelid = cls.oid
      AND pk.attnum = a.attnum
    WHERE c.table_schema = 'public'
      AND cls.relkind = 'r'
    ORDER BY c.table_name, c.ordinal_position
  `);

  const byTable = new Map<string, Column[]>();

  for (const row of rows) {
    const column: Column = {
      name: row.column_name,
      type: normalizeType(row.data_type),
      nullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
      isPrimaryKey: row.is_primary_key,
    };

    const existing = byTable.get(row.table_name);
    if (existing) existing.push(column);
    else byTable.set(row.table_name, [column]);
  }

  const tables: Table[] = [...byTable.entries()].map(([name, columns]) => ({
    name,
    columns,
  }));

  return { tables };
}

/** Compact rendering of the schema, used as context for the model. */
export function formatSchemaForPrompt(schema: DbSchema): string {
  if (schema.tables.length === 0) {
    return "(the database has no tables yet)";
  }

  return schema.tables
    .map((table) => {
      const cols = table.columns
        .map((c) => {
          const flags = [
            c.isPrimaryKey ? "primary key" : null,
            c.nullable ? null : "not null",
          ]
            .filter(Boolean)
            .join(", ");
          return `  ${c.name} ${c.type}${flags ? ` (${flags})` : ""}`;
        })
        .join("\n");
      return `${table.name}:\n${cols}`;
    })
    .join("\n\n");
}
