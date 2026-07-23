import type { VerdictStatus, VerificationReceipt } from "@kiln/core";

// Pure display rules for verification receipts (verification & criticality
// feature). Local to the webview, type-checked against core — the same
// no-runtime-core convention as work-type.ts and criticality.ts. The
// classification mirrors core's verificationStatus: the LATEST receipt speaks
// for display; the full history stays readable underneath.

// Receipts arrive oldest-first (insertion order); the latest verdict is last.
export const latestReceipt = (receipts: VerificationReceipt[]): VerificationReceipt | null =>
  receipts.length === 0 ? null : receipts[receipts.length - 1];

// A clean pass needs overall met AND every criterion met — anything short of
// that is a verdict worth reading, not a green light.
export const isCleanPass = (receipt: VerificationReceipt): boolean =>
  receipt.overall === "met" && receipt.criteria.every((c) => c.status === "met");

// Per-status counts for a receipt's summary line ("3 met · 1 undecidable").
export function verdictCounts(receipt: VerificationReceipt): Record<VerdictStatus, number> {
  const counts: Record<VerdictStatus, number> = { met: 0, unmet: 0, undecidable: 0 };
  for (const c of receipt.criteria) counts[c.status] += 1;
  return counts;
}

export const summarizeVerdict = (receipt: VerificationReceipt): string => {
  const counts = verdictCounts(receipt);
  const parts = (["met", "unmet", "undecidable"] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);
  return parts.length === 0 ? `no criteria — overall ${receipt.overall}` : parts.join(" · ");
}
