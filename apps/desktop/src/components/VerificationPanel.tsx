import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Entity, VerdictStatus, VerificationReceipt } from "@kiln/core";
import { api } from "../lib/client";
import { friendlyError } from "../lib/errors";
import { isCleanPass, latestReceipt, summarizeVerdict } from "../lib/verification";
import { timeAgo } from "../lib/time";
import { Button, useToast } from "./ui";
import { color, font, radius, space } from "../theme";

// The verdict panel (verification & criticality): the judgment half of the
// receipt loop, rendered beside the completion receipts in the inspector's
// Receipts tab. A completion receipt is the agent's testimony; this panel
// holds the independent per-criterion judgment of that testimony — the LATEST
// verdict in full, earlier ones readable underneath (append-only, like the
// receipts themselves). Verify is human-triggered and done-only; the sidecar
// enforces both, this panel just mirrors the rule.

const VERDICT_COLOR: Record<VerdictStatus, string> = {
  met: color.ok,
  unmet: color.danger,
  undecidable: color.warn,
};

function VerdictRows({ receipt }: { receipt: VerificationReceipt }) {
  if (receipt.criteria.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: font.sm, color: color.faint }}>
        No acceptance criteria to judge — overall {receipt.overall}.
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(1.5) }}>
      {receipt.criteria.map((c, i) => (
        <li key={i} style={{ display: "flex", gap: space(1.5), alignItems: "baseline", fontSize: font.sm }}>
          <span
            style={{
              fontSize: font.xs,
              fontWeight: 700,
              color: VERDICT_COLOR[c.status],
              whiteSpace: "nowrap",
              flexShrink: 0,
              width: 86,
            }}
          >
            {c.status.toUpperCase()}
          </span>
          <span style={{ minWidth: 0 }}>
            {c.criterion}
            <span style={{ display: "block", fontSize: font.xs, color: color.muted, marginTop: 2 }}>{c.reason}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function VerificationPanel({ workOrder }: { workOrder: Entity }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const done = workOrder.status === "done";

  const receipts = useQuery({
    queryKey: ["verification-receipts", workOrder.id],
    queryFn: () => api.verificationReceipts(workOrder.id),
  });

  const verify = useMutation({
    mutationFn: () => api.verify(workOrder.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["verification-receipts", workOrder.id] });
      // A fresh verdict can clear (or raise) the Pulse attention row.
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  const all = receipts.data ?? [];
  const latest = latestReceipt(all);
  // Earlier verdicts, newest first — history stays readable, never replaced.
  const earlier = all.slice(0, -1).reverse();

  // The panel only exists where verification applies: a done order, or one
  // that already carries verdicts.
  if (!done && all.length === 0) return null;

  return (
    <section
      data-testid="verification-panel"
      aria-label="Verification"
      style={{
        padding: `${space(2)}px ${space(2.5)}px`,
        marginBottom: space(3),
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderLeft: `3px solid ${latest ? (isCleanPass(latest) ? color.ok : color.warn) : color.borderStrong}`,
        borderRadius: radius.md,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: space(2) }}>
        <span style={{ fontSize: font.sm, fontWeight: 700, color: color.text }}>Verification</span>
        {latest ? (
          <span
            data-testid="verification-status"
            style={{
              fontSize: font.xs,
              fontWeight: 700,
              color: isCleanPass(latest) ? color.ok : color.warn,
              whiteSpace: "nowrap",
            }}
          >
            {isCleanPass(latest) ? "✓ verified" : "verified with failures"}
          </span>
        ) : (
          <span data-testid="verification-status" style={{ fontSize: font.xs, color: color.muted }}>
            unverified
          </span>
        )}
        {latest && (
          <span style={{ fontSize: font.xs, color: color.muted, whiteSpace: "nowrap" }}>
            {summarizeVerdict(latest)} · {timeAgo(latest.createdAt)}
          </span>
        )}
        {done && (
          <Button
            data-testid="run-verify"
            onClick={() => verify.mutate()}
            disabled={verify.isPending}
            style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
          >
            {verify.isPending ? "verifying…" : latest ? "Re-run verification" : "Verify"}
          </Button>
        )}
      </div>

      {latest ? (
        <div style={{ marginTop: space(2) }}>
          <VerdictRows receipt={latest} />
        </div>
      ) : (
        <p style={{ margin: `${space(1.5)}px 0 0`, fontSize: font.sm, color: color.faint }}>
          No verdict yet — Verify judges the completion receipts against this order's acceptance criteria.
        </p>
      )}

      {earlier.length > 0 && (
        <details style={{ marginTop: space(2) }}>
          <summary
            data-testid="verification-history"
            style={{ cursor: "pointer", fontSize: font.xs, color: color.muted }}
          >
            {earlier.length} earlier verdict{earlier.length === 1 ? "" : "s"}
          </summary>
          <ol style={{ listStyle: "none", margin: `${space(1.5)}px 0 0`, padding: 0, display: "grid", gap: space(2) }}>
            {earlier.map((r) => (
              <li
                key={r.id}
                style={{
                  padding: `${space(1.5)}px ${space(2)}px`,
                  background: color.inset,
                  border: `1px solid ${color.border}`,
                  borderRadius: radius.sm,
                }}
              >
                <p style={{ margin: `0 0 ${space(1)}px`, fontSize: font.xs, color: color.muted }}>
                  {timeAgo(r.createdAt)} · {summarizeVerdict(r)}
                </p>
                <VerdictRows receipt={r} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
