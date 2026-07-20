import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

// Reconstruct base/target from the diff — the round-trip property every
// correct diff must satisfy.
function reconstruct(diff: ReturnType<typeof diffLines>) {
  return {
    base: diff.filter((d) => d.kind !== "added").map((d) => d.text).join("\n"),
    target: diff.filter((d) => d.kind !== "removed").map((d) => d.text).join("\n"),
  };
}

describe("diffLines", () => {
  it("marks identical documents as all-same", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.kind === "same")).toBe(true);
  });

  it("detects added, removed, and changed lines", () => {
    const d = diffLines("keep\nold line\nend", "keep\nnew line\nend");
    expect(d).toEqual([
      { kind: "same", text: "keep" },
      { kind: "removed", text: "old line" },
      { kind: "added", text: "new line" },
      { kind: "same", text: "end" },
    ]);
  });

  it("round-trips arbitrary edits", () => {
    const base = "# Title\nline one\nline two\nline three";
    const target = "# Title\nline two\ninserted\nline three\ntail";
    const { base: b, target: t } = reconstruct(diffLines(base, target));
    expect(b).toBe(base);
    expect(t).toBe(target);
  });

  it("handles empty documents", () => {
    expect(diffLines("", "a")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "a" },
    ]);
  });
});
