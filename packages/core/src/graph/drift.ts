import type { CompletionReceipt, Entity, WorkOrderStatus } from "../domain";
import type { Store } from "../store";
import { DEFAULT_STATUS } from "../transitions";
import type { HealthCheck } from "./health";

// Drift checks (layer 2, reports-never-blocks): deterministic conditions
// computed from records the store already keeps — revisions, completion
// receipts, links, statuses. Revisions and receipts are the clocks, but drift
// is a content condition proven by them (BP amendment 2026-07-22): a document
// "moved" when a revision landed strictly after the latest relevant completion
// receipt AND its body still differs from what shipped. ISO-8601 strings
// compare lexically (as in pulse), and same-instant timestamps are NOT drift —
// the receipt written atomically with a close must never flag its own work
// order.

const effectiveStatus = (wo: Entity): WorkOrderStatus => wo.status ?? DEFAULT_STATUS;
const isOpen = (s: WorkOrderStatus) => s === "draft" || s === "ready" || s === "in_progress";

const latestReceipt = (store: Store, workOrderId: string): CompletionReceipt | null => {
  // listCompletionReceipts is chronological (oldest first).
  const receipts = store.listCompletionReceipts(workOrderId);
  return receipts.length > 0 ? receipts[receipts.length - 1] : null;
};

const latestReceiptAt = (store: Store, workOrderId: string): string | null =>
  latestReceipt(store, workOrderId)?.createdAt ?? null;

// Revisions are post-image snapshots (commitBody stores the new body), so the
// shipped body is the latest snapshot at or before the ship time. A reverted
// document matches it and is reconciled — the chip's "or revert it" remedy.
// With no snapshot at or before the ship time the baseline is unknown
// (pre-revision-era edits wrote bodies without snapshots) and the clock alone
// decides.
const movedSince = (store: Store, entity: Entity, shippedAt: string): boolean => {
  const revisions = store.listRevisions(entity.id); // chronological (oldest first)
  if (!revisions.some((r) => r.createdAt > shippedAt)) return false;
  let shippedBody: string | null = null;
  for (const r of revisions) {
    if (r.createdAt > shippedAt) break;
    shippedBody = r.body;
  }
  return shippedBody === null || entity.body !== shippedBody;
};

const blueprintIds = (store: Store, workOrderId: string): string[] =>
  store
    .linked(workOrderId, "implements")
    .filter((e) => e.type === "blueprint")
    .map((e) => e.id);

export function driftChecks(store: Store, entity: Entity): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const add = (level: HealthCheck["level"], code: string, message: string) => checks.push({ level, code, message });

  if (entity.type === "work_order" && effectiveStatus(entity) === "done") {
    const receipt = latestReceipt(store, entity.id);
    const receiptAt = receipt?.createdAt ?? null;
    if (receiptAt === null) {
      // Human closes (app/CLI) are legitimately report-free — info, not warn:
      // the chip only marks that no execution record exists to drift against.
      add(
        "info",
        "done-without-receipt",
        "Done with no completion receipt — no execution record exists to drift against.",
      );
    } else if (movedSince(store, entity, receiptAt)) {
      add(
        "warn",
        "revised-after-done",
        "The body was revised after the completion receipt — the shipped work no longer matches this document.",
      );
    }

    // filesTouched is unverified testimony: matched verbatim, cross-blueprint
    // only — sequential work orders on one feature legitimately share files.
    if (receipt && receipt.filesTouched.length > 0) {
      const myBlueprints = blueprintIds(store, entity.id);
      if (myBlueprints.length > 0) {
        for (const other of store.listEntities("work_order")) {
          if (other.id === entity.id || effectiveStatus(other) !== "done") continue;
          const theirBlueprints = blueprintIds(store, other.id);
          if (theirBlueprints.length === 0 || theirBlueprints.some((id) => myBlueprints.includes(id))) continue;
          const theirFiles = new Set(latestReceipt(store, other.id)?.filesTouched ?? []);
          const shared = [...new Set(receipt.filesTouched)].filter((f) => theirFiles.has(f));
          if (shared.length > 0) {
            add(
              "info",
              "shared-files",
              `The completion receipt claims file(s) another blueprint's shipped work also touched — ${shared.join(", ")} — see "${other.title}".`,
            );
          }
        }
      }
    }
  }

  if (entity.type === "blueprint") {
    const implementing = store.linkedFrom(entity.id, "implements").filter((e) => e.type === "work_order");
    // An amended blueprint with an open implementing work order is
    // mid-reconciliation — no chip. No implementing work orders → no clock.
    if (implementing.length > 0 && !implementing.some((wo) => isOpen(effectiveStatus(wo)))) {
      const shippedAt = implementing
        .map((wo) => latestReceiptAt(store, wo.id))
        .filter((at): at is string => at !== null)
        .sort()
        .pop();
      if (shippedAt && movedSince(store, entity, shippedAt)) {
        add(
          "warn",
          "amended-after-ship",
          "Amended after its implementing work orders shipped, with nothing open to reconcile it — cut a work order for the change or revert it.",
        );
      }
    }
  }

  return checks;
}
