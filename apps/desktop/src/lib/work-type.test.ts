import { describe, expect, it } from "vitest";
import { effectiveWorkType, filterByWorkType, WORK_TYPES } from "./work-type";

describe("effectiveWorkType (webview duplicate of the core rule)", () => {
  it("defaults an unset field to feature and passes a set one through", () => {
    expect(effectiveWorkType({ workType: null })).toBe("feature");
    expect(effectiveWorkType({ workType: "bug" })).toBe("bug");
  });

  it("covers the closed set", () => {
    expect(WORK_TYPES).toEqual(["feature", "bug", "refactor", "perf", "chore"]);
  });
});

describe("filterByWorkType", () => {
  const items = [
    { id: "a", workType: null },
    { id: "b", workType: "bug" as const },
    { id: "c", workType: "feature" as const },
    { id: "d", workType: "chore" as const },
  ];

  it("passes everything through on `all`", () => {
    expect(filterByWorkType(items, "all")).toEqual(items);
  });

  it("filters to a single type by effective value — `feature` includes unset", () => {
    expect(filterByWorkType(items, "bug").map((i) => i.id)).toEqual(["b"]);
    expect(filterByWorkType(items, "feature").map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterByWorkType(items, "perf")).toEqual([]);
  });
});
