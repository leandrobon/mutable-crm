import type { DbSchema, Table } from "@/lib/schema/types";
import type { ToolCall } from "./tools";

/** Columns every table gets automatically. They are not the model's to touch. */
export const RESERVED_COLUMNS = ["id", "created_at"] as const;

export type Proposal = {
  toolName: ToolCall["name"];
  args: ToolCall["args"];
  /** One sentence, plain language, derived from the arguments. */
  summary: string;
  /** What this does to the rows already in the table. */
  impact: string[];
  upSql: string;
  downSql: string;
};

export type PlanResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: string };

/**
 * Last line of defence before an identifier reaches a SQL string. The tool
 * schemas already enforce this shape, so reaching this throw means a bug
 * upstream, not bad input from the model.
 */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`Refusing to build SQL with the identifier "${name}".`);
  }
  return name;
}

function findTable(schema: DbSchema, name: string): Table | undefined {
  return schema.tables.find((t) => t.name === name);
}

type NewColumn = { name: string; type: string; nullable: boolean };

/**
 * Validates one table definition and returns its CREATE statement.
 *
 * Shared by `createTables` and the legacy `createTable`, so the two cannot
 * drift: whatever a single table is checked for, each table in a batch is
 * checked for identically.
 *
 * `alreadyTaken` carries the names claimed earlier in the same request. The
 * live schema cannot catch a batch that asks for the same table twice, because
 * neither one exists yet.
 */
function planOneTable(
  tableName: string,
  columns: NewColumn[],
  schema: DbSchema,
  alreadyTaken: Set<string>,
): { ok: true; sql: string } | { ok: false; reason: string } {
  if (findTable(schema, tableName)) {
    return { ok: false, reason: `The table "${tableName}" already exists.` };
  }
  if (alreadyTaken.has(tableName)) {
    return {
      ok: false,
      reason: `"${tableName}" is listed twice in the same change.`,
    };
  }

  const seen = new Set<string>();
  for (const column of columns) {
    if (RESERVED_COLUMNS.includes(column.name as "id")) {
      return {
        ok: false,
        reason: `"${column.name}" is added automatically, so it cannot be listed as a column of "${tableName}".`,
      };
    }
    if (seen.has(column.name)) {
      return {
        ok: false,
        reason: `The column "${column.name}" is listed twice on "${tableName}".`,
      };
    }
    seen.add(column.name);
  }

  const columnSql = columns
    .map((c) => `  ${ident(c.name)} ${c.type}${c.nullable ? "" : " NOT NULL"}`)
    .join(",\n");

  return {
    ok: true,
    sql: [
      `CREATE TABLE ${ident(tableName)} (`,
      `  id serial PRIMARY KEY,`,
      `${columnSql},`,
      `  created_at timestamptz NOT NULL DEFAULT now()`,
      `);`,
    ].join("\n"),
  };
}

function fieldsPhrase(columns: NewColumn[]): string {
  return `${columns.length} ${columns.length === 1 ? "field" : "fields"}: ${columns
    .map((c) => c.name)
    .join(", ")}`;
}

function rowsPhrase(rowCount: number): string {
  if (rowCount === 0) return "The table is empty.";
  if (rowCount === 1) return "There is 1 row in the table.";
  return `There are ${rowCount} rows in the table.`;
}

/**
 * Turns the operation the model chose into SQL, its reverse, and a description.
 * Pure: everything it needs comes from the live schema and the row count.
 */
export function planMigration(
  call: ToolCall,
  schema: DbSchema,
  rowCount: number,
): PlanResult {
  switch (call.name) {
    case "createTables": {
      const { tables } = call.args;

      const taken = new Set<string>();
      const statements: string[] = [];

      for (const table of tables) {
        const planned = planOneTable(
          table.tableName,
          table.columns,
          schema,
          taken,
        );
        // One bad table rejects the whole request. These are created in a
        // single transaction, so there is no such thing as applying the good
        // half, and a partial CRM is worse than a clear refusal.
        if (!planned.ok) return planned;

        taken.add(table.tableName);
        statements.push(planned.sql);
      }

      const names = tables.map((t) => t.tableName);

      return {
        ok: true,
        proposal: {
          toolName: call.name,
          args: call.args,
          summary:
            tables.length === 1
              ? `Create a table "${names[0]}" with ${fieldsPhrase(tables[0].columns)}.`
              : `Create ${tables.length} tables: ${names.join(", ")}.`,
          impact: [
            tables.length === 1
              ? "No existing data is affected: this is a new table."
              : "No existing data is affected: these are new tables.",
            // Only worth listing per table when there are several. For one, the
            // summary above already says exactly this.
            ...(tables.length > 1
              ? tables.map((t) => `${t.tableName}: ${fieldsPhrase(t.columns)}.`)
              : []),
            tables.length === 1
              ? "An id primary key and a created_at timestamp are added automatically."
              : "Each one gets an id primary key and a created_at timestamp automatically.",
            ...(tables.length > 1
              ? [
                  "All of them are created together: if any one fails, none are created.",
                  "Undoing this drops all of them, with everything in them.",
                ]
              : []),
          ],
          upSql: statements.join("\n\n"),
          // Reverse order, so this still reads correctly the day tables can
          // reference each other and the last one created must go first.
          downSql: [...names]
            .reverse()
            .map((name) => `DROP TABLE ${ident(name)};`)
            .join("\n"),
        },
      };
    }

    // The single-table form. Not offered to the model, kept so a history row
    // holding arguments in this shape can still be re-planned. See tools.ts.
    case "createTable": {
      const { tableName, columns } = call.args;

      const planned = planOneTable(tableName, columns, schema, new Set());
      if (!planned.ok) return planned;

      return {
        ok: true,
        proposal: {
          toolName: call.name,
          args: call.args,
          summary: `Create a table "${tableName}" with ${fieldsPhrase(columns)}.`,
          impact: [
            "No existing data is affected: this is a new table.",
            "An id primary key and a created_at timestamp are added automatically.",
          ],
          upSql: planned.sql,
          downSql: `DROP TABLE ${ident(tableName)};`,
        },
      };
    }

    case "addColumn": {
      const { tableName, columnName, type, nullable } = call.args;

      const table = findTable(schema, tableName);
      if (!table) {
        return { ok: false, reason: `There is no table called "${tableName}".` };
      }
      if (table.columns.some((c) => c.name === columnName)) {
        return {
          ok: false,
          reason: `"${tableName}" already has a column called "${columnName}".`,
        };
      }
      // Postgres cannot fill existing rows, so this would fail on apply.
      if (!nullable && rowCount > 0) {
        return {
          ok: false,
          reason: `"${columnName}" cannot be required: "${tableName}" already has ${rowCount} ${
            rowCount === 1 ? "row" : "rows"
          } and there would be no value to put in them. Add it as optional instead.`,
        };
      }

      return {
        ok: true,
        proposal: {
          toolName: call.name,
          args: call.args,
          summary: `Add ${
            nullable ? "an optional" : "a required"
          } ${type} field "${columnName}" to "${tableName}".`,
          impact: [
            `${rowsPhrase(rowCount)} ${
              rowCount > 0
                ? `Every existing row gets "${columnName}" set to null.`
                : ""
            }`.trim(),
            "No existing values are modified.",
          ],
          upSql: `ALTER TABLE ${ident(tableName)} ADD COLUMN ${ident(
            columnName,
          )} ${type}${nullable ? "" : " NOT NULL"};`,
          downSql: `ALTER TABLE ${ident(tableName)} DROP COLUMN ${ident(
            columnName,
          )};`,
        },
      };
    }

    case "renameColumn": {
      const { tableName, from, to } = call.args;

      const table = findTable(schema, tableName);
      if (!table) {
        return { ok: false, reason: `There is no table called "${tableName}".` };
      }
      if (RESERVED_COLUMNS.includes(from as "id")) {
        return { ok: false, reason: `"${from}" is managed automatically and cannot be renamed.` };
      }
      if (!table.columns.some((c) => c.name === from)) {
        return {
          ok: false,
          reason: `"${tableName}" has no column called "${from}".`,
        };
      }
      if (table.columns.some((c) => c.name === to)) {
        return {
          ok: false,
          reason: `"${tableName}" already has a column called "${to}".`,
        };
      }

      return {
        ok: true,
        proposal: {
          toolName: call.name,
          args: call.args,
          summary: `Rename "${from}" to "${to}" on "${tableName}".`,
          impact: [
            `${rowsPhrase(rowCount)} No values change, only the name of the field.`,
          ],
          upSql: `ALTER TABLE ${ident(tableName)} RENAME COLUMN ${ident(
            from,
          )} TO ${ident(to)};`,
          downSql: `ALTER TABLE ${ident(tableName)} RENAME COLUMN ${ident(
            to,
          )} TO ${ident(from)};`,
        },
      };
    }

    case "changeColumnType": {
      const { tableName, columnName, newType } = call.args;

      const table = findTable(schema, tableName);
      if (!table) {
        return { ok: false, reason: `There is no table called "${tableName}".` };
      }
      if (RESERVED_COLUMNS.includes(columnName as "id")) {
        return {
          ok: false,
          reason: `"${columnName}" is managed automatically and its type cannot be changed.`,
        };
      }
      const column = table.columns.find((c) => c.name === columnName);
      if (!column) {
        return {
          ok: false,
          reason: `"${tableName}" has no column called "${columnName}".`,
        };
      }
      if (column.type === newType) {
        return {
          ok: false,
          reason: `"${columnName}" is already ${newType}.`,
        };
      }

      const oldType = column.type;

      return {
        ok: true,
        proposal: {
          toolName: call.name,
          args: call.args,
          summary: `Change "${columnName}" on "${tableName}" from ${oldType} to ${newType}.`,
          impact: [
            `${rowsPhrase(rowCount)} Every existing value is converted from ${oldType} to ${newType}.`,
            "If any value cannot be converted, nothing is applied and the table is left untouched.",
            `Undoing this converts the values back to ${oldType}, which can fail if a value written afterwards does not fit.`,
          ],
          upSql: `ALTER TABLE ${ident(tableName)} ALTER COLUMN ${ident(
            columnName,
          )} TYPE ${newType} USING ${ident(columnName)}::${newType};`,
          downSql: `ALTER TABLE ${ident(tableName)} ALTER COLUMN ${ident(
            columnName,
          )} TYPE ${oldType} USING ${ident(columnName)}::${oldType};`,
        },
      };
    }
  }
}
