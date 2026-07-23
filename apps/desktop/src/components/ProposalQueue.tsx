import { useQuery } from "@tanstack/react-query";
import type { EntityType } from "@kiln/core";
import { api } from "../lib/client";
import { flattenQueue, nextProposal, queuePosition } from "../lib/proposal-queue";
import { Badge, Button, SectionHeader } from "./ui";
import { color, font, radius, space } from "../theme";

// The bulk-review surface (dogfood finding: 13 blueprints accepted, all 14
// requirements missed). One query feeds two placements: a Pulse card listing
// every pending proposal grouped requirement-first, and a walk banner in the
// Documents view that steps through the queue. Ordering comes from core's
// pendingProposals — the webview only renders it.

const useProposals = () =>
  useQuery({ queryKey: ["proposals"], queryFn: api.proposals, refetchOnWindowFocus: true });

const SOURCE_LABEL: Record<string, string> = {
  draft_agent: "draft agent",
  extract_agent: "survey/extract agent",
  refine_agent: "refine agent",
  review_agent: "review agent",
  human: "human",
};

// Pulse card: every pending proposal in the project, one place, each row a
// jump straight to the document. Renders nothing when the queue is empty —
// Pulse stays quiet unless there is something to review.
export function ProposalsCard({ onSelect }: { onSelect: (id: string) => void }) {
  const proposals = useProposals();
  const groups = proposals.data?.groups ?? [];
  if (groups.length === 0) return null;
  const flat = flattenQueue(groups);

  return (
    <section
      data-testid="pending-proposals"
      aria-label="Pending proposals"
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: `${space(2)}px ${space(4)}px ${space(3)}px`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionHeader>
          Pending proposals ({flat.length})
        </SectionHeader>
        <Button onClick={() => onSelect(flat[0].entityId)}>Start review</Button>
      </div>
      <p style={{ margin: `0 0 ${space(2)}px`, fontSize: font.xs, color: color.muted }}>
        Agent-proposed documents awaiting your decision. Pairs review together — requirement first,
        then its blueprint. Nothing is committed until you accept it.
      </p>
      {groups.map((group) => (
        <div key={group.items[0].suggestionId} style={{ padding: `${space(1)}px 0` }}>
          <p
            style={{
              margin: 0,
              fontSize: font.xs,
              fontWeight: 700,
              color: color.muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {group.title}
          </p>
          {group.items.map((item) => (
            <button
              key={item.suggestionId}
              onClick={() => onSelect(item.entityId)}
              title={item.entityTitle}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space(2),
                width: "100%",
                textAlign: "left",
                border: "none",
                background: "transparent",
                padding: `${space(1)}px 0 ${space(1)}px ${space(2)}px`,
                cursor: "pointer",
                fontSize: font.sm,
                color: color.text,
              }}
            >
              <Badge type={item.entityType as EntityType} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.entityTitle}
              </span>
              <span style={{ marginLeft: "auto", fontSize: font.xs, color: color.faint, flexShrink: 0 }}>
                {item.opCount} op{item.opCount === 1 ? "" : "s"} · {SOURCE_LABEL[item.source] ?? item.source}
              </span>
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}

// Documents-view banner: shown while the project holds pending proposals, it
// keeps the reviewer oriented (k of N) and moves them forward — after Apply
// or Reject the current document leaves the queue and Next continues from the
// first remaining stop. Navigation only; resolution stays in the editor.
export function ProposalWalkBanner({
  entityId,
  onSelect,
}: {
  entityId: string;
  onSelect: (id: string) => void;
}) {
  const proposals = useProposals();
  const groups = proposals.data?.groups ?? [];
  if (groups.length === 0) return null;
  const flat = flattenQueue(groups);
  const position = queuePosition(flat, entityId);
  const next = nextProposal(flat, entityId);

  return (
    <div
      data-testid="proposal-walk"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(3),
        background: color.chip,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: `${space(1.5)}px ${space(3)}px`,
        marginBottom: space(3),
      }}
    >
      <span style={{ fontSize: font.sm, color: color.text, fontWeight: 600, flexShrink: 0 }}>
        Proposal review
      </span>
      <span style={{ fontSize: font.xs, color: color.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {position !== null
          ? `${position} of ${flat.length} pending — decide below, then continue`
          : `${flat.length} still pending`}
      </span>
      {next && (
        <Button
          style={{ marginLeft: "auto", flexShrink: 0 }}
          onClick={() => onSelect(next.entityId)}
        >
          Next: {next.entityType === "requirement" ? "REQ" : next.entityType === "blueprint" ? "BP" : ""}{" "}
          {next.entityTitle.length > 40 ? `${next.entityTitle.slice(0, 40)}…` : next.entityTitle} →
        </Button>
      )}
    </div>
  );
}
