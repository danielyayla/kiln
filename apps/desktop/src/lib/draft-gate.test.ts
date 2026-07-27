import { describe, expect, it } from "vitest";
import { draftDisabledReason } from "./draft-gate";

// Regression for "Draft button is silently disabled with pending suggestions":
// every disabled state carries a reason, and the two causes read differently.
describe("draftDisabledReason", () => {
  it("allows drafting when idle with no pending suggestions", () => {
    expect(draftDisabledReason({ drafting: false, pendingSuggestions: 0 })).toBeNull();
  });

  it("explains an in-flight draft", () => {
    expect(draftDisabledReason({ drafting: true, pendingSuggestions: 0 })).toBe(
      "Drafting is already in progress.",
    );
  });

  it("explains the pending-suggestions gate", () => {
    expect(draftDisabledReason({ drafting: false, pendingSuggestions: 2 })).toBe(
      "Resolve pending suggestions before drafting.",
    );
  });

  it("prefers the in-flight message when both apply", () => {
    expect(draftDisabledReason({ drafting: true, pendingSuggestions: 2 })).toBe(
      "Drafting is already in progress.",
    );
  });
});
