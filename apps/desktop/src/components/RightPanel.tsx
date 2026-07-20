import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/client";
import { GraphPanel } from "./GraphPanel";
import { ChatPanel } from "./ChatPanel";
import { ContextInspector } from "./ContextInspector";
import { color, font, space } from "../theme";

type Tab = "graph" | "chat" | "context";
const LABEL: Record<Tab, string> = { graph: "Graph", chat: "Chat", context: "Context" };

// The right column: the graph neighbourhood, plus a Chat tab for documents that
// can be refined (requirements/blueprints) and a Context tab for work orders
// (the assembly inspector, Phase 8). Owns the column chrome so the inner panels
// render body-only.
export function RightPanel({ entityId, onSelect }: { entityId: string; onSelect: (id: string) => void }) {
  const entity = useQuery({ queryKey: ["entity", entityId], queryFn: () => api.getEntity(entityId) });
  const type = entity.data?.type;
  const tabs: Tab[] = [
    "graph",
    ...(type === "requirement" || type === "blueprint" ? (["chat"] as const) : []),
    ...(type === "work_order" ? (["context"] as const) : []),
  ];
  const [tab, setTab] = useState<Tab>("graph");
  const active: Tab = tabs.includes(tab) ? tab : "graph";

  return (
    <div
      style={{
        // Tauri window is 1100px; clamp so the document column keeps room.
        width: "clamp(220px, 28vw, 340px)",
        flexShrink: 0,
        borderLeft: `1px solid ${color.border}`,
        background: color.surface,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Right panel"
          style={{ display: "flex", gap: space(1), padding: `${space(2)}px ${space(4)}px 0` }}
        >
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={active === t}
              data-testid={`right-tab-${t}`}
              onClick={() => setTab(t)}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: `${space(1)}px ${space(1)}px`,
                fontSize: font.sm,
                fontWeight: active === t ? 700 : 400,
                color: active === t ? color.text : color.muted,
                borderBottom: `2px solid ${active === t ? color.accent : "transparent"}`,
              }}
            >
              {LABEL[t]}
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: active === "chat" ? "hidden" : "auto" }}>
        {active === "chat" ? (
          <ChatPanel key={entityId} entityId={entityId} />
        ) : active === "context" ? (
          <ContextInspector entityId={entityId} />
        ) : (
          <GraphPanel entityId={entityId} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}
