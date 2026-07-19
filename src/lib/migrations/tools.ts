import { z } from "zod";
import { ALLOWED_TYPES } from "@/lib/schema/types";

/**
 * Postgres identifiers we are willing to generate. Anything outside this shape
 * would need double-quoting in SQL, and by refusing it we never emit a quoted
 * identifier, so there is no quoting bug to have. 63 is Postgres' limit;
 * longer names get truncated silently, which would leave a reverse migration
 * pointing at the wrong object.
 */
const IDENTIFIER = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z_][a-z0-9_]*$/,
    "must be lowercase snake_case: a letter or underscore, then letters, digits or underscores",
  );

const COLUMN_TYPE = z.enum(ALLOWED_TYPES);

/**
 * How many tables one request may create, and how many columns each may have.
 *
 * These are review limits, not database limits. Applying is a user action and
 * the user is expected to read what they are applying. A proposal for twenty
 * tables would be approved by scrolling, not by reading, which quietly turns
 * the review step into a rubber stamp.
 */
export const MAX_TABLES_PER_REQUEST = 8;
export const MAX_COLUMNS_PER_TABLE = 20;

const TABLE_DEFINITION = z.object({
  tableName: IDENTIFIER,
  columns: z
    .array(
      z.object({
        name: IDENTIFIER,
        type: COLUMN_TYPE,
        nullable: z.boolean(),
      }),
    )
    .min(1)
    .max(MAX_COLUMNS_PER_TABLE),
});

/** Zod schemas, the second validation pass. The API guarantees shape via
 *  `strict: true`; these give us parsed, typed values inside the app. */
export const toolSchemas = {
  createTables: z.object({
    tables: z.array(TABLE_DEFINITION).min(1).max(MAX_TABLES_PER_REQUEST),
  }),

  /**
   * The single-table form. Not offered to the model, because `createTables` covers it
   * with an array of one, and two overlapping tools would only give the model a
   * pointless choice to get wrong. It stays here so `_meta.migrations` rows
   * holding arguments in this shape can still be parsed: `describeRevert()`
   * reads them to say what undoing such a migration would do.
   */
  createTable: z.object({
    tableName: IDENTIFIER,
    columns: z
      .array(
        z.object({
          name: IDENTIFIER,
          type: COLUMN_TYPE,
          nullable: z.boolean(),
        }),
      )
      .min(1),
  }),

  addColumn: z.object({
    tableName: IDENTIFIER,
    columnName: IDENTIFIER,
    type: COLUMN_TYPE,
    nullable: z.boolean(),
  }),

  renameColumn: z.object({
    tableName: IDENTIFIER,
    from: IDENTIFIER,
    to: IDENTIFIER,
  }),

  changeColumnType: z.object({
    tableName: IDENTIFIER,
    columnName: IDENTIFIER,
    newType: COLUMN_TYPE,
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

export const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];

export function isToolName(value: string): value is ToolName {
  return value in toolSchemas;
}

/** A validated tool call: the operation the model chose, plus its arguments. */
export type ToolCall = {
  [K in ToolName]: { name: K; args: z.infer<(typeof toolSchemas)[K]> };
}[ToolName];

const identifierDescription =
  "lowercase snake_case (letters, digits, underscores; must not start with a digit)";

/**
 * The tool definitions sent to the model. `strict: true` plus
 * `additionalProperties: false` and an explicit `required` list makes the API
 * guarantee the arguments match these schemas, so the model cannot return a
 * malformed argument object.
 *
 * This list is the security boundary: there is no tool for dropping a table or
 * deleting a column, so the model cannot ask for one.
 */
export const TOOL_DEFINITIONS = [
  {
    name: "createTables",
    description:
      "Create one or more new tables in a single change. Use this for a single table as well: pass an array of one. When the user describes a whole area of their business rather than one entity, design the full set of tables here in one call, so they review and apply it as one decision. Every table automatically gets an `id` primary key and a `created_at` timestamp, so do not include them in any columns list.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        tables: {
          type: "array",
          description: `The tables to create, at most ${MAX_TABLES_PER_REQUEST}. Prefer few, well-chosen tables over many thin ones.`,
          items: {
            type: "object",
            properties: {
              tableName: {
                type: "string",
                description: `Name of the new table, ${identifierDescription}. Use the plural form, e.g. "contacts".`,
              },
              columns: {
                type: "array",
                description: `The columns to create, besides id and created_at. At most ${MAX_COLUMNS_PER_TABLE} per table.`,
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: `Column name, ${identifierDescription}.`,
                    },
                    type: {
                      type: "string",
                      enum: ALLOWED_TYPES,
                      description: "Column type.",
                    },
                    nullable: {
                      type: "boolean",
                      description:
                        "Whether the column accepts null. Prefer true unless the user clearly stated the field is required.",
                    },
                  },
                  required: ["name", "type", "nullable"],
                  additionalProperties: false,
                },
              },
            },
            required: ["tableName", "columns"],
            additionalProperties: false,
          },
        },
      },
      required: ["tables"],
      additionalProperties: false,
    },
  },
  {
    name: "addColumn",
    description: "Add a new column to an existing table.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        tableName: {
          type: "string",
          description: "Name of an existing table.",
        },
        columnName: {
          type: "string",
          description: `Name of the new column, ${identifierDescription}.`,
        },
        type: {
          type: "string",
          enum: ALLOWED_TYPES,
          description: "Column type.",
        },
        nullable: {
          type: "boolean",
          description:
            "Whether the column accepts null. Adding a NOT NULL column to a table that already has rows requires a default, so prefer true.",
        },
      },
      required: ["tableName", "columnName", "type", "nullable"],
      additionalProperties: false,
    },
  },
  {
    name: "renameColumn",
    description:
      "Rename an existing column. This preserves the data. Use it when the user wants to change what a field is called, not what it holds.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        tableName: {
          type: "string",
          description: "Name of an existing table.",
        },
        from: { type: "string", description: "Current column name." },
        to: {
          type: "string",
          description: `New column name, ${identifierDescription}.`,
        },
      },
      required: ["tableName", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "changeColumnType",
    description:
      "Change the type of an existing column. The existing values are cast to the new type; if any value cannot be cast, the migration fails and nothing changes.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        tableName: {
          type: "string",
          description: "Name of an existing table.",
        },
        columnName: {
          type: "string",
          description: "Name of an existing column.",
        },
        newType: {
          type: "string",
          enum: ALLOWED_TYPES,
          description: "The type to change the column to.",
        },
      },
      required: ["tableName", "columnName", "newType"],
      additionalProperties: false,
    },
  },
] as const;
