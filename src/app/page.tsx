import { Chat } from "@/components/chat";
import { EntityPanel } from "@/components/entity-panel";
import { introspectSchema } from "@/lib/schema/introspect";
import { fetchAllTableData } from "@/lib/schema/rows";

// The schema can change on any request, so never serve this from a cache.
export const dynamic = "force-dynamic";

export default async function Home() {
  const schema = await introspectSchema();
  const tables = await fetchAllTableData(schema);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-baseline gap-3 border-b px-6 py-3">
        <h1 className="font-mono text-sm font-semibold">crmllm</h1>
        <p className="text-xs text-muted-foreground">
          The model proposes a change. You apply it. Every migration keeps its
          reverse.
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(380px,2fr)_3fr]">
        <div className="min-h-0 border-b lg:border-b-0 lg:border-r">
          <Chat />
        </div>
        <div className="min-h-0 overflow-y-auto bg-muted/30">
          <EntityPanel tables={tables} />
        </div>
      </div>
    </div>
  );
}
