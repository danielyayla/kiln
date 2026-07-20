import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ChatMessage } from "../lib/client";
import { friendlyError } from "../lib/errors";
import { Button, SectionHeader, useToast } from "./ui";
import { color, font, radius, space } from "../theme";

// A local chat turn: the transcript is session-local (BP-4), so it lives in
// component state and is posted whole each turn. `suggestionId` marks an
// assistant turn that filed an edit — the chip links to the editor decorations.
type Turn = ChatMessage & { suggestionId?: string };

// Bring the editor's pending-suggestion decorations into view. The Editor and
// its op panel live in the middle column; the chip is over here, so we scroll
// rather than focus across component trees.
function focusSuggestions() {
  const target =
    document.querySelector('[data-testid="suggestion-panel"]') ??
    document.querySelector('[data-testid="editor"]');
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Conversational document refinement (BP-4): ask questions about the open
// document or ask for changes; edits arrive as normal suggestions the author
// accepts per op in the editor. Scoped to one document — the session resets when
// the opened entity changes (App keys this by entityId).
export function ChatPanel({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the transcript grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const send = useMutation({
    mutationFn: (history: Turn[]) =>
      api.chat(
        entityId,
        history.map((t) => ({ role: t.role, content: t.content })),
      ),
    onSuccess: ({ reply, suggestionId }) => {
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: reply || "(proposed an edit)", suggestionId },
      ]);
      // A filed suggestion shows up in the editor's decorations + op panel.
      if (suggestionId) void queryClient.invalidateQueries({ queryKey: ["suggestions", entityId] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content || send.isPending) return;
    const history: Turn[] = [...turns, { role: "user", content }];
    setTurns(history);
    setInput("");
    send.mutate(history);
  }

  return (
    <div
      data-testid="chat-panel"
      style={{ display: "flex", flexDirection: "column", height: "100%", padding: space(4) }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionHeader>Chat</SectionHeader>
        {turns.length > 0 && (
          <Button variant="ghost" onClick={() => setTurns([])} disabled={send.isPending}>
            Clear
          </Button>
        )}
      </div>

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", margin: `${space(2)}px 0` }}>
        {turns.length === 0 && !send.isPending && (
          <p style={{ color: color.faint, fontSize: font.sm, margin: 0 }}>
            Ask about this document — “what’s ambiguous here?” — or ask for a change like “tighten the
            acceptance criteria.” Edits arrive as suggestions you accept per op.
          </p>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(2) }}>
          {turns.map((t, i) => (
            <li
              key={i}
              style={{
                justifySelf: t.role === "user" ? "end" : "start",
                maxWidth: "90%",
                padding: `${space(1.5)}px ${space(2)}px`,
                borderRadius: radius.md,
                fontSize: font.sm,
                whiteSpace: "pre-wrap",
                background: t.role === "user" ? color.chip : color.inset,
                border: `1px solid ${color.border}`,
              }}
            >
              {t.content}
              {t.suggestionId && (
                <div style={{ marginTop: space(1) }}>
                  <button
                    data-testid="proposed-edit-chip"
                    onClick={focusSuggestions}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: space(1),
                      border: `1px solid ${color.ins}`,
                      borderRadius: radius.sm,
                      background: "transparent",
                      color: color.ins,
                      cursor: "pointer",
                      fontSize: font.xs,
                      padding: `${space(0.5)}px ${space(1.5)}px`,
                    }}
                  >
                    ✎ Proposed an edit — review
                  </button>
                </div>
              )}
            </li>
          ))}
          {send.isPending && (
            <li style={{ justifySelf: "start", color: color.faint, fontSize: font.sm }}>thinking…</li>
          )}
        </ul>
      </div>

      <form style={{ display: "flex", gap: space(1) }} onSubmit={onSubmit}>
        <textarea
          aria-label="Chat message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            }
          }}
          placeholder="Ask or request a change…"
          rows={2}
          style={{
            flex: 1,
            minWidth: 0,
            resize: "none",
            fontFamily: "inherit",
            fontSize: font.sm,
            padding: `${space(1.5)}px ${space(2)}px`,
            border: `1px solid ${color.borderStrong}`,
            borderRadius: radius.md,
            background: color.bg,
            color: color.text,
          }}
        />
        <Button type="submit" variant="primary" disabled={!input.trim() || send.isPending}>
          Send
        </Button>
      </form>
    </div>
  );
}
