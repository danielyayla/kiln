// Pure walk order over the sidecar's /proposals groups (core's
// pendingProposals): flatten requirement-first pairs into one review queue and
// compute where a reviewer is in it. Duplicated small-rule pattern: the
// webview never imports runtime core, so this logic lives (and is tested)
// here.

export interface QueueItem {
  entityId: string;
  entityType: string;
  entityTitle: string;
  suggestionId: string;
  source: string;
  opCount: number;
}

export interface QueueGroup {
  title: string;
  items: QueueItem[];
}

export const flattenQueue = (groups: QueueGroup[]): QueueItem[] => groups.flatMap((g) => g.items);

// 1-based position of the open document in the queue; null when it holds no
// pending proposal (resolved, or never had one).
export function queuePosition(flat: QueueItem[], currentId: string): number | null {
  const index = flat.findIndex((i) => i.entityId === currentId);
  return index === -1 ? null : index + 1;
}

// The next stop in the walk: the item after the current one, or — when the
// current document is no longer in the queue (its proposal was just resolved)
// — the first remaining item, so Apply → Next always moves forward.
export function nextProposal(flat: QueueItem[], currentId: string): QueueItem | null {
  if (flat.length === 0) return null;
  const index = flat.findIndex((i) => i.entityId === currentId);
  if (index === -1) return flat[0];
  return flat[index + 1] ?? null;
}
