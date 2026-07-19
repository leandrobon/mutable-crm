import { Chat } from "@/components/chat";
import { Panel } from "@/components/panel";
import { Workspace } from "@/components/workspace";
import { introspectSchema } from "@/lib/schema/introspect";
import { fetchAllTableData } from "@/lib/rows/read";
import { listMigrations } from "@/lib/migrations/apply";

// The schema can change on any request, so never serve this from a cache.
export const dynamic = "force-dynamic";

export default async function Home() {
  const schema = await introspectSchema();
  const tables = await fetchAllTableData(schema);
  // Read here rather than from a client action: undo re-runs this server
  // component through revalidatePath, so the history redraws from the database
  // exactly like the panel does, with no client-side copy to keep in sync.
  const history = await listMigrations();

  // The two halves are rendered here, on the server, and handed to Workspace —
  // it only decides how much room each one gets.
  return (
    <Workspace
      chat={<Chat />}
      panel={<Panel tables={tables} history={history} />}
    />
  );
}
