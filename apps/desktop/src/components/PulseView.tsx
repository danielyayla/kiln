import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent, ProjectPulse, WorkOrderHealth, WorkOrderStatus } from "@kiln/core";
import { api } from "../lib/client";
import { timeAgo } from "../lib/time";
import { ProposalsCard } from "./ProposalQueue";
import { Badge, SectionHeader } from "./ui";
import { color, font, radius, space } from "../theme";

// Local literals (type-checked against core) — value imports from @kiln/core
// would drag node:sqlite into the webview bundle.
const STATUSES: WorkOrderStatus[] = ["draft", "ready", "in_progress", "done", "cancelled"];

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<WorkOrderStatus, string> = {
  draft: color.faint,
  ready: color.warn,
  in_progress: color.info,
  done: color.ok,
  cancelled: color.danger,
};

// A KPI cell: the headline number (h2 — the type scale's display size) over a
// quiet caption.
function Kpi({ label, value, tone, testid }: { label: string; value: string; tone?: string; testid: string }) {
  return (
    <div
      data-testid={testid}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        padding: `${space(3)}px ${space(4)}px`,
      }}
    >
      <h2 style={{ margin: 0, color: tone ?? color.text }}>{value}</h2>
      <span style={{ fontSize: font.sm, color: color.muted }}>{label}</span>
    </div>
  );
}

// The X-ray's left→right completion fill, as a standalone bar.
function ProgressBar({ progress }: { progress: number | null }) {
  const pct = progress === null ? 0 : Math.round(progress * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={progress === null ? undefined : pct}
      title={progress === null ? "no work orders yet" : `${pct}% done`}
      style={{
        height: 8,
        borderRadius: 999,
        border: `1px solid ${color.border}`,
        background:
          progress === null
            ? color.inset
            : `linear-gradient(to right, var(--k-ins-bg) ${pct}%, ${color.inset} ${pct}%)`,
      }}
    />
  );
}

// An inline work-order reference that navigates on click.
function WoLink({
  wo,
  onSelect,
}: {
  wo: { id: string; title: string; status: WorkOrderStatus | null };
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(wo.id)}
      title={`${wo.title} (${STATUS_LABEL[wo.status ?? "draft"]})`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space(1.5),
        border: `1px solid ${color.border}`,
        borderRadius: 999,
        background: color.chip,
        padding: `1px ${space(2)}px`,
        cursor: "pointer",
        fontSize: font.xs,
        color: color.text,
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: STATUS_COLOR[wo.status ?? "draft"],
          flexShrink: 0,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{wo.title}</span>
    </button>
  );
}

function FeatureRow({
  feature,
  onSelect,
}: {
  feature: ProjectPulse["features"][number];
  onSelect: (id: string) => void;
}) {
  const active = feature.workOrders.ready + feature.workOrders.in_progress + feature.workOrders.draft;
  const summary =
    feature.progress === null
      ? "no work orders yet"
      : `${feature.workOrders.done} done · ${active} open`;
  return (
    <div
      data-testid={`feature-row-${feature.id}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(feature.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect(feature.id);
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 180px",
        alignItems: "center",
        columnGap: space(4),
        rowGap: space(1),
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: `${space(2.5)}px ${space(4)}px`,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: space(2), minWidth: 0 }}>
        <strong
          style={{ fontSize: font.base, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={feature.title}
        >
          {feature.title}
        </strong>
        {feature.blocked > 0 && (
          <span
            data-testid="feature-blocked"
            title={`${feature.blocked} ready work order(s) blocked by unfinished dependencies`}
            style={{
              fontSize: font.xs,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: color.danger,
              background: color.dangerSurface,
              borderRadius: radius.sm,
              padding: "1px 5px",
              flexShrink: 0,
            }}
          >
            {feature.blocked} BLOCKED
          </span>
        )}
        {feature.gaps > 0 && (
          <span
            data-testid="feature-gaps"
            title="requirements without a blueprint + blueprints without work orders in this subtree"
            style={{
              fontSize: font.xs,
              color: color.warn,
              border: `1px solid ${color.border}`,
              borderRadius: 999,
              padding: `0 ${space(2)}px`,
              flexShrink: 0,
            }}
          >
            {feature.gaps} gap{feature.gaps > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <span style={{ fontSize: font.xs, color: color.muted, textAlign: "right" }}>
        {feature.progress !== null && (
          <strong style={{ color: color.text }}>{Math.round(feature.progress * 100)}% </strong>
        )}
        {summary}
      </span>
      <div style={{ gridColumn: "1 / -1" }}>
        <ProgressBar progress={feature.progress} />
      </div>
    </div>
  );
}

// Rough context size, in the ~4-chars-per-token estimate core uses.
const formatTokens = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`);

// "2h ago"-style relative timestamps live in lib/time (BP-15) — shared with
// the navigator's artifact list.

function SeverityBadge({ level, count }: { level: "error" | "warn"; count: number }) {
  return (
    <span
      style={{
        fontSize: font.xs,
        fontWeight: 700,
        color: level === "error" ? color.danger : color.warn,
        background: level === "error" ? color.dangerSurface : color.chip,
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {count} {level === "error" ? "error" : "warn"}
      {count > 1 ? "s" : ""}
    </span>
  );
}

// One active work order's pre-flight context health (Phase 8 checks, rolled up
// by /pulse/knowledge). The tooltip carries the actual check messages.
function KnowledgeRow({ wo, onSelect }: { wo: WorkOrderHealth; onSelect: (id: string) => void }) {
  const problems = wo.checks.filter((c) => c.level !== "info");
  const tooltip = (problems.length > 0 ? problems : wo.checks).map((c) => `• ${c.message}`).join("\n");
  return (
    <button
      data-testid={`knowledge-${wo.id}`}
      onClick={() => onSelect(wo.id)}
      title={tooltip}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(2),
        width: "100%",
        textAlign: "left",
        border: "none",
        borderBottom: `1px solid ${color.border}`,
        background: "transparent",
        padding: `${space(2)}px ${space(1)}px`,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: STATUS_COLOR[wo.status],
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: font.sm,
          color: color.text,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {wo.title}
      </span>
      {wo.errors > 0 && <SeverityBadge level="error" count={wo.errors} />}
      {wo.warns > 0 && <SeverityBadge level="warn" count={wo.warns} />}
      {wo.errors === 0 && wo.warns === 0 && (
        <span aria-label="healthy context" style={{ fontSize: font.xs, color: color.ok, flexShrink: 0 }}>
          ✓
        </span>
      )}
      <span style={{ fontSize: font.xs, color: color.muted, flexShrink: 0 }}>{formatTokens(wo.estTokens)}</span>
    </button>
  );
}

// A quiet work-order list row (status dot + title) for the Now/Next card.
function WoRow({
  wo,
  onSelect,
}: {
  wo: { id: string; title: string; status: WorkOrderStatus | null };
  onSelect: (id: string) => void;
}) {
  return (
    <button
      data-testid={`now-${wo.id}`}
      onClick={() => onSelect(wo.id)}
      title={wo.title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(2),
        width: "100%",
        textAlign: "left",
        border: "none",
        background: "transparent",
        padding: `${space(1.5)}px ${space(1)}px`,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: STATUS_COLOR[wo.status ?? "draft"],
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: font.sm,
          color: color.text,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {wo.title}
      </span>
    </button>
  );
}

const EVENT_GLYPH: Record<ActivityEvent["kind"], { glyph: string; label: string }> = {
  created: { glyph: "＋", label: "created" },
  revised: { glyph: "✎", label: "revised" },
  handoff: { glyph: "⇥", label: "handed to an agent" },
  completed: { glyph: "✓", label: "completed by an agent" },
};

function ActivityRow({ event, onSelect }: { event: ActivityEvent; onSelect: (id: string) => void }) {
  const kind = EVENT_GLYPH[event.kind];
  return (
    <button
      data-testid={`activity-${event.kind}-${event.entityId}`}
      onClick={() => onSelect(event.entityId)}
      title={`${kind.label} — ${event.at}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(2),
        width: "100%",
        textAlign: "left",
        border: "none",
        borderBottom: `1px solid ${color.border}`,
        background: "transparent",
        padding: `${space(2)}px ${space(1)}px`,
        cursor: "pointer",
      }}
    >
      <span aria-hidden style={{ fontSize: font.sm, color: color.muted, width: 16, flexShrink: 0 }}>
        {kind.glyph}
      </span>
      <Badge type={event.entityType} />
      <span
        style={{
          fontSize: font.sm,
          color: color.text,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {event.title}
      </span>
      <span style={{ fontSize: font.xs, color: color.muted, flexShrink: 0 }}>{timeAgo(event.at)}</span>
    </button>
  );
}

// Project Pulse (Phase 10, BP-10 §3): the whole project's health on one
// scrollable page. Pure render over the sidecar's /pulse rollup — every number
// is derived in core, every row navigates to the entity it describes.
export function PulseView({ onSelect }: { onSelect: (id: string) => void }) {
  const pulse = useQuery({ queryKey: ["pulse"], queryFn: api.pulse });
  const knowledge = useQuery({ queryKey: ["pulse", "knowledge"], queryFn: api.pulseKnowledge });
  const activity = useQuery({ queryKey: ["pulse", "activity"], queryFn: () => api.pulseActivity(30) });

  if (pulse.isPending) {
    return <p style={{ color: color.muted }}>Taking the pulse…</p>;
  }
  if (pulse.isError || !pulse.data) {
    return <p style={{ color: color.danger }}>Could not load the project pulse — is the sidecar running?</p>;
  }
  const p = pulse.data;
  const countable = p.workOrders.total - p.workOrders.byStatus.cancelled;
  const gapTotal = p.features.reduce((n, f) => n + f.gaps, 0);
  const blockedCount = p.blocked.length;

  // Triage before inventory (BP-11 §3): everything actionable, one line each,
  // composed from the queries this view already holds — no extra fetches.
  const attention: { key: string; id: string; label: string }[] = [
    ...p.blocked.map((b) => ({
      key: `blocked-${b.id}`,
      id: b.id,
      label: `⛔ ${b.title} — blocked by ${b.blocking[0]?.title ?? "an unfinished dependency"}`,
    })),
    // Done work that matters but carries no clean verdict (verification &
    // criticality): core sorts critical first and excludes routine; a passing
    // verification receipt clears the row.
    ...p.verificationAttention.map((v) => ({
      key: `verification-${v.id}`,
      id: v.id,
      label: `${v.title} — ${v.criticality}, done but ${
        v.verification === "unverified" ? "unverified" : "verified with failures"
      }`,
    })),
    ...(knowledge.data?.workOrders ?? [])
      .filter((w) => w.errors + w.warns > 0)
      .map((w) => ({
        key: `context-${w.id}`,
        id: w.id,
        label: `${w.title} — ${w.errors + w.warns} context warning${w.errors + w.warns > 1 ? "s" : ""}`,
      })),
    ...p.features
      .filter((f) => f.gaps > 0)
      .map((f) => ({
        key: `gaps-${f.id}`,
        id: f.id,
        label: `${f.title} — ${f.gaps} structural gap${f.gaps > 1 ? "s" : ""}`,
      })),
  ];

  return (
    <div data-testid="pulse-view" style={{ maxWidth: 1120, margin: "0 auto", display: "grid", gap: space(5) }}>
      <section aria-label="Key indicators" style={{ display: "flex", gap: space(3), flexWrap: "wrap" }}>
        <Kpi
          testid="kpi-completion"
          label={p.completion === null ? "no work orders yet" : `complete — ${p.workOrders.byStatus.done} of ${countable} work orders done`}
          value={p.completion === null ? "—" : `${Math.round(p.completion * 100)}%`}
        />
        <Kpi
          testid="kpi-blocked"
          label="ready but blocked"
          value={String(blockedCount)}
          tone={blockedCount > 0 ? color.danger : undefined}
        />
        <Kpi
          testid="kpi-gaps"
          label="structural gaps"
          value={String(gapTotal)}
          tone={gapTotal > 0 ? color.warn : undefined}
        />
        <Kpi
          testid="kpi-now"
          label="in progress / next up"
          value={`${p.now.inProgress.length} / ${p.now.next.length}`}
        />
        <div
          data-testid="kpi-statuses"
          style={{
            flex: "1.4 1 0",
            minWidth: 220,
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.lg,
            padding: `${space(3)}px ${space(4)}px`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            gap: space(2),
          }}
        >
          <div style={{ display: "flex", gap: space(2), flexWrap: "wrap" }}>
            {STATUSES.map((s) => (
              <span
                key={s}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space(1.5),
                  fontSize: font.xs,
                  color: color.text,
                  border: `1px solid ${color.border}`,
                  borderRadius: 999,
                  background: color.chip,
                  padding: `1px ${space(2)}px`,
                }}
              >
                <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[s] }} />
                {STATUS_LABEL[s]} {p.workOrders.byStatus[s]}
              </span>
            ))}
          </div>
          <span style={{ fontSize: font.sm, color: color.muted }}>work orders by status</span>
        </div>
      </section>

      <ProposalsCard onSelect={onSelect} />

      {attention.length > 0 ? (
        <section
          data-testid="needs-attention"
          aria-label="Needs attention"
          style={{
            background: color.chip,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: `${space(2)}px ${space(4)}px`,
          }}
        >
          <p style={{ margin: `${space(1)}px 0`, fontSize: font.xs, fontWeight: 700, color: color.warn }}>
            Needs attention
          </p>
          {attention.map((a) => (
            <button
              key={a.key}
              onClick={() => onSelect(a.id)}
              title={a.label}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                border: "none",
                background: "transparent",
                padding: `${space(1)}px 0`,
                cursor: "pointer",
                fontSize: font.sm,
                color: color.warn,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {a.label}
            </button>
          ))}
        </section>
      ) : (
        <p data-testid="needs-attention" style={{ margin: 0, fontSize: font.sm, color: color.faint }}>
          All clear — nothing needs attention.
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: space(6), alignItems: "flex-start" }}>
        <div style={{ flex: "1.5 1 420px", minWidth: 0 }}>
      <section aria-label="Feature health">
        <SectionHeader>Features</SectionHeader>
        {p.features.length === 0 ? (
          <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>
            No requirements yet — create one in Documents to see its health here.
          </p>
        ) : (
          <div style={{ display: "grid", gap: space(2) }}>
            {p.features.map((f) => (
              <FeatureRow key={f.id} feature={f} onSelect={onSelect} />
            ))}
          </div>
        )}
      </section>
        </div>

        {/* minmax(0, 1fr) clamps the implicit column: children ellipsize
            instead of forcing the rail past the viewport. */}
        <div style={{ flex: "1 1 300px", minWidth: 300, display: "grid", gap: space(5), gridTemplateColumns: "minmax(0, 1fr)" }}>
      <section data-testid="now-next" aria-label="Now and next">
        <SectionHeader>Now / Next</SectionHeader>
        <div
          style={{
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: `${space(2)}px ${space(3)}px`,
          }}
        >
          <p style={{ margin: `${space(1)}px 0`, fontSize: font.xs, color: color.muted }}>In progress</p>
          {p.now.inProgress.length === 0 ? (
            <p style={{ margin: `${space(1)}px 0`, fontSize: font.sm, color: color.faint }}>Nothing in progress.</p>
          ) : (
            p.now.inProgress.map((w) => <WoRow key={w.id} wo={w} onSelect={onSelect} />)
          )}
          <p
            title="ready AND unblocked — exactly what list_ready_work_orders offers agents"
            style={{ margin: `${space(2)}px 0 ${space(1)}px`, fontSize: font.xs, color: color.muted }}
          >
            Next up — what agents may pull over MCP
          </p>
          {p.now.next.length === 0 ? (
            <p style={{ margin: `${space(1)}px 0`, fontSize: font.sm, color: color.faint }}>
              Nothing unblocked and ready.
            </p>
          ) : (
            p.now.next.map((w) => <WoRow key={w.id} wo={w} onSelect={onSelect} />)
          )}
        </div>
      </section>

      <section aria-label="Blockers">
        <SectionHeader>Blockers</SectionHeader>
        {p.blocked.length === 0 ? (
          <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>
            Nothing is blocked — every ready work order can be picked up.
          </p>
        ) : (
          <div style={{ display: "grid", gap: space(2) }}>
            {p.blocked.map((b) => (
              <div
                key={b.id}
                data-testid={`blocked-${b.id}`}
                style={{
                  background: color.surface,
                  border: `1px solid ${color.border}`,
                  borderRadius: radius.md,
                  padding: `${space(2.5)}px ${space(4)}px`,
                  display: "flex",
                  alignItems: "center",
                  gap: space(2),
                  flexWrap: "wrap",
                }}
              >
                <WoLink wo={{ id: b.id, title: b.title, status: "ready" }} onSelect={onSelect} />
                <span style={{ fontSize: font.xs, color: color.danger }}>⛔ blocked by</span>
                {b.blocking.map((dep) => (
                  <WoLink key={dep.id} wo={dep} onSelect={onSelect} />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Critical path">
        <SectionHeader>Critical path</SectionHeader>
        {p.criticalPath.length === 0 ? (
          <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>
            No unfinished work — nothing on the critical path.
          </p>
        ) : (
          <div
            data-testid="critical-path"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space(2),
              flexWrap: "wrap",
              background: color.surface,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              padding: `${space(2.5)}px ${space(4)}px`,
            }}
          >
            {p.criticalPath.map((step, i) => (
              <span key={step.id} style={{ display: "inline-flex", alignItems: "center", gap: space(2) }}>
                {i > 0 && <span style={{ color: color.faint }}>→</span>}
                <WoLink wo={step} onSelect={onSelect} />
              </span>
            ))}
            <span style={{ fontSize: font.xs, color: color.muted, marginLeft: "auto" }}>
              longest chain of unfinished, dependent work
            </span>
          </div>
        )}
      </section>

        <section aria-label="Knowledge health">
          <SectionHeader>Knowledge health</SectionHeader>
          {knowledge.isPending ? (
            <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>Checking contexts…</p>
          ) : knowledge.isError || !knowledge.data ? (
            <p style={{ margin: 0, fontSize: font.sm, color: color.danger }}>Could not load knowledge health.</p>
          ) : knowledge.data.workOrders.length === 0 ? (
            <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>
              No active work orders — nothing waiting on a handoff.
            </p>
          ) : (
            <div
              data-testid="knowledge-panel"
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.md,
                padding: `0 ${space(3)}px ${space(2)}px`,
              }}
            >
              <p style={{ margin: `${space(2)}px 0`, fontSize: font.xs, color: color.muted }}>
                Pre-flight context checks for the {knowledge.data.workOrders.length} active work order
                {knowledge.data.workOrders.length > 1 ? "s" : ""} — {knowledge.data.totals.healthy} healthy,{" "}
                {knowledge.data.totals.warns} warning{knowledge.data.totals.warns === 1 ? "" : "s"}, worst first.
              </p>
              {knowledge.data.workOrders.map((wo) => (
                <KnowledgeRow key={wo.id} wo={wo} onSelect={onSelect} />
              ))}
            </div>
          )}
        </section>

        <section aria-label="Recent activity">
          <SectionHeader>Recent activity</SectionHeader>
          {activity.isPending ? (
            <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>Loading activity…</p>
          ) : activity.isError || !activity.data ? (
            <p style={{ margin: 0, fontSize: font.sm, color: color.danger }}>Could not load recent activity.</p>
          ) : activity.data.length === 0 ? (
            <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>Nothing has happened yet.</p>
          ) : (
            <div
              data-testid="activity-feed"
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.md,
                padding: `${space(1)}px ${space(3)}px ${space(2)}px`,
                maxHeight: 420,
                overflowY: "auto",
              }}
            >
              {activity.data.map((e) => (
                <ActivityRow key={`${e.kind}-${e.entityId}-${e.at}`} event={e} onSelect={onSelect} />
              ))}
            </div>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}
