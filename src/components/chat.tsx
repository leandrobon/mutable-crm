"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apply, propose, type ProposeResponse } from "@/app/actions";
import { useDictation } from "@/components/use-dictation";
import type { Turn } from "@/lib/migrations/propose";
import type { Proposal } from "@/lib/migrations/sql";
import type { ToolCall } from "@/lib/migrations/tools";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "rejected"; reason: string }
  | {
      kind: "proposal";
      call: ToolCall;
      proposal: Proposal;
      status: "pending" | "applying" | "applied";
      note?: string;
      error?: string;
    };

const EXAMPLES = [
  "contacts need a field for the company they work at",
  "rename full_name to name",
  "I want to track deals, with a title and an amount",
];

/**
 * The rendered conversation, flattened into what the model needs to read it.
 *
 * A proposal is not text on screen, but leaving it out would make the
 * transcript lie: the model would see itself answer a request with nothing.
 * Its status matters too: "you offered this and the user has not applied it"
 * and "this is now in the schema" lead to different next moves.
 */
function transcriptOf(entries: Entry[]): Turn[] {
  return entries.map((entry): Turn => {
    switch (entry.kind) {
      case "user":
        return { role: "user", text: entry.text };
      case "assistant":
        return { role: "assistant", text: entry.text };
      case "rejected":
        return {
          role: "assistant",
          text: `[proposal refused by the application: ${entry.reason}]`,
        };
      case "proposal":
        return {
          role: "assistant",
          text: `[proposed ${entry.proposal.toolName}: ${entry.proposal.summary} (${
            entry.status === "applied"
              ? "applied by the user"
              : "not applied yet"
          })]`,
        };
    }
  });
}

export function Chat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [isProposing, startProposing] = useTransition();
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);

  const dictation = useDictation();
  // What was already typed when dictation started, so speaking adds to it
  // instead of replacing it.
  const dictationBase = useRef("");

  useEffect(() => {
    if (!dictation.listening) return;
    const base = dictationBase.current;
    setInput(base ? `${base} ${dictation.transcript}` : dictation.transcript);
  }, [dictation.listening, dictation.transcript]);

  function toggleDictation() {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    dictationBase.current = input.trim();
    dictation.start();
  }

  function scrollDown() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  function send(message: string) {
    const text = message.trim();
    if (!text || isProposing) return;

    // Sending ends the dictation session; otherwise the next words would be
    // appended to a box that has already been cleared.
    if (dictation.listening) dictation.stop();

    // Everything on screen before this message. `entries` is current here:
    // `send` runs from an event handler, and `isProposing` blocks a second
    // send before the first has rendered its result.
    const history = transcriptOf(entries);

    setEntries((prev) => [...prev, { kind: "user", text }]);
    setInput("");
    scrollDown();

    startProposing(async () => {
      const response: ProposeResponse = await propose(text, history);

      setEntries((prev) => {
        switch (response.kind) {
          case "message":
            return [...prev, { kind: "assistant", text: response.text }];
          case "rejected":
            return [...prev, { kind: "rejected", reason: response.reason }];
          case "proposal":
            return [
              ...prev,
              ...(response.text
                ? [{ kind: "assistant" as const, text: response.text }]
                : []),
              {
                kind: "proposal",
                call: response.call,
                proposal: response.proposal,
                status: "pending",
              },
            ];
        }
      });
      scrollDown();
    });
  }

  function setEntryAt(index: number, update: (entry: Entry) => Entry) {
    setEntries((prev) =>
      prev.map((entry, i) => (i === index ? update(entry) : entry)),
    );
  }

  async function onApply(index: number, call: ToolCall) {
    setEntryAt(index, (entry) =>
      entry.kind === "proposal"
        ? { ...entry, status: "applying", error: undefined }
        : entry,
    );

    const result = await apply(call);

    setEntryAt(index, (entry) => {
      if (entry.kind !== "proposal") return entry;
      if (!result.ok)
        return { ...entry, status: "pending", error: result.reason };
      return {
        ...entry,
        status: "applied",
        note: result.fileWritten
          ? `Applied · ${result.filename}`
          : `Applied · could not write ${result.filename} to disk`,
      };
    });

    // The right-hand panel is a server component, so this re-renders it from the
    // new schema.
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-6">
          {entries.length === 0 && <EmptyState onPick={send} />}

          {entries.map((entry, index) => (
            <EntryView
              key={index}
              entry={entry}
              onApply={(call) => onApply(index, call)}
            />
          ))}

          {isProposing && (
            <p className="text-sm text-muted-foreground">Thinking…</p>
          )}
        </div>
      </div>

      <form
        className="border-t p-4"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(input);
            }
          }}
          placeholder={
            dictation.listening
              ? "Listening…"
              : "Describe a change: “contacts need a company field”"
          }
          rows={2}
          className="resize-none"
          disabled={isProposing}
        />

        {dictation.error && (
          <p className="mt-2 text-xs text-destructive">{dictation.error}</p>
        )}

        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {dictation.listening
              ? "Listening. Speak, then stop to edit before sending."
              : "Enter to send · Shift+Enter for a new line"}
          </p>
          <div className="flex items-center gap-2">
            {dictation.supported && (
              <Button
                type="button"
                size="sm"
                variant={dictation.listening ? "destructive" : "outline"}
                onClick={toggleDictation}
                disabled={isProposing}
                aria-pressed={dictation.listening}
                aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
                title={dictation.listening ? "Stop dictating" : "Dictate"}
              >
                <MicIcon listening={dictation.listening} />
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={isProposing || !input.trim()}
            >
              Send
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function MicIcon({ listening }: { listening: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={`size-4 ${listening ? "animate-pulse" : ""}`}
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="rounded-lg border border-dashed p-5">
      <p className="text-sm font-medium">Change the schema by describing it</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Nothing is applied until you approve it.
      </p>
      <div className="mt-4 flex flex-col items-start gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="text-left text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function EntryView({
  entry,
  onApply,
}: {
  entry: Entry;
  onApply: (call: ToolCall) => void;
}) {
  if (entry.kind === "user") {
    return (
      <div className="self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        {entry.text}
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return <p className="whitespace-pre-wrap text-sm">{entry.text}</p>;
  }

  if (entry.kind === "rejected") {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
        <p className="text-xs font-medium text-amber-700 dark:text-amber-500">
          Not possible
        </p>
        <p className="mt-1 text-sm">{entry.reason}</p>
      </div>
    );
  }

  return <ProposalCard entry={entry} onApply={onApply} />;
}

function ProposalCard({
  entry,
  onApply,
}: {
  entry: Extract<Entry, { kind: "proposal" }>;
  onApply: (call: ToolCall) => void;
}) {
  const { proposal, call, status, note, error } = entry;
  const applied = status === "applied";

  return (
    <div className="rounded-lg border">
      <div className="p-4">
        <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {proposal.toolName}
        </p>
        <p className="mt-1.5 text-sm font-medium">{proposal.summary}</p>

        <ul className="mt-3 space-y-1">
          {proposal.impact.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-muted-foreground">
              <span aria-hidden>·</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <Accordion multiple={false} className="border-t px-4">
        <AccordionItem value="sql" className="border-0">
          <AccordionTrigger className="py-3 text-xs text-muted-foreground hover:no-underline">
            SQL
          </AccordionTrigger>
          <AccordionContent>
            <SqlBlock label="up" sql={proposal.upSql} />
            <SqlBlock label="down" sql={proposal.downSql} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="flex items-center justify-between gap-3 border-t p-3">
        {applied ? (
          <p className="font-mono text-xs text-muted-foreground">{note}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {error ?? "Nothing has changed yet."}
            </p>
            <Button
              size="sm"
              onClick={() => onApply(call)}
              disabled={status === "applying"}
            >
              {status === "applying" ? "Applying…" : "Apply"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SqlBlock({ label, sql }: { label: string; sql: string }) {
  return (
    <div className="mb-3 last:mb-1">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
        {sql}
      </pre>
    </div>
  );
}
