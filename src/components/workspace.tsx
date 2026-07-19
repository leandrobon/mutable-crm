"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The split screen, and the toggle that collapses the chat.
 *
 * Takes the two sides as props rather than importing them: `page.tsx` is a
 * server component that reads the schema and the history, and passing the
 * rendered halves in keeps that work on the server. This file only decides how
 * much room each one gets.
 *
 * **The chat is hidden with CSS, not unmounted.** The conversation lives in
 * `Chat`'s own state, so `{showChat && chat}` would throw away every message
 * the moment you collapsed it, and hiding something is not a reasonable way to
 * lose your history. Kept mounted, the transcript is still there when it comes
 * back — including any proposal waiting to be applied.
 */
export function Workspace({
  chat,
  panel,
}: {
  chat: ReactNode;
  panel: ReactNode;
}) {
  const [showChat, setShowChat] = useState(true);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-baseline gap-3 border-b px-6 py-3">
        <h1 className="font-mono text-sm font-semibold">mutable-crm</h1>
        <p className="hidden text-xs text-muted-foreground sm:block">
          The model proposes a change. You apply it. Every migration keeps its
          reverse.
        </p>

        <Button
          variant="ghost"
          size="sm"
          aria-expanded={showChat}
          aria-controls="chat-panel"
          className="ml-auto h-7 shrink-0 self-center px-2.5 text-xs text-muted-foreground"
          onClick={() => setShowChat((shown) => !shown)}
        >
          {showChat ? "Hide chat" : "Show chat"}
        </Button>
      </header>

      <div
        className={`grid min-h-0 flex-1 ${
          showChat
            ? "grid-cols-1 lg:grid-cols-[minmax(380px,2fr)_3fr]"
            : "grid-cols-1"
        }`}
      >
        <div
          id="chat-panel"
          // `hidden` rather than unmounting — see above.
          className={
            showChat
              ? "min-h-0 border-b lg:border-b-0 lg:border-r"
              : "hidden"
          }
        >
          {chat}
        </div>
        <div className="min-h-0 bg-muted/30">{panel}</div>
      </div>
    </div>
  );
}
