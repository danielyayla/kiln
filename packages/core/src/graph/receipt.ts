import { createHash, randomUUID } from "node:crypto";
import type { ContextReceipt, Id } from "../domain";
import type { Store } from "../store";
import { assembleWorkOrderContext } from "./context";

// Deterministic JSON: object keys sorted recursively, so two equivalent
// contexts serialize identically regardless of key insertion order — the hash
// depends only on content.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// A stable content hash of an assembled context (Phase 8). Any change to any
// entity in the bundle — including an edited body or a bumped updatedAt —
// changes the hash; an unchanged bundle hashes identically.
export function hashContext(context: unknown): string {
  return createHash("sha256").update(stableStringify(context)).digest("hex");
}

// Record the context handed to an agent for a work order (Phase 8 provenance).
// Deduped by content hash: a new receipt is written only when the assembled
// context differs from the latest for this work order; otherwise the existing
// latest receipt is returned unchanged. This is the one write that turns the
// receipts table into a real handoff log.
export function recordContextReceipt(store: Store, workOrderId: Id): ContextReceipt {
  const context = assembleWorkOrderContext(store, workOrderId);
  const hash = hashContext(context);

  const latest = store.latestContextReceipt(workOrderId);
  if (latest && latest.hash === hash) return latest;

  const receipt: ContextReceipt = {
    id: randomUUID(),
    workOrderId,
    context,
    hash,
    createdAt: new Date().toISOString(),
  };
  store.saveContextReceipt(receipt);
  return receipt;
}
