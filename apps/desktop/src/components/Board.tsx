import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Entity, WorkOrderStatus } from "@kiln/core";
import { api, type WorkOrderReadiness } from "../lib/client";
import { effectiveWorkType, filterByWorkType, WORK_TYPES, type WorkTypeFilter } from "../lib/work-type";
import { BlockedBadge, Button, Input, RowMenu, SectionHeader, Select, STATUS_COLOR, STATUS_LABEL } from "./ui";
import { color, font, radius, space } from "../theme";

// Local literal (type-checked against core) — value imports from @kiln/core
// would drag node:sqlite into the webview bundle. Status colors/labels live
// in ui/StatusDot (BP-15) so the board's pills and the navigator's dots
// cannot drift.
const STATUSES: WorkOrderStatus[] = ["draft", "ready", "in_progress", "done", "cancelled"];

const EMPTY_HINT: Record<WorkOrderStatus, string> = {
  draft: "Extract work orders from a blueprint to see them here.",
  ready: "Set a work order ready and agents can pick it up over MCP.",
  in_progress: "Nothing in progress.",
  done: "Nothing done yet.",
  cancelled: "Nothing cancelled.",
};

function StatusPill({ status, withCaret }: { status: WorkOrderStatus; withCaret: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space(1),
        padding: `1px ${space(2)}px`,
        borderRadius: 999,
        background: color.chip,
        border: `1px solid ${color.border}`,
        fontSize: font.xs,
        color: color.text,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[status], flexShrink: 0 }}
      />
      {STATUS_LABEL[status]}
      {withCaret ? " ▾" : ""}
    </span>
  );
}

// The card's work-type badge (BP-18). `feature` is the default and renders
// unbadged — the badge marks the exceptions, same chip tokens as StatusPill.
function WorkTypeBadge({ workOrder }: { workOrder: Entity }) {
  const workType = effectiveWorkType(workOrder);
  if (workType === "feature") return null;
  return (
    <span
      data-testid={`work-type-${workOrder.id}`}
      style={{
        padding: `1px ${space(2)}px`,
        borderRadius: 999,
        background: color.chip,
        border: `1px solid ${color.border}`,
        fontSize: font.xs,
        color: color.muted,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {workType}
    </span>
  );
}

// Ready-but-blocked tooltip (WO-B2): this card's status is ready, but an
// unfinished depends_on target keeps it out of list_ready_work_orders. The
// badge itself lives in ui/BlockedBadge (shared with the Context Inspector).
const blockedTitle = (blocking: WorkOrderReadiness["blocking"]): string =>
  `Blocked by: ${blocking.map((b) => `${b.title} (${b.status ?? "draft"})`).join(", ")}`;

// A context line ("blueprint: …") that navigates to the linked entity.
function ContextLink({
  prefix,
  entity,
  onSelect,
}: {
  prefix: string;
  entity: Entity | null | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <span style={{ display: "flex", gap: space(1), minWidth: 0, fontSize: font.xs, color: color.muted }}>
      <span style={{ flexShrink: 0 }}>{prefix}:</span>
      {entity ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect(entity.id);
          }}
          title={entity.title}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            fontSize: font.xs,
            color: color.muted,
            textDecoration: "underline",
            textDecorationColor: color.border,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entity.title}
        </button>
      ) : (
        <span>—</span>
      )}
    </span>
  );
}

function Card({
  workOrder,
  readiness,
  onSelect,
}: {
  workOrder: Entity;
  readiness: WorkOrderReadiness | undefined;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [assignee, setAssignee] = useState("");
  const status = workOrder.status ?? "draft";
  // The badge marks ready-but-blocked cards: exactly the ones an agent would
  // expect to pull but won't be offered (WO-B1's readiness rule).
  const showBlocked = status === "ready" && (readiness?.blocked ?? false);

  // Every card shows its linked blueprint + requirement (BP-5) via core's
  // assembleWorkOrderContext through the sidecar.
  const context = useQuery({
    queryKey: ["context", workOrder.id],
    queryFn: () => api.context(workOrder.id),
  });

  // The legal next statuses come from the sidecar (BP-3 lifecycle in core) —
  // the board never encodes the policy itself.
  const transitions = useQuery({
    queryKey: ["transitions", workOrder.id, workOrder.status],
    queryFn: () => api.transitions(workOrder.id),
  });

  const patch = useMutation({
    mutationFn: (p: { status?: WorkOrderStatus; assignee?: string; overrideGate?: boolean }) =>
      api.patchEntity(workOrder.id, p, p.overrideGate ? { overrideGate: true } : undefined),
    onSuccess: () => {
      setAssignee("");
      void queryClient.invalidateQueries({ queryKey: ["entities", "work_order"] });
      // The navigator tree shows work-order status chips (BP-6).
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      // A status change can unblock OTHER cards (their dep just went done).
      void queryClient.invalidateQueries({ queryKey: ["readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
    onError: (e, vars) => {
      const msg = e instanceof Error ? e.message : String(e);
      // The draft→ready completeness gate: show the blockers, offer the
      // explicit override. Everything else surfaces as a plain alert.
      if (msg.includes("completeness gate") && vars.status === "ready") {
        if (window.confirm(`${msg}\n\nSet ready anyway?`)) {
          patch.mutate({ status: "ready", overrideGate: true });
        }
      } else {
        window.alert(msg);
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteEntity(workOrder.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["entities", "work_order"] });
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      // Deleting a work order cascades its depends_on edges — dependents unblock.
      void queryClient.invalidateQueries({ queryKey: ["readiness"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
  });

  const allowed = transitions.data?.allowed ?? [];

  return (
    <div
      data-testid={`card-${workOrder.id}`}
      onClick={() => onSelect(workOrder.id)}
      style={{
        background: color.bg,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: space(2),
        marginBottom: space(2),
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: space(1) }}>
        <strong
          style={{
            fontSize: font.sm,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={workOrder.title}
        >
          {workOrder.title}
        </strong>
        <WorkTypeBadge workOrder={workOrder} />
        {showBlocked && <BlockedBadge title={blockedTitle(readiness!.blocking)} />}
        <Button
          variant="ghost"
          aria-label={`delete ${workOrder.title}`}
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Delete work order "${workOrder.title}"?`)) remove.mutate();
          }}
          disabled={remove.isPending}
          style={{ color: color.danger, fontSize: font.xs, flexShrink: 0, padding: `0 ${space(1)}px` }}
        >
          ✕
        </Button>
      </div>
      <div style={{ display: "grid", gap: 2, margin: `${space(1)}px 0` }}>
        <ContextLink prefix="blueprint" entity={context.data?.blueprint} onSelect={onSelect} />
        <ContextLink prefix="requirement" entity={context.data?.requirement} onSelect={onSelect} />
        <span style={{ fontSize: font.xs, color: color.muted }}>
          assignee: <span data-testid="assignee">{workOrder.assignee ?? "unassigned"}</span>
        </span>
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ display: "flex", gap: space(1), flexWrap: "wrap", alignItems: "center" }}
      >
        {allowed.length > 0 ? (
          <RowMenu
            label={`status of ${workOrder.title}`}
            trigger={<StatusPill status={status} withCaret />}
            triggerStyle={{ padding: 0 }}
            items={[
              ...allowed.map((s) => ({
                label: `→ ${STATUS_LABEL[s]}`,
                onSelect: () => patch.mutate({ status: s }),
              })),
              // Blocked cards list their blockers here too — click to open one.
              ...(showBlocked
                ? readiness!.blocking.map((b) => ({
                    label: `⛔ blocked by: ${b.title}`,
                    onSelect: () => onSelect(b.id),
                  }))
                : []),
            ]}
          />
        ) : (
          <span title="terminal status — no further transitions">
            <StatusPill status={status} withCaret={false} />
          </span>
        )}
        <form
          style={{ display: "flex", gap: space(1), flex: "1 1 auto", minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (assignee.trim()) patch.mutate({ assignee: assignee.trim() });
          }}
        >
          <Input
            aria-label={`assign ${workOrder.title}`}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="assign to…"
            style={{ padding: `1px ${space(1.5)}px`, fontSize: font.xs, flex: 1, minWidth: 0, width: "100%" }}
          />
          <Button
            type="submit"
            disabled={!assignee.trim() || patch.isPending}
            style={{ fontSize: font.xs, padding: `1px ${space(1.5)}px`, flexShrink: 0 }}
          >
            Assign
          </Button>
        </form>
      </div>
    </div>
  );
}

// The work-order board (BP-5): columns by status. Data and transitions all
// live behind the sidecar; this component only groups and renders. Columns
// shrink to fit the default window — no horizontal cutoff (BP-6).
export function Board({ onSelect }: { onSelect: (id: string) => void }) {
  const workOrders = useQuery({
    queryKey: ["entities", "work_order"],
    queryFn: () => api.listEntities("work_order"),
  });

  // One bulk readiness fetch for the whole board; cards join by id (WO-B2).
  const readiness = useQuery({ queryKey: ["readiness"], queryFn: () => api.readiness() });
  const readinessById = new Map((readiness.data ?? []).map((r) => [r.id, r]));

  // Type filter (BP-18): one filter over every column, by EFFECTIVE type —
  // `feature` therefore includes unset cards. Session-local, never persisted.
  const [typeFilter, setTypeFilter] = useState<WorkTypeFilter>("all");
  const visible = filterByWorkType(workOrders.data ?? [], typeFilter);

  return (
    <div style={{ display: "grid", gap: space(2) }}>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: space(1) }}>
        <label htmlFor="board-type-filter" style={{ fontSize: font.xs, color: color.muted }}>
          type
        </label>
        <Select
          id="board-type-filter"
          aria-label="filter by work type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as WorkTypeFilter)}
          style={{ fontSize: font.xs, padding: `1px ${space(1.5)}px` }}
        >
          <option value="all">all types</option>
          {WORK_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      {/* minWidth 0: as a grid item the row would otherwise size to its
          min-content and defeat the columns' shrink-to-fit (BP-6). */}
      <div data-testid="board" style={{ display: "flex", gap: space(2), alignItems: "flex-start", minWidth: 0 }}>
        {STATUSES.map((status) => {
          const items = visible.filter((w) => (w.status ?? "draft") === status);
          return (
            <section
              key={status}
              aria-label={`${STATUS_LABEL[status]} column`}
              style={{
                flex: "1 1 0",
                minWidth: 0,
                background: color.inset,
                borderRadius: radius.lg,
                padding: space(2),
                minHeight: 120,
              }}
            >
              <SectionHeader size="sm">
                {STATUS_LABEL[status]} ({items.length})
              </SectionHeader>
              {items.length === 0 && (
                <p style={{ margin: 0, fontSize: font.xs, color: color.faint }}>
                  {typeFilter === "all" ? EMPTY_HINT[status] : `No ${typeFilter} work orders.`}
                </p>
              )}
              {items.map((w) => (
                <Card key={w.id} workOrder={w} readiness={readinessById.get(w.id)} onSelect={onSelect} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
