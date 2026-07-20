import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HealthLevel, WorkOrderContext } from "@kiln/core";
import { api } from "../lib/client";
import { diffLines } from "../lib/diff";
import {
  contextDocs,
  contextVerdict,
  mapCheckTarget,
  renderContextText,
  sectionDrift,
  totalChars,
  type ContextDoc,
  type TargetKey,
} from "../lib/context-inspect";
import { timeAgo } from "../lib/time";
import { Badge, BlockedBadge, Button, Chevron, SectionHeader } from "./ui";
import { color, font, radius, space } from "../theme";

// The Context Assembly Inspector (Phase 8, redesigned in Phase 17 around the
// two questions users bring to it). "Context" = pre-flight: a verdict, then
// exactly what an agent receives — scannable rows, expand to read. "Receipts"
// = forensic: the recorded handoff history, diffed against now — so a bug can
// be traced back to the context the agent was actually given.

const LEVEL_COLOR: Record<HealthLevel, string> = {
  error: color.danger,
  warn: color.warn,
  info: color.muted,
};
const LEVEL_ORDER: Record<HealthLevel, number> = { error: 0, warn: 1, info: 2 };

const bodyBox = {
  margin: `${space(1)}px 0 ${space(1)}px ${space(5)}px`,
  padding: `${space(1.5)}px ${space(2)}px`,
  background: color.inset,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  fontFamily: "ui-monospace, monospace",
  fontSize: font.xs,
  whiteSpace: "pre-wrap" as const,
  maxHeight: 260,
  overflowY: "auto" as const,
};

const none = <p style={{ color: color.faint, fontSize: font.sm, margin: 0 }}>— none</p>;

// One context document as a collapsible row: type badge, title, size, and a
// thin bar showing its share of the whole context — "where the tokens go".
function DocRow({
  doc,
  share,
  expanded,
  flashing,
  onToggle,
  onFlashEnd,
  indent = false,
}: {
  doc: ContextDoc;
  share: number;
  expanded: boolean;
  flashing: boolean;
  onToggle: () => void;
  onFlashEnd: () => void;
  indent?: boolean;
}) {
  return (
    <div
      id={`ctx-${doc.key}`}
      className={flashing ? "kiln-flash" : undefined}
      onAnimationEnd={onFlashEnd}
      style={{ borderRadius: radius.sm, marginLeft: indent ? space(4) : 0 }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space(1.5),
          width: "100%",
          minWidth: 0,
          padding: `${space(1)}px 0`,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <Chevron open={expanded} />
        <Badge type={doc.entity.type} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: font.sm,
            fontWeight: 600,
            color: color.text,
          }}
        >
          {doc.entity.title}
        </span>
        <span style={{ fontSize: font.xs, color: color.muted, whiteSpace: "nowrap" }}>
          {doc.chars.toLocaleString()} ch · ~{Math.ceil(doc.chars / 4).toLocaleString()} tok
        </span>
      </button>
      <div
        aria-hidden
        style={{
          height: 3,
          marginLeft: space(5),
          background: color.inset,
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div style={{ height: "100%", width: `${Math.max(share * 100, 0.5)}%`, background: color.borderStrong }} />
      </div>
      {expanded &&
        (doc.entity.body.trim() ? (
          <pre style={bodyBox}>{doc.entity.body}</pre>
        ) : (
          <p style={{ margin: `${space(1)}px 0 0 ${space(5)}px`, color: color.faint, fontSize: font.xs }}>(empty body)</p>
        ))}
    </div>
  );
}

function Section({
  title,
  id,
  flashing,
  onFlashEnd,
  children,
}: {
  title: string;
  id?: string;
  flashing?: boolean;
  onFlashEnd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={flashing ? "kiln-flash" : undefined}
      onAnimationEnd={onFlashEnd}
      style={{ marginBottom: space(3), borderRadius: radius.sm }}
    >
      <SectionHeader size="sm">{title}</SectionHeader>
      {children}
    </section>
  );
}

type Receipt = { id: string; createdAt: string; hash: string; context: WorkOrderContext };

// The forensic view (redesigned in Phase 17): a newest-first handoff timeline.
// Click a handoff to compare it with now — the Phase 13 glance-chip question —
// or shift-click to set the other end and compare any two points. A
// section-level drift summary answers most investigations before the raw diff.
function ReceiptHistory({ current, receipts }: { current: WorkOrderContext; receipts: Receipt[] }) {
  // Receipts arrive oldest-first (insertion order); the timeline reads newest-first.
  const newestFirst = useMemo(() => [...receipts].reverse(), [receipts]);
  const items = useMemo(
    () => [
      { key: "current", title: "Current context (now)", hash: null as string | null, marker: null as string | null, ctx: current },
      ...newestFirst.map((r, i) => {
        // The chronologically previous handoff is the NEXT entry newest-first.
        const prev = newestFirst[i + 1];
        return {
          key: r.id,
          title: timeAgo(r.createdAt),
          hash: r.hash.slice(0, 8),
          marker: prev ? (prev.hash === r.hash ? "same as previous" : "changed since previous") : "first handoff",
          ctx: r.context,
        };
      }),
    ],
    [current, newestFirst],
  );
  // Default: latest handoff → now ("has it changed since the agent got it?").
  const latest = newestFirst[0];
  const [fromKey, setFromKey] = useState(latest.id);
  const [toKey, setToKey] = useState("current");
  const from = items.find((i) => i.key === fromKey) ?? items[items.length - 1];
  const to = items.find((i) => i.key === toKey) ?? items[0];

  const select = (key: string, otherEnd: boolean) => {
    if (otherEnd) {
      setToKey(key);
    } else {
      // The common case: this point vs now. Clicking "now" resets the default.
      setFromKey(key === "current" ? latest.id : key);
      setToKey("current");
    }
  };

  const drift = useMemo(() => sectionDrift(from.ctx, to.ctx), [from, to]);
  const changed = drift.filter((d) => d.kind !== "unchanged");
  const diff = useMemo(() => diffLines(renderContextText(from.ctx), renderContextText(to.ctx)), [from, to]);

  const DRIFT_COLOR: Record<string, string> = { added: color.ins, removed: color.del, changed: color.warn };

  const slotChip = (label: string) => (
    <span
      style={{
        fontSize: font.xs,
        fontWeight: 700,
        color: color.accent,
        border: `1px solid ${color.borderStrong}`,
        borderRadius: 999,
        padding: `0 ${space(1.5)}px`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );

  return (
    <div>
      <p style={{ margin: `0 0 ${space(2)}px`, fontSize: font.xs, color: color.faint }}>
        {receipts.length} recorded handoff{receipts.length === 1 ? "" : "s"} — click one to compare with now,
        shift-click to set the other end.
      </p>

      <ol data-testid="receipt-timeline" style={{ listStyle: "none", margin: `0 0 ${space(3)}px`, padding: 0, display: "grid", gap: 2 }}>
        {items.map((item) => {
          const isFrom = item.key === from.key;
          const isTo = item.key === to.key;
          return (
            <li key={item.key}>
              <button
                onClick={(e) => select(item.key, e.shiftKey)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space(1.5),
                  width: "100%",
                  minWidth: 0,
                  padding: `${space(1)}px ${space(1.5)}px`,
                  border: `1px solid ${isFrom || isTo ? color.borderStrong : "transparent"}`,
                  borderRadius: radius.sm,
                  background: isFrom || isTo ? color.selection : "transparent",
                  cursor: "pointer",
                  font: "inherit",
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: font.sm, fontWeight: item.key === "current" ? 600 : 400, color: color.text, whiteSpace: "nowrap" }}>
                  {item.title}
                </span>
                {item.hash && (
                  <span style={{ fontSize: font.xs, fontFamily: "ui-monospace, monospace", color: color.muted }}>{item.hash}</span>
                )}
                {item.marker && (
                  <span style={{ fontSize: font.xs, color: color.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.marker}
                  </span>
                )}
                <span style={{ marginLeft: "auto", display: "flex", gap: space(1) }}>
                  {isFrom && slotChip("from")}
                  {isTo && slotChip("to")}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div data-testid="drift-summary" style={{ marginBottom: space(2) }}>
        {changed.length === 0 ? (
          <p style={{ margin: 0, fontSize: font.sm, color: color.ok }}>
            No drift — the context is identical between these points.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(0.5) }}>
            {changed.map((d) => (
              <li key={d.key} style={{ fontSize: font.sm, display: "flex", gap: space(1.5), alignItems: "baseline" }}>
                <span style={{ color: DRIFT_COLOR[d.kind], fontWeight: 700, fontSize: font.xs, whiteSpace: "nowrap" }}>
                  {d.kind}
                </span>
                <span style={{ minWidth: 0 }}>
                  {d.label} “{d.title}”
                </span>
              </li>
            ))}
          </ul>
        )}
        {drift.length - changed.length > 0 && (
          <p style={{ margin: `${space(1)}px 0 0`, fontSize: font.xs, color: color.faint }}>
            {drift.length - changed.length} section{drift.length - changed.length === 1 ? "" : "s"} unchanged
            {changed.length > 0 ? " — raw diff below: green = added since, red = removed." : "."}
          </p>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          padding: space(2),
          border: `1px solid ${color.border}`,
          borderRadius: radius.sm,
          maxHeight: 380,
          overflowY: "auto",
          fontSize: font.xs,
          fontFamily: "ui-monospace, monospace",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          background: color.bg,
        }}
      >
        {diff.map((line, i) => (
          <div key={i} className={line.kind === "added" ? "kiln-ins" : line.kind === "removed" ? "kiln-del" : undefined}>
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ContextInspector({ entityId }: { entityId: string }) {
  const [mode, setMode] = useState<"context" | "receipts">("context");
  // Expansion is per-doc-key; the work order itself defaults open (it's what
  // you're shipping), everything else closed. Keys embed entity ids, so
  // switching documents naturally resets to the defaults.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<TargetKey | null>(null);
  const [copied, setCopied] = useState(false);

  const ctx = useQuery({ queryKey: ["context", entityId], queryFn: () => api.context(entityId) });
  const health = useQuery({ queryKey: ["context-health", entityId], queryFn: () => api.contextHealth(entityId) });
  const deps = useQuery({ queryKey: ["linked", entityId, "depends_on"], queryFn: () => api.linked(entityId, "depends_on") });
  const receipts = useQuery({ queryKey: ["context-receipts", entityId], queryFn: () => api.contextReceipts(entityId) });
  // Blocked-ness comes from the same bulk readiness the board renders (WO-B2),
  // so dependency state reads identically everywhere. Quiet on failure: no
  // data -> empty set -> today's plain rendering.
  const readiness = useQuery({ queryKey: ["readiness"], queryFn: api.readiness });
  const blockingIds = new Set(
    (readiness.data?.find((r) => r.id === entityId)?.blocking ?? []).map((b) => b.id),
  );

  if (ctx.isPending) return <p style={{ padding: space(4), color: color.muted }}>loading context…</p>;
  if (ctx.isError || !ctx.data)
    return <p style={{ padding: space(4), color: color.muted }}>Open a work order to inspect its context.</p>;
  const c = ctx.data;

  const docs = contextDocs(c);
  const total = totalChars(docs);
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const isExpanded = (key: string) => expandOverrides[key] ?? key.startsWith("doc-wo-");
  const toggle = (key: string) => setExpandOverrides((o) => ({ ...o, [key]: !isExpanded(key) }));

  // A health check that maps to a document jumps there: expand, scroll, flash.
  const jumpTo = (target: TargetKey) => {
    if (target.startsWith("doc-") && !isExpanded(target)) setExpandOverrides((o) => ({ ...o, [target]: true }));
    setFlash(target);
    // setTimeout, not requestAnimationFrame: rAF pauses in hidden tabs (see the
    // XRayView lesson), and the expand above must commit before we can scroll.
    setTimeout(() => {
      document.getElementById(`ctx-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  };

  const copyContext = () => {
    navigator.clipboard
      .writeText(renderContextText(c))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const checks = [...(health.data?.checks ?? [])].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const verdict = health.data ? contextVerdict(health.data.checks) : null;
  const receiptCount = receipts.data?.length ?? 0;

  const docRow = (doc: ContextDoc, indent = false) => (
    <DocRow
      key={doc.key}
      doc={doc}
      indent={indent}
      share={total > 0 ? doc.chars / total : 0}
      expanded={isExpanded(doc.key)}
      flashing={flash === doc.key}
      onToggle={() => toggle(doc.key)}
      onFlashEnd={() => setFlash(null)}
    />
  );

  const tab = (m: "context" | "receipts", label: string) => (
    <button
      onClick={() => setMode(m)}
      style={{
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: `${space(1)}px 0`,
        fontSize: font.sm,
        fontWeight: mode === m ? 700 : 400,
        color: mode === m ? color.text : color.muted,
        borderBottom: `2px solid ${mode === m ? color.accent : "transparent"}`,
      }}
    >
      {label}
    </button>
  );

  return (
    <div data-testid="context-inspector" style={{ padding: space(4), overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space(2) }}>
        <SectionHeader>Context inspector</SectionHeader>
        {health.data && (
          <span
            data-testid="context-size"
            style={{
              fontSize: font.xs,
              color: color.muted,
              background: color.chip,
              border: `1px solid ${color.border}`,
              borderRadius: 999,
              padding: `1px ${space(2)}px`,
              whiteSpace: "nowrap",
            }}
          >
            {health.data.size.chars.toLocaleString()} chars · ~{health.data.size.estTokens.toLocaleString()} tokens
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: space(3), margin: `${space(2)}px 0 ${space(3)}px` }}>
        {tab("context", "Context")}
        {tab("receipts", `Receipts · ${receiptCount}`)}
      </div>

      {mode === "receipts" ? (
        receiptCount === 0 ? (
          <p style={{ color: color.faint, fontSize: font.sm }}>
            No handoffs recorded yet — a coding agent fetching this work order over MCP records one.
          </p>
        ) : (
          <ReceiptHistory current={c} receipts={receipts.data as Receipt[]} />
        )
      ) : (
        <>
          {verdict && (
            <div
              data-testid="context-verdict"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space(2),
                padding: `${space(2)}px ${space(2.5)}px`,
                marginBottom: space(3),
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderLeft: `3px solid ${verdict.ready ? color.ok : verdict.errors > 0 ? color.danger : color.warn}`,
                borderRadius: radius.md,
              }}
            >
              <span
                style={{
                  fontSize: font.sm,
                  fontWeight: 600,
                  color: verdict.ready ? color.ok : verdict.errors > 0 ? color.danger : color.warn,
                }}
              >
                {verdict.ready
                  ? "✓ Ready to hand off"
                  : `Needs attention — ${[
                      verdict.errors > 0 ? `${verdict.errors} error${verdict.errors === 1 ? "" : "s"}` : null,
                      verdict.warnings > 0 ? `${verdict.warnings} warning${verdict.warnings === 1 ? "" : "s"}` : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}`}
              </span>
              <Button variant="ghost" onClick={copyContext} style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
                {copied ? "Copied ✓" : "Copy context"}
              </Button>
            </div>
          )}

          <Section title="Health">
            {checks.length === 0 ? (
              <p style={{ color: color.ok, fontSize: font.sm, margin: 0 }}>No issues found.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(1) }}>
                {checks.map((k, i) => {
                  const target = mapCheckTarget(k, c);
                  const dot = (
                    <span
                      aria-hidden
                      style={{ width: 8, height: 8, borderRadius: "50%", background: LEVEL_COLOR[k.level], flexShrink: 0, marginTop: 4 }}
                    />
                  );
                  if (!target)
                    return (
                      <li key={i} style={{ display: "flex", gap: space(1.5), alignItems: "baseline", fontSize: font.sm }}>
                        {dot}
                        <span>{k.message}</span>
                      </li>
                    );
                  const label = target.startsWith("doc-") ? byKey.get(target as ContextDoc["key"])?.label : null;
                  return (
                    <li key={i}>
                      <button
                        onClick={() => jumpTo(target)}
                        style={{
                          display: "flex",
                          gap: space(1.5),
                          alignItems: "baseline",
                          fontSize: font.sm,
                          width: "100%",
                          textAlign: "left",
                          border: "none",
                          background: "transparent",
                          padding: 0,
                          cursor: "pointer",
                          font: "inherit",
                          color: color.text,
                        }}
                      >
                        {dot}
                        <span>
                          {k.message}{" "}
                          <span style={{ color: color.accent, fontSize: font.xs, whiteSpace: "nowrap" }}>
                            show{label ? ` ${label.toLowerCase()}` : ""} ↓
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Work order" id="ctx-sec-workOrder" flashing={flash === "sec-workOrder"} onFlashEnd={() => setFlash(null)}>
            {docRow(docs[0])}
          </Section>
          <Section title="Blueprint" id="ctx-sec-blueprint" flashing={flash === "sec-blueprint"} onFlashEnd={() => setFlash(null)}>
            {c.blueprint ? docs.filter((d) => d.section === "blueprint").map((d) => docRow(d)) : none}
          </Section>
          <Section title="Requirement" id="ctx-sec-requirement" flashing={flash === "sec-requirement"} onFlashEnd={() => setFlash(null)}>
            {c.requirement ? docs.filter((d) => d.section === "requirement").map((d) => docRow(d)) : none}
          </Section>
          <Section title={`Artifacts · ${c.artifacts.length}`} id="ctx-sec-artifacts" flashing={flash === "sec-artifacts"} onFlashEnd={() => setFlash(null)}>
            {c.artifacts.length === 0 ? none : docs.filter((d) => d.section === "artifacts").map((d) => docRow(d))}
          </Section>
          <Section title={`Inherited lineage · ${c.lineage.length}`} id="ctx-sec-lineage" flashing={flash === "sec-lineage"} onFlashEnd={() => setFlash(null)}>
            {c.lineage.length === 0
              ? none
              : c.lineage.map((l, i) => (
                  <div key={l.requirement.id} style={{ marginBottom: space(2) }}>
                    {i === c.lineage.length - 1 && (
                      <div
                        data-testid="background-divider"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space(2),
                          margin: `${space(2)}px 0`,
                          fontSize: font.xs,
                          color: color.faint,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ flex: 1, borderTop: `1px dashed ${color.border}` }} />
                        Background context — skim; never overrides the work order
                        <span style={{ flex: 1, borderTop: `1px dashed ${color.border}` }} />
                      </div>
                    )}
                    {docRow(byKey.get(`doc-lin-req-${l.requirement.id}`)!)}
                    {l.blueprint && docRow(byKey.get(`doc-lin-bp-${l.blueprint.id}`)!, true)}
                    {l.artifacts.map((a) => docRow(byKey.get(`doc-lin-art-${a.id}`)!, true))}
                  </div>
                ))}
          </Section>
          <Section title={`Dependencies · ${deps.data?.length ?? 0}`}>
            {(deps.data?.length ?? 0) === 0 ? (
              none
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(1) }}>
                {deps.data!.map((d) => (
                  <li key={d.id} style={{ display: "flex", alignItems: "center", gap: space(1.5), fontSize: font.sm }}>
                    <Badge type={d.type} />
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title}</span>
                    {blockingIds.has(d.id) && (
                      <BlockedBadge title={`Not done yet (${d.status ?? "draft"}) — blocks this work order.`} />
                    )}
                    {d.status && <span style={{ marginLeft: "auto", fontSize: font.xs, color: color.muted }}>{d.status}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
