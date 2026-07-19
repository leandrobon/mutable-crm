import { isToolName, toolSchemas } from "./tools";

/**
 * One row of `_meta.migrations`, as the rest of the app sees it.
 *
 * This type lives here rather than in `apply.ts` on purpose: the history view is
 * a client component and needs both the shape and `describeRevert()` to render.
 * `apply.ts` imports `@/db`, so importing the type from there would risk pulling
 * `pg` into the browser bundle, the same constraint that keeps `rows/cells.ts`
 * free of database imports. Nothing in this file may import `@/db` either.
 */
export type MigrationRecord = {
  id: number;
  filename: string;
  summary: string;
  toolName: string;
  toolArgs: unknown;
  upSql: string;
  downSql: string;
  appliedAt: Date;
  revertedAt: Date | null;
};

export type RevertPlan = {
  /** One sentence, plain language: what undoing this does. */
  summary: string;
  /** What it does to the rows that are in the table now. */
  impact: string[];
  /**
   * Whether undoing destroys data. The reverse of a migration restores the
   * *shape* of the schema, never the values that were written into it. Undoing
   * an `addColumn` drops the column and everything anyone typed in it.
   */
  destructive: boolean;
};

/**
 * Describes the reverse of an applied migration, from the same arguments the
 * summary was derived from.
 *
 * Pure, and deliberately not a second model call, for the same reason
 * `planMigration` derives its summary from the tool arguments: a description
 * generated separately from the SQL can contradict it.
 *
 * `down_sql` is not re-generated here. It was generated when the migration was
 * applied, against the schema as it was then, and it is what actually runs; this
 * only says what it will do.
 */
export function describeRevert(record: {
  toolName: string;
  toolArgs: unknown;
}): RevertPlan {
  const { toolName, toolArgs } = record;

  // A row whose arguments no longer parse is not something to reassure anyone
  // about: fall through to the conservative description and require confirming.
  if (isToolName(toolName)) {
    const parsed = toolSchemas[toolName].safeParse(toolArgs);

    if (parsed.success) {
      switch (toolName) {
        case "createTables": {
          const { tables } = parsed.data as { tables: { tableName: string }[] };
          const names = tables.map((t) => t.tableName);

          return {
            summary:
              names.length === 1
                ? `Drop the table "${names[0]}".`
                : `Drop ${names.length} tables: ${names.join(", ")}.`,
            impact: [
              names.length === 1
                ? `The table and every record in it are deleted.`
                : `All ${names.length} tables and every record in them are deleted.`,
              `Undoing this is not itself undoable: re-applying would create ${
                names.length === 1 ? "it" : "them"
              } empty.`,
            ],
            destructive: true,
          };
        }

        case "addColumn": {
          const { tableName, columnName } = parsed.data as {
            tableName: string;
            columnName: string;
          };
          return {
            summary: `Remove "${columnName}" from "${tableName}".`,
            impact: [
              `The column is dropped, and every value written into it is deleted.`,
              `The rows themselves stay, only this field goes.`,
            ],
            destructive: true,
          };
        }

        case "renameColumn": {
          const { tableName, from, to } = parsed.data as {
            tableName: string;
            from: string;
            to: string;
          };
          return {
            summary: `Rename "${to}" back to "${from}" on "${tableName}".`,
            impact: ["No values change, only the name of the field."],
            destructive: false,
          };
        }

        case "changeColumnType": {
          const { tableName, columnName } = parsed.data as {
            tableName: string;
            columnName: string;
          };
          return {
            summary: `Change "${columnName}" on "${tableName}" back to its previous type.`,
            impact: [
              "Every value is converted back to the type the column had before.",
              "If a value written since this was applied does not fit the old type, the undo fails and nothing changes.",
            ],
            destructive: false,
          };
        }
      }
    }
  }

  return {
    summary: "Undo this change.",
    impact: [
      "This migration's arguments could not be read, so what its reverse does cannot be described.",
      "The stored reverse SQL still runs in a transaction, so if it fails, nothing changes.",
    ],
    destructive: true,
  };
}

/**
 * The id of the only migration that may be undone: the newest one still in
 * effect.
 *
 * Undo is last-in-first-out, which is what makes it safe without a dependency
 * graph. Reverting migration N while N+1 builds on it (undoing the `addColumn`
 * that a later `renameColumn` renamed) would either fail halfway or silently
 * leave the schema somewhere neither migration describes. Refusing anything but
 * the top of the stack removes the case entirely rather than detecting it.
 *
 * The UI uses this to decide what to offer. It is not the check that protects
 * the database. That one runs inside the transaction in `revertMigration()`,
 * because this list is a snapshot and could be stale by the time anyone clicks.
 */
export function undoableId(
  records: Pick<MigrationRecord, "id" | "revertedAt">[],
): number | null {
  const live = records.filter((r) => r.revertedAt === null);
  if (live.length === 0) return null;
  return live.reduce((newest, r) => (r.id > newest.id ? r : newest)).id;
}
