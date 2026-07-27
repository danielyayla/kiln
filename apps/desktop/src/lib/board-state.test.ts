import { describe, expect, it } from "vitest";
import { boardViewState } from "./board-state";

// Regression for "a dead sidecar looks like an empty board": the columns and
// their empty hints may only render once the work-orders query has succeeded.
describe("boardViewState", () => {
  it("shows loading while the query is pending", () => {
    expect(boardViewState({ isPending: true, isError: false })).toBe("loading");
  });

  it("shows the sidecar error instead of empty columns on failure", () => {
    expect(boardViewState({ isPending: false, isError: true })).toBe("error");
  });

  it("renders the board (with its empty hints) only after success", () => {
    expect(boardViewState({ isPending: false, isError: false })).toBe("board");
  });
});
