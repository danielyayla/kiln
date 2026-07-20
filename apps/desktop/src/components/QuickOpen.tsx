import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Entity, EntityType } from "@kiln/core";
import { api } from "../lib/client";
import { Badge } from "./ui";
import { backdrop, color, font, radius, shadow, space } from "../theme";

const TYPES: EntityType[] = ["requirement", "blueprint", "work_order", "artifact"];
const MAX_RESULTS = 20;

// Rank a title against the query: exact prefix beats word prefix beats
// substring; -1 filters out. Cheap client-side fuzziness over the four cached
// listEntities queries (BP-6) — FTS can replace this if graphs get large.
function score(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  if (q === "") return 0;
  const at = t.indexOf(q);
  if (at === -1) return -1;
  if (at === 0) return 2;
  if (t[at - 1] === " ") return 1;
  return 0;
}

// The ⌘K palette (BP-6): fuzzy title filter across every entity type,
// arrow-key navigation, Enter opens. The open/close state lives in App so
// the shortcut works from either view.
export function QuickOpen({ onSelect, onClose }: { onSelect: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const queries = TYPES.map((type) =>
    // Static TYPES array — hook order is stable.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useQuery({ queryKey: ["entities", type], queryFn: () => api.listEntities(type) }),
  );

  const results = useMemo(() => {
    const all = queries.flatMap((q) => q.data ?? []);
    return all
      .map((e) => ({ entity: e, rank: score(e.title, query) }))
      .filter((r) => r.rank >= 0)
      .sort((a, b) => b.rank - a.rank || a.entity.title.localeCompare(b.entity.title))
      .slice(0, MAX_RESULTS)
      .map((r) => r.entity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ...queries.map((q) => q.data)]);

  // Keep the cursor on a real row as the result set shrinks.
  const selected = Math.min(cursor, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (entity: Entity | undefined) => {
    if (!entity) return;
    onSelect(entity.id);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick open"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: backdrop,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "15vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 90vw)",
          background: color.bg,
          border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.lg,
          boxShadow: shadow,
          overflow: "hidden",
        }}
      >
        <input
          autoFocus
          aria-label="Search entities"
          placeholder="Search requirements, blueprints, work orders, artifacts…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor(Math.min(selected + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor(Math.max(selected - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(results[selected]);
            }
          }}
          style={{
            width: "100%",
            padding: `${space(3)}px ${space(4)}px`,
            border: "none",
            borderBottom: `1px solid ${color.border}`,
            background: "transparent",
            fontSize: font.base,
            outline: "none",
          }}
        />
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Results"
          style={{ listStyle: "none", margin: 0, padding: space(1), maxHeight: "45vh", overflowY: "auto" }}
        >
          {results.length === 0 && (
            <li style={{ padding: `${space(2)}px ${space(3)}px`, color: color.faint, fontSize: font.sm }}>
              No matches.
            </li>
          )}
          {results.map((e, i) => (
            <li key={e.id} role="option" aria-selected={i === selected}>
              <button
                onClick={() => open(e)}
                onMouseMove={() => setCursor(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space(2),
                  width: "100%",
                  textAlign: "left",
                  padding: `${space(1.5)}px ${space(2)}px`,
                  border: "none",
                  borderRadius: radius.sm,
                  background: i === selected ? color.selection : "transparent",
                  cursor: "pointer",
                  fontSize: font.sm,
                }}
              >
                <Badge type={e.type} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.title}
                </span>
                {e.status && (
                  <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: font.xs, color: color.muted }}>
                    {e.status}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
