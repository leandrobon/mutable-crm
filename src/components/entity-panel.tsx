import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { TableData } from "@/lib/schema/rows";

/**
 * Renders every table from the live schema. There is nothing here specific to
 * contacts, deals, or any other entity — add a table through the chat and it
 * appears, because this reads whatever introspection returned.
 */
export function EntityPanel({ tables }: { tables: TableData[] }) {
  if (tables.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">No entities yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Ask for one on the left — try &ldquo;I want to track contacts with a
            name and an email&rdquo;.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-6">
      {tables.map((data) => (
        <EntityTable key={data.table.name} data={data} />
      ))}
    </div>
  );
}

function EntityTable({ data }: { data: TableData }) {
  const { table, rows, totalRows } = data;

  return (
    <section>
      <header className="mb-3 flex items-baseline gap-3">
        <h2 className="font-mono text-sm font-semibold">{table.name}</h2>
        <span className="text-xs text-muted-foreground">
          {totalRows} {totalRows === 1 ? "row" : "rows"} ·{" "}
          {table.columns.length} columns
        </span>
      </header>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {table.columns.map((column) => (
                <TableHead key={column.name} className="whitespace-nowrap">
                  <span className="font-mono text-xs">{column.name}</span>
                  <Badge
                    variant="secondary"
                    className="ml-2 font-mono text-[10px] font-normal"
                  >
                    {column.type}
                  </Badge>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={table.columns.length}
                  className="h-20 text-center text-sm text-muted-foreground"
                >
                  No rows yet
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => (
                <TableRow key={index}>
                  {table.columns.map((column) => (
                    <TableCell
                      key={column.name}
                      className="whitespace-nowrap font-mono text-xs"
                    >
                      {row[column.name] ?? (
                        <span className="text-muted-foreground/50">null</span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalRows > rows.length && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the {rows.length} most recent of {totalRows}.
        </p>
      )}
    </section>
  );
}
