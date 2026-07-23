import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditOp, Entity, Suggestion } from "@kiln/core";
import { api } from "../lib/client";
import { Button } from "./ui";
import { color, font, radius, space } from "../theme";

// Document editor (BP-5): CodeMirror 6 rendering pending suggestion ops as
// decorations — inserts green, deletes red strikethrough. Decisions are
// staged per op; Apply resolves them through core's applySuggestion via the
// sidecar (accepting applies atomically and writes one revision). Anchor
// positions here are display-only — the server re-resolves on apply.

type Decision = "accepted" | "rejected";

// Mirrors core's anchor rule for display: exactly one match, else stale.
function locate(body: string, anchor: string): { from: number; to: number } | null {
  if (anchor === "") return { from: body.length, to: body.length };
  const first = body.indexOf(anchor);
  if (first === -1) return null;
  if (body.indexOf(anchor, first + 1) !== -1) return null;
  return { from: first, to: first + anchor.length };
}

class InsertWidget extends WidgetType {
  constructor(private text: string) {
    super();
  }
  eq(other: InsertWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    span.className = "kiln-ins"; // styled in index.css from the diff tokens
    return span;
  }
}

const deleteMark = Decoration.mark({ class: "kiln-del" });

function buildDecorations(body: string, ops: EditOp[], decisions: Record<number, Decision>): DecorationSet {
  const ranges = [];
  for (let i = 0; i < ops.length; i++) {
    if (decisions[i] === "rejected") continue;
    const op = ops[i];
    const at = locate(body, op.anchor);
    if (!at) continue; // stale — surfaced in the op panel instead
    if (op.kind === "insert") {
      ranges.push(Decoration.widget({ widget: new InsertWidget(op.text), side: 1 }).range(at.to));
    } else if (op.kind === "delete") {
      if (at.to > at.from) ranges.push(deleteMark.range(at.from, at.to));
    } else {
      if (at.to > at.from) ranges.push(deleteMark.range(at.from, at.to));
      ranges.push(Decoration.widget({ widget: new InsertWidget(op.text), side: 1 }).range(at.to));
    }
  }
  return Decoration.set(ranges, true);
}

function opLabel(op: EditOp): string {
  const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  if (op.kind === "insert") return op.anchor === "" ? `append ${clip(JSON.stringify(op.text))}` : `insert ${clip(JSON.stringify(op.text))} after ${clip(JSON.stringify(op.anchor))}`;
  if (op.kind === "delete") return `delete ${clip(JSON.stringify(op.anchor))}`;
  return `replace ${clip(JSON.stringify(op.anchor))} with ${clip(JSON.stringify(op.text))}`;
}

export function Editor({ entity, suggestion }: { entity: Entity; suggestion: Suggestion | null }) {
  const queryClient = useQueryClient();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [dirty, setDirty] = useState(false);

  // Reset staged decisions when the suggestion changes.
  useEffect(() => setDecisions({}), [suggestion?.id]);

  const stale = useMemo(
    () => new Set((suggestion?.ops ?? []).map((op, i) => (locate(entity.body, op.anchor) ? -1 : i)).filter((i) => i >= 0)),
    [entity.body, suggestion],
  );

  // (Re)build the editor whenever body, suggestion, or decisions change.
  useEffect(() => {
    if (!host.current) return;
    view.current?.destroy();
    setDirty(false);
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: entity.body,
        extensions: [
          EditorView.lineWrapping,
          EditorView.editable.of(!suggestion),
          EditorView.decorations.of(suggestion ? buildDecorations(entity.body, suggestion.ops, decisions) : Decoration.none),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(true);
          }),
          EditorView.theme({
            "&": { background: "var(--k-inset)", borderRadius: "6px", fontSize: font.base },
            ".cm-content": { padding: "12px", fontFamily: "ui-monospace, monospace", minHeight: "60px" },
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
  }, [entity.id, entity.body, suggestion, decisions]);

  const save = useMutation({
    mutationFn: () => api.patchEntity(entity.id, { body: view.current?.state.doc.toString() ?? entity.body }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entity", entity.id], updated);
      setDirty(false);
    },
  });

  const acceptedIndexes = Object.entries(decisions)
    .filter(([, d]) => d === "accepted")
    .map(([i]) => Number(i));

  const apply = useMutation({
    mutationFn: () => api.applySuggestion(suggestion!.id, acceptedIndexes),
    // Optimistic: the pending suggestion disappears immediately.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["suggestions", entity.id] });
      const prior = queryClient.getQueryData(["suggestions", entity.id]);
      queryClient.setQueryData(["suggestions", entity.id], []);
      return { prior };
    },
    onError: (_e, _v, ctx) => queryClient.setQueryData(["suggestions", entity.id], ctx?.prior),
    onSuccess: ({ entity: updated }) => {
      queryClient.setQueryData(["entity", entity.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["revisions", entity.id] });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["suggestions", entity.id] });
      void queryClient.invalidateQueries({ queryKey: ["proposals"] });
    },
  });

  const dismiss = useMutation({
    mutationFn: () => api.dismissSuggestion(suggestion!.id),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["suggestions", entity.id] });
      const prior = queryClient.getQueryData(["suggestions", entity.id]);
      queryClient.setQueryData(["suggestions", entity.id], []);
      return { prior };
    },
    onError: (_e, _v, ctx) => queryClient.setQueryData(["suggestions", entity.id], ctx?.prior),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["suggestions", entity.id] });
      void queryClient.invalidateQueries({ queryKey: ["proposals"] });
    },
  });

  return (
    <div>
      <div ref={host} data-testid="editor" />
      {!suggestion && (
        <Button style={{ marginTop: space(1.5) }} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      )}

      {suggestion && (
        <section
          data-testid="suggestion-panel"
          style={{
            marginTop: space(3),
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: space(3),
          }}
        >
          <p style={{ margin: `0 0 ${space(2)}px`, fontSize: font.sm, color: color.muted }}>
            Pending suggestion from {suggestion.source} — decide each op, then apply.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {suggestion.ops.map((op, i) => {
              const decision = decisions[i];
              const isStale = stale.has(i);
              return (
                <li
                  key={i}
                  data-testid={`op-${i}`}
                  style={{ display: "flex", gap: space(2), alignItems: "baseline", padding: "3px 0" }}
                >
                  <code style={{ flex: 1, fontSize: font.sm, opacity: decision === "rejected" ? 0.45 : 1 }}>
                    [{i}] {opLabel(op)}
                    {isStale && <em style={{ color: color.del }}> (stale anchor)</em>}
                  </code>
                  <Button
                    variant="ghost"
                    aria-label={`accept op ${i}`}
                    disabled={isStale}
                    onClick={() => setDecisions((d) => ({ ...d, [i]: "accepted" }))}
                    style={{ fontWeight: decision === "accepted" ? 700 : 400, color: color.ins, padding: `0 ${space(1)}px` }}
                  >
                    ✓
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`reject op ${i}`}
                    onClick={() => setDecisions((d) => ({ ...d, [i]: "rejected" }))}
                    style={{ fontWeight: decision === "rejected" ? 700 : 400, color: color.del, padding: `0 ${space(1)}px` }}
                  >
                    ✗
                  </Button>
                </li>
              );
            })}
          </ul>
          <div style={{ marginTop: space(2), display: "flex", gap: space(2) }}>
            <Button
              disabled={acceptedIndexes.length === 0 || apply.isPending}
              onClick={() => apply.mutate()}
              data-testid="apply-suggestion"
            >
              Apply {acceptedIndexes.length ? `${acceptedIndexes.length} accepted` : "(accept at least one)"}
            </Button>
            <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate()} data-testid="dismiss-suggestion">
              Reject all
            </Button>
          </div>
          {apply.isError && <p style={{ color: color.danger }}>{String(apply.error)}</p>}
        </section>
      )}
    </div>
  );
}
