import { describe, expect, it } from "vitest";
import {
  contextRoute,
  linkForRoute,
  mergeRoute,
  parseHash,
  routeAfterProjectSwitch,
  serializeRoute,
  type Route,
} from "./route";

const base: Route = { view: "pulse", selectedId: null, panelTab: null, params: {} };

describe("parseHash", () => {
  it("defaults an empty hash to the home view", () => {
    expect(parseHash("")).toEqual(base);
    expect(parseHash("#")).toEqual(base);
    expect(parseHash("#/")).toEqual(base);
  });

  it("reads the view from the path", () => {
    expect(parseHash("#/board").view).toBe("board");
    expect(parseHash("#/xray").view).toBe("xray");
    expect(parseHash("#/settings").view).toBe("settings");
  });

  it("falls back to home on an unknown view rather than a blank app", () => {
    expect(parseHash("#/nonsense").view).toBe("pulse");
  });

  it("reads the opened document and panel tab from the query", () => {
    const r = parseHash("#/documents?doc=abc123&panel=context");
    expect(r).toMatchObject({ view: "documents", selectedId: "abc123", panelTab: "context" });
  });

  it("treats a missing or empty doc as no selection", () => {
    expect(parseHash("#/documents").selectedId).toBeNull();
    expect(parseHash("#/documents?doc=").selectedId).toBeNull();
  });

  it("ignores an unknown panel tab", () => {
    expect(parseHash("#/documents?panel=bogus").panelTab).toBeNull();
  });

  it("collects other query params into params", () => {
    expect(parseHash("#/xray?feature=f1&doc=d1").params).toEqual({ feature: "f1" });
  });
});

describe("serializeRoute", () => {
  it("emits a bare view path when there is nothing else", () => {
    expect(serializeRoute(base)).toBe("#/pulse");
  });

  it("omits the default graph panel to keep the hash clean", () => {
    expect(serializeRoute({ ...base, view: "documents", selectedId: "d1", panelTab: "graph" })).toBe(
      "#/documents?doc=d1",
    );
  });

  it("includes a non-default panel", () => {
    expect(serializeRoute({ ...base, view: "documents", selectedId: "d1", panelTab: "context" })).toBe(
      "#/documents?doc=d1&panel=context",
    );
  });

  it("round-trips through parseHash", () => {
    const routes: Route[] = [
      base,
      { view: "documents", selectedId: "d1", panelTab: "chat", params: {} },
      { view: "board", selectedId: "d9", panelTab: null, params: {} },
      { view: "xray", selectedId: null, panelTab: null, params: { feature: "f2" } },
    ];
    for (const r of routes) expect(parseHash(serializeRoute(r))).toEqual(r);
  });
});

describe("mergeRoute", () => {
  const current: Route = { view: "documents", selectedId: "d1", panelTab: "context", params: {} };

  it("keeps unspecified fields (undefined = keep)", () => {
    // Switching view preserves the opened document — the pre-router behavior.
    expect(mergeRoute(current, { view: "board" })).toMatchObject({
      view: "board",
      selectedId: "d1",
      panelTab: "context",
    });
  });

  it("clears a field explicitly with null", () => {
    // Project switch drops the selection and panel, lands on Pulse.
    expect(mergeRoute(current, { view: "pulse", selectedId: null, panelTab: null })).toEqual(base);
  });

  it("opening a document keeps the current panel tab", () => {
    expect(mergeRoute(current, { view: "documents", selectedId: "d2" }).panelTab).toBe("context");
  });
});

describe("linkForRoute", () => {
  const base = "http://127.0.0.1:1420/";

  it("appends the route's hash to the app base so it restores on load", () => {
    expect(linkForRoute({ view: "documents", selectedId: "d1", panelTab: "context", params: {} }, base)).toBe(
      "http://127.0.0.1:1420/#/documents?doc=d1&panel=context",
    );
  });

  it("round-trips: the copied link's hash parses back to the same route", () => {
    const route: Route = { view: "board", selectedId: "d9", panelTab: null, params: {} };
    const link = linkForRoute(route, base);
    expect(parseHash(link.slice(base.length))).toEqual(route);
  });
});

describe("contextRoute", () => {
  it("targets the entity's Documents Context tab in one hop", () => {
    expect(contextRoute("d1")).toEqual({ view: "documents", selectedId: "d1", panelTab: "context" });
  });

  it("merges over any current location to land on the Context tab", () => {
    // From the X-ray canvas, one hop lands on Documents with panel=context —
    // no open-then-switch-tab two-step.
    const fromXray: Route = { view: "xray", selectedId: null, panelTab: null, params: { feature: "f1" } };
    expect(mergeRoute(fromXray, contextRoute("d1"))).toMatchObject({
      view: "documents",
      selectedId: "d1",
      panelTab: "context",
    });
  });

  it("serializes to a deep link that carries the panel", () => {
    expect(serializeRoute(mergeRoute(base, contextRoute("d1")))).toBe("#/documents?doc=d1&panel=context");
  });
});

describe("routeAfterProjectSwitch", () => {
  it("stays put when the opened entity still exists in the new project", () => {
    expect(routeAfterProjectSwitch("d1", true)).toBeNull();
  });

  it("falls back to Pulse when the entity is gone", () => {
    expect(routeAfterProjectSwitch("d1", false)).toEqual({ view: "pulse", selectedId: null, panelTab: null });
  });

  it("falls back to Pulse when there was no selection to preserve", () => {
    expect(routeAfterProjectSwitch(null, false)).toEqual({ view: "pulse", selectedId: null, panelTab: null });
  });
});
