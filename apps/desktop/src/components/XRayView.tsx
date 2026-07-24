import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EntityType, LinkType, WorkOrderStatus } from "@kiln/core";
import { api } from "../lib/client";
import { contextRoute, navigate } from "../lib/route";
import { boundingRect, COLUMN_WIDTH, layoutXRay } from "../lib/layout";
import { traceLineage } from "../lib/lineage";
import { summarizeXRayContext, type XRayContextSummary } from "../lib/xray-context";
import { Badge, Button, Chevron, Select } from "./ui";
import { color, font, radius, shadow, space } from "../theme";

type OverlayKey = "gaps" | "blocked" | "critical";
// Overlay accents: gaps = attention, blocked = problem, critical = the path.
const OVERLAY_COLOR: Record<OverlayKey, string> = {
  gaps: color.warn,
  blocked: color.danger,
  critical: color.accent,
};

// The Project X-ray (Phase 7): the whole knowledge graph on one canvas —
// intent on the left flowing rightward into work orders (columns by pipeline
// stage), typed directional edges, nodes colored by status. Layered for two
// reading depths: glance (status panel, labeled columns, lane progress,
// overlay counts, minimap) and inspect (hover tooltip, lineage trace with a
// detail card, overlays).

// Left-accent color per entity type (matches the entity badges in index.css).
const TYPE_ACCENT: Record<EntityType, string> = {
  artifact: "var(--k-art-fg)",
  requirement: "var(--k-req-fg)",
  blueprint: "var(--k-bp-fg)",
  work_order: "var(--k-wo-fg)",
};

// Work-order status dot color (same mapping as the board).
const STATUS_COLOR: Record<WorkOrderStatus, string> = {
  draft: color.faint,
  ready: color.warn,
  in_progress: color.info,
  done: color.ok,
  cancelled: color.danger,
};

// Typed edges are color-coded; depends_on (the execution gate) is also dashed.
const EDGE_COLOR: Record<LinkType, string> = {
  references: color.faint,
  details: "var(--k-bp-fg)",
  implements: "var(--k-wo-fg)",
  child_of: color.borderStrong,
  depends_on: color.accent,
};

// Pipeline column headers, in stage order (matches STAGE in lib/layout).
const STAGE_LABEL: { type: EntityType; label: string }[] = [
  { type: "artifact", label: "Artifacts" },
  { type: "requirement", label: "Requirements" },
  { type: "blueprint", label: "Blueprints" },
  { type: "work_order", label: "Work orders" },
];
const HEADER_Y = -56;

type KilnNodeData = {
  title: string;
  type: EntityType;
  status: WorkOrderStatus | null;
  progress: number | null;
  overlays?: OverlayKey[];
  traced?: boolean;
};

function KilnNode({ data }: NodeProps) {
  const d = data as KilnNodeData;
  // Requirements/blueprints fill left-to-right by rolled-up completion (WO⑤):
  // a done feature reads as a solid bar, a half-built one is half filled.
  const hasFill = (d.type === "requirement" || d.type === "blueprint") && d.progress !== null;
  const pct = hasFill ? Math.round((d.progress as number) * 100) : null;
  const background = hasFill
    ? `linear-gradient(to right, var(--k-ins-bg) ${pct}%, ${color.surface} ${pct}%)`
    : color.surface;
  // Rings nest outward: the traced node first (accent), then any overlays.
  let spread = 0;
  const ringColors = [...(d.traced ? [color.accent] : []), ...(d.overlays ?? []).map((o) => OVERLAY_COLOR[o])];
  const rings = ringColors.map((c) => `0 0 0 ${(spread += 2)}px ${c}`);
  const boxShadow = rings.length ? rings.join(", ") : shadow;
  return (
    <div
      style={{
        width: 240,
        display: "flex",
        alignItems: "center",
        gap: space(1.5),
        padding: `${space(1.5)}px ${space(2)}px`,
        borderRadius: radius.md,
        border: `1px solid ${color.border}`,
        borderLeft: `3px solid ${TYPE_ACCENT[d.type]}`,
        background,
        fontSize: font.sm,
        boxShadow,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 1, height: 1 }} />
      <Badge type={d.type} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.title}
      </span>
      {d.status && (
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[d.status], flexShrink: 0 }}
        />
      )}
      {pct !== null && (
        <span style={{ fontSize: font.xs, color: color.muted, flexShrink: 0 }}>{pct}%</span>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 1, height: 1 }} />
    </div>
  );
}

// A feature swimlane rendered as a background node (zIndex below the graph, so
// it never occludes the entities that sit in it). The chip carries the lane's
// rolled-up work-order progress so each feature's health reads at a glance.
function LaneNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    width: number;
    height: number;
    striped: boolean;
    done: number;
    total: number;
  };
  return (
    <div
      style={{
        width: d.width,
        height: d.height,
        background: d.striped ? color.surface : "transparent",
        borderTop: `1px solid ${color.border}`,
        borderRadius: radius.md,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: space(1.5),
          margin: `${space(1.5)}px 0 0 ${space(2)}px`,
          padding: `2px ${space(2)}px`,
          background: color.chip,
          border: `1px solid ${color.border}`,
          borderRadius: 999,
          fontSize: font.xs,
          fontWeight: 700,
          color: color.muted,
          whiteSpace: "nowrap",
          maxWidth: COLUMN_WIDTH + 80,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</span>
        {d.total > 0 && (
          <span
            style={{
              fontWeight: 400,
              color: d.done === d.total ? color.ok : color.muted,
              flexShrink: 0,
            }}
          >
            {d.done}/{d.total} done
          </span>
        )}
      </span>
    </div>
  );
}

// A pipeline-stage column header, pinned above the first lane. Rendered as a
// graph node so it pans/zooms with the columns it labels.
function ColumnHeaderNode({ data }: NodeProps) {
  const d = data as { label: string; count: number; accent: string };
  return (
    <div
      style={{
        width: 240,
        display: "flex",
        alignItems: "baseline",
        gap: space(2),
        pointerEvents: "none",
        borderBottom: `2px solid ${d.accent}`,
        paddingBottom: space(1),
      }}
    >
      <span
        style={{
          fontSize: font.sm,
          fontWeight: 700,
          color: color.text,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {d.label}
      </span>
      <span style={{ fontSize: font.xs, color: color.muted }}>{d.count}</span>
    </div>
  );
}

const nodeTypes = { kiln: KilnNode, lane: LaneNode, colhead: ColumnHeaderNode };
const LANE_WIDTH = 4 * COLUMN_WIDTH + 80;

// One dot + label + count row (status panel doubles as the legend).
function LegendRow({ dot, label, count, dashed }: { dot: string; label: string; count?: number; dashed?: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: space(1.5) }}>
      {dashed ? (
        <span style={{ width: 16, borderTop: `2px dashed ${dot}`, flexShrink: 0 }} />
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {count !== undefined && <span style={{ fontWeight: 700, color: color.text }}>{count}</span>}
    </span>
  );
}

// A small labeled chip for the context card's health/handoff facts.
function GlanceChip({ label, fg }: { label: string; fg: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${color.border}`,
        borderRadius: 999,
        background: color.chip,
        padding: `1px ${space(2)}px`,
        fontSize: font.xs,
        color: fg,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

const SEVERITY_CHIP: Record<XRayContextSummary["severity"], { label: string; fg: string }> = {
  ready: { label: "ready", fg: color.ok },
  info: { label: "info", fg: color.info },
  warn: { label: "warnings", fg: color.warn },
  error: { label: "errors", fg: color.danger },
};

const HANDOFF_CHIP: Record<XRayContextSummary["handoff"], { label: string; fg: string }> = {
  never: { label: "Never handed off", fg: color.muted },
  current: { label: "Matches latest handoff", fg: color.ok },
  changed: { label: "Changed since latest handoff", fg: color.warn },
};

const CHAIN_PREFIX: Record<XRayContextSummary["chain"][number]["type"], string> = {
  requirement: "REQ",
  blueprint: "BP",
  work_order: "WO",
};

// Context at a glance (BP-13): the agent handoff explained in summary density —
// the assembled chain, artifact provenance, size/health, and freshness vs the
// newest receipt. Never blocks the document below it.
function ContextGlanceCard({
  pending,
  failed,
  summary,
}: {
  pending: boolean;
  failed: boolean;
  summary: XRayContextSummary | null;
}) {
  const tokens =
    summary && summary.estTokens >= 1000 ? `~${(summary.estTokens / 1000).toFixed(1)}k tok` : `~${summary?.estTokens} tok`;
  return (
    <div
      data-testid="context-glance"
      style={{
        background: color.bg,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: space(2.5),
        display: "grid",
        gap: space(1.5),
        fontSize: font.xs,
      }}
    >
      <div style={{ fontWeight: 700, color: color.text }}>Context at a glance</div>
      {pending ? (
        <span style={{ color: color.faint }}>assembling context…</span>
      ) : failed || !summary ? (
        <span style={{ color: color.faint }}>Context unavailable — the document below is unaffected.</span>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: space(1) }}>
            {summary.chain.map((item, i) => (
              <span
                key={item.type}
                style={{ display: "inline-flex", alignItems: "center", gap: space(1), minWidth: 0 }}
              >
                {i > 0 && <span style={{ color: color.faint }}>→</span>}
                <span style={{ fontWeight: 700, color: TYPE_ACCENT[item.type] }}>{CHAIN_PREFIX[item.type]}</span>
                <span
                  title={item.title}
                  style={{
                    maxWidth: 140,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: item.entity ? color.text : color.warn,
                  }}
                >
                  {item.title}
                </span>
              </span>
            ))}
          </div>
          <div style={{ color: color.muted }}>
            Artifacts: {summary.counts.direct} direct · {summary.counts.inherited} inherited
          </div>
          {summary.inherited
            .filter((group) => group.artifacts.length > 0)
            .map((group) => (
              <div
                key={group.requirement.id}
                title={group.requirement.title}
                style={{ color: color.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                via {group.requirement.title}: {group.artifacts.length}
              </div>
            ))}
          <div style={{ display: "flex", alignItems: "center", gap: space(1.5), flexWrap: "wrap" }}>
            <span style={{ color: color.muted }}>{tokens}</span>
            <GlanceChip label={SEVERITY_CHIP[summary.severity].label} fg={SEVERITY_CHIP[summary.severity].fg} />
            <GlanceChip label={HANDOFF_CHIP[summary.handoff].label} fg={HANDOFF_CHIP[summary.handoff].fg} />
          </div>
        </>
      )}
    </div>
  );
}

export function XRayView({ onSelect }: { onSelect: (id: string) => void }) {
  const graph = useQuery({ queryKey: ["graph"], queryFn: () => api.graph() });
  const [on, setOn] = useState<Record<OverlayKey, boolean>>({ gaps: false, blocked: false, critical: false });
  const [panelOpen, setPanelOpen] = useState(true);
  // The viewport controller, captured at init. NOTE: do NOT restructure this
  // into ReactFlowProvider + useReactFlow — tried during Phase 13 and the
  // provider silently broke the initial fitView (viewport stuck at identity
  // on a pristine page). onInit capture is what demonstrably works here.
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  // Always fetched (cheap reads): the counts feed the status panel and the
  // overlay buttons, so a toggle is informed ("Blocked · 3") instead of blind.
  const gapsQ = useQuery({ queryKey: ["gaps"], queryFn: () => api.gaps() });
  const readinessQ = useQuery({ queryKey: ["readiness"], queryFn: () => api.readiness() });
  const criticalQ = useQuery({ queryKey: ["criticalPath"], queryFn: () => api.criticalPath() });

  // Lineage trace (WO⑦): the intent↔execution thread through the clicked node.
  // Since Phase 12 a click also opens the document peek panel — `peek` and
  // `traced` move together: click focuses a node (trace + read), clicking it
  // again / the canvas / ✕ releases it.
  const [traced, setTraced] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const focusNode = (id: string | null) => {
    setTraced(id);
    setPeek(id);
  };

  // Esc dismisses the peek (WO#5 keyboard nav) — the one transient surface the
  // canvas owns. Scoped to when a peek is open so Esc is inert otherwise.
  useEffect(() => {
    if (!traced) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTraced(null);
        setPeek(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [traced]);
  const lineage = useMemo(
    () => (traced && graph.data ? traceLineage(graph.data, traced) : null),
    [traced, graph.data],
  );

  // The peeked entity's full document — the snapshot carries no body.
  const peekEntity = useQuery({
    queryKey: ["entity", peek],
    queryFn: () => api.getEntity(peek!),
    enabled: peek !== null,
  });

  // Context at a glance (BP-13): only work orders have an assembled handoff.
  // Read-only views of what the Context Inspector already fetches — the query
  // keys match it so the cache is shared. Viewing never records a receipt.
  const peekIsWorkOrder =
    peek !== null && graph.data?.nodes.find((n) => n.id === peek)?.type === "work_order";
  const peekContext = useQuery({
    queryKey: ["context", peek],
    queryFn: () => api.context(peek!),
    enabled: peekIsWorkOrder,
  });
  const peekHealth = useQuery({
    queryKey: ["context-health", peek],
    queryFn: () => api.contextHealth(peek!),
    enabled: peekIsWorkOrder,
  });
  const peekReceipts = useQuery({
    queryKey: ["context-receipts", peek],
    queryFn: () => api.contextReceipts(peek!),
    enabled: peekIsWorkOrder,
  });
  const contextSummary = useMemo(
    () =>
      peekContext.data && peekHealth.data && peekReceipts.data
        ? summarizeXRayContext(peekContext.data, peekHealth.data, peekReceipts.data)
        : null,
    [peekContext.data, peekHealth.data, peekReceipts.data],
  );

  // Hover tooltip: which node, anchored where (viewport coordinates).
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  // Glance stats over the snapshot: entity counts per stage and the
  // work-order status distribution (cancelled excluded from the denominator,
  // same rule as the core rollup).
  const stats = useMemo(() => {
    if (!graph.data) return null;
    const byType: Record<EntityType, number> = { artifact: 0, requirement: 0, blueprint: 0, work_order: 0 };
    const byStatus: Record<WorkOrderStatus, number> = { draft: 0, ready: 0, in_progress: 0, done: 0, cancelled: 0 };
    for (const n of graph.data.nodes) {
      byType[n.type]++;
      if (n.status) byStatus[n.status]++;
    }
    const countable = byType.work_order - byStatus.cancelled;
    const pct = countable > 0 ? Math.round((byStatus.done / countable) * 100) : null;
    return { byType, byStatus, countable, pct };
  }, [graph.data]);

  const gapCount = gapsQ.data
    ? gapsQ.data.requirements.length + gapsQ.data.blueprints.length + gapsQ.data.artifacts.length
    : undefined;
  const blockedCount = readinessQ.data ? readinessQ.data.filter((r) => r.blocked).length : undefined;
  const criticalCount = criticalQ.data ? criticalQ.data.path.length : undefined;
  const overlayCount: Record<OverlayKey, number | undefined> = {
    gaps: gapCount,
    blocked: blockedCount,
    critical: criticalCount,
  };

  // Which nodes each active overlay highlights, and which depends_on edges to
  // emphasize (blocked → its blocking edges; critical → the path's edges).
  const hl = useMemo(() => {
    const nodeOverlays = new Map<string, OverlayKey[]>();
    const mark = (id: string, o: OverlayKey) => nodeOverlays.set(id, [...(nodeOverlays.get(id) ?? []), o]);
    const edgeColor = new Map<string, string>();

    if (on.gaps && gapsQ.data)
      for (const arr of [gapsQ.data.requirements, gapsQ.data.blueprints, gapsQ.data.artifacts])
        for (const id of arr) mark(id, "gaps");
    if (on.blocked && readinessQ.data)
      for (const r of readinessQ.data)
        if (r.blocked) {
          mark(r.id, "blocked");
          for (const b of r.blocking) edgeColor.set(`${r.id}-${b.id}-depends_on`, OVERLAY_COLOR.blocked);
        }
    if (on.critical && criticalQ.data) {
      const p = criticalQ.data.path;
      p.forEach((id) => mark(id, "critical"));
      for (let i = 0; i < p.length - 1; i++) edgeColor.set(`${p[i]}-${p[i + 1]}-depends_on`, OVERLAY_COLOR.critical);
    }
    return { nodeOverlays, edgeColor };
  }, [on, gapsQ.data, readinessQ.data, criticalQ.data]);

  const { nodes, edges, lanes } = useMemo(() => {
    if (!graph.data) return { nodes: [] as Node[], edges: [] as Edge[], lanes: [] };
    const { positions, lanes, laneOf } = layoutXRay(graph.data);

    // Per-lane work-order rollup for the lane chips.
    const laneWo: Record<string, { done: number; total: number }> = {};
    for (const n of graph.data.nodes) {
      if (n.type !== "work_order" || n.status === "cancelled") continue;
      const lane = laneOf[n.id];
      const s = (laneWo[lane] ??= { done: 0, total: 0 });
      s.total++;
      if (n.status === "done") s.done++;
    }

    // Lane bands first, as background nodes behind the graph.
    const laneNodes: Node[] = lanes.map((lane, i) => ({
      id: `lane-${lane.id}`,
      type: "lane",
      position: { x: -40, y: lane.y },
      // Explicit dimensions: with controlled nodes (no onNodesChange) measured
      // sizes never reach the user node objects, and the MiniMap skips nodes
      // without dimensions.
      width: LANE_WIDTH,
      height: lane.height,
      data: {
        label: lane.label,
        width: LANE_WIDTH,
        height: lane.height,
        striped: i % 2 === 0,
        done: laneWo[lane.id]?.done ?? 0,
        total: laneWo[lane.id]?.total ?? 0,
      },
      draggable: false,
      selectable: false,
      zIndex: -1,
    }));
    // Pipeline-stage headers above the first lane, one per column.
    const byType: Record<EntityType, number> = { artifact: 0, requirement: 0, blueprint: 0, work_order: 0 };
    for (const n of graph.data.nodes) byType[n.type]++;
    const headerNodes: Node[] = STAGE_LABEL.map((s, col) => ({
      id: `colhead-${s.type}`,
      type: "colhead",
      position: { x: col * COLUMN_WIDTH, y: HEADER_Y },
      width: 240,
      height: 22,
      data: { label: s.label, count: byType[s.type], accent: TYPE_ACCENT[s.type] },
      draggable: false,
      selectable: false,
    }));
    const entityNodes: Node[] = graph.data.nodes.map((n) => ({
      id: n.id,
      type: "kiln",
      position: positions[n.id] ?? { x: 0, y: 0 },
      width: 240,
      height: 30,
      data: {
        title: n.title,
        type: n.type,
        status: n.status,
        progress: n.progress,
        overlays: hl.nodeOverlays.get(n.id),
        traced: n.id === traced,
      },
      // Dim everything off the traced thread.
      style: lineage && !lineage.nodes.has(n.id) ? { opacity: 0.12 } : undefined,
    }));
    const nodes = [...laneNodes, ...headerNodes, ...entityNodes];
    const edges: Edge[] = graph.data.edges.map((e) => {
      const key = `${e.fromId}-${e.toId}-${e.type}`;
      const emphasis = hl.edgeColor.get(key);
      const offThread = lineage ? !lineage.edges.has(key) : false;
      // Cross-lane edges (an artifact shared between features, say) are drawn but
      // quieted so the within-feature flow reads first — unless an overlay
      // emphasizes them. A lineage trace dims everything off the thread.
      const crossLane = laneOf[e.fromId] !== laneOf[e.toId];
      const baseOpacity = emphasis ? 1 : crossLane ? 0.25 : 0.8;
      return {
        id: key,
        source: e.fromId,
        target: e.toId,
        zIndex: emphasis ? 10 : 0,
        style: {
          stroke: emphasis ?? EDGE_COLOR[e.type],
          strokeWidth: emphasis ? 3 : 1.5,
          opacity: offThread ? 0.05 : baseOpacity,
          ...(e.type === "depends_on" ? { strokeDasharray: "5 4" } : {}),
        },
      };
    });
    return { nodes, edges, lanes };
  }, [graph.data, hl, lineage, traced]);

  const zoomToLane = (laneId: string) => {
    const lane = lanes.find((candidate) => candidate.id === laneId);
    if (!rf || !lane) return;
    void rf.fitBounds(
      { x: -40, y: lane.y, width: LANE_WIDTH, height: lane.height },
      { duration: 500, padding: 0.05 },
    );
  };

  // Frame the active lineage thread (BP-13 §3): fit the viewport to the traced
  // entity nodes' own bounding rectangle. Lineage ids come from the snapshot,
  // so lane bands and column headers are inherently excluded. fitBounds (a
  // plain viewport op) is used instead of fitView({nodes}) — the latter waits
  // on node-initialization state and proved unreliable here.
  const fitThread = () => {
    if (!rf || !lineage) return;
    const rect = boundingRect(
      nodes
        .filter((n) => n.type === "kiln" && lineage.nodes.has(n.id))
        .map((n) => ({ x: n.position.x, y: n.position.y, width: n.width ?? 240, height: n.height ?? 30 })),
    );
    if (rect) void rf.fitBounds(rect, { duration: 500, padding: 0.15 });
  };

  // The traced node's details for the inspect card.
  const tracedNode = traced ? graph.data?.nodes.find((n) => n.id === traced) : undefined;
  const tracedReadiness = traced ? readinessQ.data?.find((r) => r.id === traced) : undefined;
  const threadStats = useMemo(() => {
    if (!lineage || !graph.data) return null;
    const c: Record<EntityType, number> = { artifact: 0, requirement: 0, blueprint: 0, work_order: 0 };
    for (const n of graph.data.nodes) if (lineage.nodes.has(n.id)) c[n.type]++;
    return c;
  }, [lineage, graph.data]);

  const hoverNode = hover ? graph.data?.nodes.find((n) => n.id === hover.id) : undefined;
  const hoverPct =
    hoverNode && hoverNode.progress !== null ? Math.round(hoverNode.progress * 100) : null;

  if (graph.isPending) return <p style={{ padding: space(4), color: color.muted }}>loading the X-ray…</p>;
  if (graph.isError)
    return <p style={{ padding: space(4), color: color.danger }}>Couldn't load the graph — is the sidecar running?</p>;
  if (nodes.length === 0)
    return <p style={{ padding: space(4), color: color.muted }}>No entities yet — create a requirement to see the X-ray.</p>;

  return (
    <div data-testid="xray-view" style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        // Single click focuses a node — traces its lineage thread AND opens the
        // document peek panel (toggle); double-click opens the full document
        // view; clicking empty canvas releases the focus.
        onNodeClick={(_, node) => node.type === "kiln" && focusNode(traced === node.id ? null : node.id)}
        onNodeDoubleClick={(_, node) => node.type === "kiln" && onSelect(node.id)}
        onNodeMouseEnter={(event, node) =>
          node.type === "kiln" && setHover({ id: node.id, x: event.clientX, y: event.clientY })
        }
        onNodeMouseLeave={() => setHover(null)}
        onPaneClick={() => focusNode(null)}
        onInit={setRf}
        fitView
        minZoom={0.15}
        nodesConnectable={false}
        nodesDraggable={false}
        style={{ background: color.bg }}
      >
        <Background color={color.border} gap={22} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          style={{ background: color.surface }}
          nodeStrokeWidth={0}
          nodeColor={(n) =>
            n.type === "kiln"
              ? TYPE_ACCENT[(n.data as KilnNodeData).type]
              : n.type === "lane"
                ? color.inset
                : "transparent"
          }
          maskColor={color.selection}
        />
        <Panel position="top-right">
          <div style={{ display: "flex", alignItems: "center", gap: space(1) }}>
            <Select
              aria-label="Find feature"
              value=""
              disabled={!rf || lanes.length === 0}
              onChange={(event) => zoomToLane(event.target.value)}
              style={{ width: 220, background: color.surface }}
            >
              <option value="">Find feature…</option>
              {lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>
                  {lane.label}
                </option>
              ))}
            </Select>
            {(["gaps", "blocked", "critical"] as OverlayKey[]).map((o) => {
              const label = o === "critical" ? "Critical path" : o === "gaps" ? "Gaps" : "Blocked";
              const n = overlayCount[o];
              return (
                <Button
                  key={o}
                  variant={on[o] ? "primary" : "ghost"}
                  onClick={() => setOn((s) => ({ ...s, [o]: !s[o] }))}
                  style={{ borderBottom: `2px solid ${on[o] ? OVERLAY_COLOR[o] : "transparent"}` }}
                >
                  {label}
                  {n !== undefined && (
                    <span style={{ marginLeft: space(1), opacity: 0.75, fontWeight: 400 }}>{n}</span>
                  )}
                </Button>
              );
            })}
          </div>
        </Panel>
        <Panel position="top-left">
          {/* Project status: the glance layer. Doubles as the legend — every
              dot in the panel is also a count over the live graph. */}
          <div
            style={{
              background: color.surface,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              padding: `${space(2)}px ${space(2.5)}px`,
              fontSize: font.xs,
              color: color.muted,
              boxShadow: shadow,
              width: 190,
            }}
          >
            <button
              onClick={() => setPanelOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space(1),
                width: "100%",
                border: "none",
                background: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: font.xs,
                fontWeight: 700,
                color: color.text,
              }}
            >
              <span style={{ flex: 1, textAlign: "left" }}>Project status</span>
              {stats?.pct !== null && stats !== null && (
                <span style={{ color: stats.pct === 100 ? color.ok : color.muted }}>{stats.pct}%</span>
              )}
              <Chevron open={panelOpen} />
            </button>
            {stats && stats.pct !== null && (
              <div
                aria-hidden
                style={{
                  height: 5,
                  borderRadius: 999,
                  background: color.inset,
                  margin: `${space(1.5)}px 0`,
                  overflow: "hidden",
                }}
              >
                <div style={{ width: `${stats.pct}%`, height: "100%", background: color.ok }} />
              </div>
            )}
            {panelOpen && stats && (
              <>
                <div style={{ display: "grid", gap: 3, margin: `${space(1.5)}px 0 ${space(2)}px` }}>
                  {(Object.keys(STATUS_COLOR) as WorkOrderStatus[]).map((s) => (
                    <LegendRow key={s} dot={STATUS_COLOR[s]} label={s.replace("_", " ")} count={stats.byStatus[s]} />
                  ))}
                  <LegendRow dot={color.danger} label="blocked" count={blockedCount} />
                </div>
                <div style={{ fontWeight: 700, marginBottom: space(1), color: color.text }}>Reading the map</div>
                <div style={{ display: "grid", gap: 3 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: space(1.5) }}>
                    <span
                      style={{
                        width: 16,
                        height: 9,
                        borderRadius: 2,
                        border: `1px solid ${color.border}`,
                        background: `linear-gradient(to right, var(--k-ins-bg) 60%, ${color.surface} 60%)`,
                        flexShrink: 0,
                      }}
                    />
                    fill = % of work done
                  </span>
                  <LegendRow dot={color.accent} label="depends on" dashed />
                  <span style={{ marginTop: space(1) }}>
                    Click a card to trace + read it; double-click to open it.
                  </span>
                </div>
              </>
            )}
          </div>
        </Panel>
      </ReactFlow>
      {tracedNode && (
        // Document peek panel (Phase 12): the focused node's document, readable
        // in place. Docked over the canvas, below the overlay buttons; the old
        // inspect card's facts live in its header. The map stays underneath —
        // closing the panel restores your place.
        <div
          data-testid="peek-panel"
          style={{
            position: "absolute",
            top: 52,
            right: space(3),
            bottom: space(3),
            width: 380,
            zIndex: 20,
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow,
            padding: space(3),
            display: "flex",
            flexDirection: "column",
            gap: space(2),
            fontSize: font.sm,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: space(1.5) }}>
            <Badge type={tracedNode.type} />
            {tracedNode.status && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space(1),
                  fontSize: font.xs,
                  color: color.muted,
                }}
              >
                <span
                  style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[tracedNode.status] }}
                />
                {tracedNode.status.replace("_", " ")}
              </span>
            )}
            {tracedNode.progress !== null && (
              <span style={{ fontSize: font.xs, color: color.muted }}>
                {Math.round(tracedNode.progress * 100)}% done
              </span>
            )}
            <button
              aria-label="Close document panel"
              title="Close (Esc)"
              onClick={() => focusNode(null)}
              style={{
                marginLeft: "auto",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: color.muted,
                fontSize: font.base,
                padding: 0,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontWeight: 700, color: color.text }}>{tracedNode.title}</div>
          {tracedReadiness?.blocked && (
            <div style={{ fontSize: font.xs, color: color.danger }}>
              Blocked by: {tracedReadiness.blocking.map((b) => b.title).join(", ")}
            </div>
          )}
          {threadStats && (
            <div style={{ fontSize: font.xs, color: color.muted }}>
              Thread: {threadStats.artifact} artifacts · {threadStats.requirement} requirements ·{" "}
              {threadStats.blueprint} blueprints · {threadStats.work_order} work orders
            </div>
          )}
          {tracedNode.type === "work_order" && (
            <ContextGlanceCard
              pending={peekContext.isPending || peekHealth.isPending || peekReceipts.isPending}
              failed={peekContext.isError || peekHealth.isError || peekReceipts.isError}
              summary={contextSummary}
            />
          )}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              background: color.bg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              padding: space(2.5),
              color: color.text,
            }}
          >
            {peekEntity.isPending ? (
              <span style={{ color: color.faint }}>loading…</span>
            ) : peekEntity.data?.body.trim() ? (
              peekEntity.data.body
            ) : (
              <span style={{ color: color.faint }}>No content yet.</span>
            )}
          </div>
          <div style={{ display: "flex", gap: space(2) }}>
            <Button variant="primary" onClick={() => onSelect(tracedNode.id)}>
              Open in Documents
            </Button>
            {tracedNode.type === "work_order" && (
              <Button
                variant="ghost"
                title="Open in Documents with the agent's assembled context already in view"
                onClick={() => navigate(contextRoute(tracedNode.id))}
              >
                Frame context
              </Button>
            )}
            {tracedNode.type === "work_order" && (
              <Button
                variant="ghost"
                title="Fit the canvas to this work order's lineage thread"
                disabled={!rf || !lineage}
                onClick={fitThread}
              >
                Fit thread
              </Button>
            )}
          </div>
        </div>
      )}
      {hover && hoverNode && hover.id !== traced && (
        <div
          style={{
            position: "fixed",
            left: hover.x + 14,
            top: hover.y + 14,
            zIndex: 50,
            pointerEvents: "none",
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow,
            padding: `${space(2)}px ${space(2.5)}px`,
            maxWidth: 300,
            display: "grid",
            gap: space(1),
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: space(1.5) }}>
            <Badge type={hoverNode.type} />
            {hoverNode.status && (
              <span style={{ fontSize: font.xs, color: color.muted }}>{hoverNode.status.replace("_", " ")}</span>
            )}
            {hoverPct !== null && (
              <span style={{ fontSize: font.xs, color: color.muted }}>{hoverPct}% done</span>
            )}
          </div>
          <div style={{ fontSize: font.sm, color: color.text, fontWeight: 600 }}>{hoverNode.title}</div>
          <div style={{ fontSize: font.xs, color: color.faint }}>
            Click to trace + read · double-click to open
          </div>
        </div>
      )}
    </div>
  );
}
