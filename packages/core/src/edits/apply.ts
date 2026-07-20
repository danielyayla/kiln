import type { EditOp } from "../domain";
import type { Entity, Id, Revision } from "../domain";
import { EditError, NotFoundError } from "../errors";
import type { Store } from "../store";

// Locate an anchor in the body. Anchors must match exactly once: zero matches
// means the document changed under the suggestion, more than one means the op
// is ambiguous — both reject the op rather than guessing.
function findAnchor(body: string, anchor: string, opIndex: number): number {
  if (anchor === "") throw new EditError(`op ${opIndex}: anchor must not be empty`);
  const first = body.indexOf(anchor);
  if (first === -1) throw new EditError(`op ${opIndex}: anchor not found: ${JSON.stringify(anchor)}`);
  if (body.indexOf(anchor, first + 1) !== -1) {
    throw new EditError(`op ${opIndex}: anchor is ambiguous (multiple matches): ${JSON.stringify(anchor)}`);
  }
  return first;
}

// Apply one op to a body, returning the new body. Pure — no store access.
// `insert` places text immediately after its anchor; as a special case an
// empty anchor appends to the end of the document (the only way to draft
// into an empty body).
export function applyOp(body: string, op: EditOp, opIndex: number): string {
  switch (op.kind) {
    case "insert": {
      if (op.anchor === "") return body + op.text;
      const at = findAnchor(body, op.anchor, opIndex);
      const end = at + op.anchor.length;
      return body.slice(0, end) + op.text + body.slice(end);
    }
    case "delete": {
      const at = findAnchor(body, op.anchor, opIndex);
      return body.slice(0, at) + body.slice(at + op.anchor.length);
    }
    case "replace": {
      const at = findAnchor(body, op.anchor, opIndex);
      return body.slice(0, at) + op.text + body.slice(at + op.anchor.length);
    }
  }
}

// Apply the accepted subset of a suggestion's ops to its target entity:
// the ops named by `acceptedOpIndexes` run in suggestion order against the
// current body, the entity is updated, and exactly one revision is appended.
// Atomic on failure — ops apply in memory first, and the store commit is a
// single transaction, so a failing op or write leaves the entity untouched.
export function applySuggestion(
  store: Store,
  suggestionId: Id,
  acceptedOpIndexes: number[],
): { entity: Entity; revision: Revision } {
  const suggestion = store.getSuggestion(suggestionId);
  if (!suggestion) throw new NotFoundError(suggestionId);
  const target = store.getEntity(suggestion.targetId);
  if (!target) throw new NotFoundError(suggestion.targetId);

  if (acceptedOpIndexes.length === 0) {
    throw new EditError("no ops accepted: rejecting every op is not an apply");
  }
  const seen = new Set<number>();
  for (const i of acceptedOpIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= suggestion.ops.length) {
      throw new EditError(`accepted op index out of range: ${i} (suggestion has ${suggestion.ops.length} ops)`);
    }
    if (seen.has(i)) throw new EditError(`accepted op index duplicated: ${i}`);
    seen.add(i);
  }

  // "In order" means suggestion order, regardless of how the caller listed them.
  const ordered = [...acceptedOpIndexes].sort((a, b) => a - b);
  let body = target.body;
  for (const i of ordered) {
    body = applyOp(body, suggestion.ops[i], i);
  }

  const result = store.commitBody(target.id, body);
  // Resolution consumes the suggestion: the accepted subset is applied, the
  // rest is thereby rejected. A failed apply above leaves it pending.
  store.deleteSuggestion(suggestionId);
  return result;
}
