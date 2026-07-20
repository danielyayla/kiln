import { describe, expect, it } from "vitest";
import { timeAgo } from "./time";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");

describe("timeAgo", () => {
  it("scales from seconds to days and falls back to the date", () => {
    expect(timeAgo("2026-07-11T11:59:30.000Z", NOW)).toBe("just now");
    expect(timeAgo("2026-07-11T11:53:00.000Z", NOW)).toBe("7m ago");
    expect(timeAgo("2026-07-11T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(timeAgo("2026-07-09T12:00:00.000Z", NOW)).toBe("2d ago");
    expect(timeAgo("2026-06-01T00:00:00.000Z", NOW)).toBe("2026-06-01");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(timeAgo("2026-07-11T12:05:00.000Z", NOW)).toBe("just now");
  });
});
