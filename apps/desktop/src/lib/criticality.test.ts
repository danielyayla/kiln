import { describe, expect, it } from "vitest";
import { effectiveCriticality, filterByCriticality } from "./criticality";

const wo = (criticality: "routine" | "important" | "critical" | null) => ({ criticality });

describe("effectiveCriticality", () => {
  it("reads unset as routine, set values as themselves", () => {
    expect(effectiveCriticality(wo(null))).toBe("routine");
    expect(effectiveCriticality(wo("routine"))).toBe("routine");
    expect(effectiveCriticality(wo("critical"))).toBe("critical");
  });
});

describe("filterByCriticality", () => {
  const items = [wo(null), wo("routine"), wo("important"), wo("critical")];

  it("passes everything through on all", () => {
    expect(filterByCriticality(items, "all")).toEqual(items);
  });

  it("matches by effective criticality — routine includes unset", () => {
    expect(filterByCriticality(items, "routine")).toEqual([wo(null), wo("routine")]);
    expect(filterByCriticality(items, "critical")).toEqual([wo("critical")]);
  });
});
