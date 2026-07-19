import Anthropic from "@anthropic-ai/sdk";
import type { DbSchema } from "@/lib/schema/types";
import { formatSchemaForPrompt } from "@/lib/schema/introspect";
import { TOOL_DEFINITIONS, isToolName, toolSchemas, type ToolCall } from "./tools";

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You help a user evolve the schema of their CRM database by talking to them.

You do not execute anything. You choose one operation and its arguments; the
application generates the SQL, shows it to the user, and only applies it if they
approve. Never write SQL yourself — you have no way to run it, and the SQL in
your message would be ignored.

You can do exactly four things: create a table, add a column, rename a column,
and change a column's type. You cannot delete a table or a column.

There is one thing the user can do that you cannot: undo. Every applied change
is listed in the History tab on the right, and the most recent one still in
effect has an "Undo this change" button that runs the reverse it was stored
with. Undoing is theirs to do, not yours — you have no tool for it and must
never claim to have undone anything.

So when someone asks you to revert, undo, or take back a change, do not say it
is impossible. Point them at the History tab. Two things to be accurate about:

- Only the most recent change still in effect can be undone. To reach an older
  one they undo the newer ones first, in order.
- Undoing restores the shape of the schema, not the data. Undoing a column that
  was added drops that column and everything written into it.

This is also the honest answer to "remove the column you just added": it can be
undone from History if it was the last change applied. It cannot be dropped as a
new operation, and if it is not the last change, the ones after it go first.

Guidelines:
- Choose the operation that preserves data. If the user wants a field to be
  called something else, rename it — do not add a new one.
- Every new table automatically gets an "id" primary key and a "created_at"
  timestamp. Never include them in the column list.
- Prefer optional (nullable) columns. A required column cannot be added to a
  table that already has rows.
- Use singular, lowercase, snake_case column names and plural table names.

If the request is ambiguous, would need an operation you do not have, or is not
about the schema at all, reply in plain text instead of choosing an operation.
Be brief. Answer in the language the user wrote in.

You are in a conversation. When a message only makes sense as a reply to your
previous one — a list of column names after you asked which columns to create —
read it as that reply, not as a fresh request.

Earlier proposals appear in the transcript as [proposed ...] lines, with whether
the user applied them. A proposal that is still pending was not applied: the
schema below does not include it.`;

/** The schema goes in the system prompt, not in the messages: it is rebuilt on
 *  every call, so the model always reads the current one. Kept in a message it
 *  would be a snapshot, and a long conversation would carry several
 *  contradictory versions of the same database. */
function systemPrompt(schema: DbSchema): string {
  return `${SYSTEM_PROMPT}

Current database schema:

${formatSchemaForPrompt(schema)}`;
}

/** One past turn, flattened to text. Proposals are rendered as [proposed ...]
 *  rather than replayed as tool_use blocks — the model needs to know what it
 *  offered and what became of it, not to re-issue the call, and this avoids
 *  threading tool ids through the client for no gain. */
export type Turn = { role: "user" | "assistant"; text: string };

const MAX_TURNS = 24;

/**
 * What came back from the model: either an operation to propose, or plain text
 * (a question, a refusal, or an answer about the current schema).
 */
export type ProposeResult =
  | { type: "call"; call: ToolCall; text: string }
  | { type: "message"; text: string };

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local — see .env.example.",
      );
    }
    client = new Anthropic();
  }
  return client;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Asks the model which operation the user's request maps to.
 *
 * The model sees the current schema and the four tools; it never sees or
 * produces SQL. `strict: true` on the tool definitions makes the API guarantee
 * the arguments match our schemas, and we parse them again with Zod so the rest
 * of the app gets typed values.
 */
export async function proposeChange(
  userMessage: string,
  schema: DbSchema,
  history: Turn[] = [],
): Promise<ProposeResult> {
  // Only the tail: the schema in the system prompt already carries everything
  // the older turns established, so dropping them loses conversational thread,
  // not facts.
  const recent = history.slice(-MAX_TURNS);

  // The API rejects a leading assistant message, which is what a truncation
  // mid-exchange can leave behind.
  while (recent.length > 0 && recent[0].role === "assistant") recent.shift();

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: systemPrompt(schema),
    tools: [...TOOL_DEFINITIONS] as unknown as Anthropic.Tool[],
    tool_choice: { type: "auto" },
    messages: [
      ...recent.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user" as const, content: userMessage },
    ],
  });

  const text = textOf(response.content);

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return {
      type: "message",
      text: text || "I could not work out what change you wanted.",
    };
  }

  if (!isToolName(toolUse.name)) {
    return {
      type: "message",
      text: `The model asked for an operation that does not exist ("${toolUse.name}").`,
    };
  }

  // Second validation pass. The API guarantees the shape; this gives us typed
  // values and catches anything the schema alone would not.
  const parsed = toolSchemas[toolUse.name].safeParse(toolUse.input);
  if (!parsed.success) {
    return {
      type: "message",
      text: `The proposed change was not valid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }

  return {
    type: "call",
    call: { name: toolUse.name, args: parsed.data } as ToolCall,
    text,
  };
}
