import { describe, expect, it } from "vitest";
import {
  createAndSwitch,
  swapProjectStorage,
  switchToProject,
  type StorageLike,
} from "./project-switch";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

describe("swapProjectStorage", () => {
  it("stashes the outgoing project's state and loads the incoming project's", () => {
    const storage = fakeStorage({
      "kiln.nav.collapsed": '["x"]',
      "kiln.b.nav.collapsed": '["y"]',
    });
    swapProjectStorage(storage, "a", "b");
    expect(storage.dump()).toEqual({
      "kiln.a.nav.collapsed": '["x"]',
      "kiln.b.nav.collapsed": '["y"]',
      "kiln.nav.collapsed": '["y"]',
    });
  });

  it("clears base keys when the incoming project has no stash", () => {
    const storage = fakeStorage({
      "kiln.nav.collapsed": '["x"]',
      "kiln.nav.artifactsOpen": "false",
    });
    swapProjectStorage(storage, "a", "b");
    expect(storage.getItem("kiln.nav.collapsed")).toBeNull();
    expect(storage.getItem("kiln.nav.artifactsOpen")).toBeNull();
    expect(storage.getItem("kiln.a.nav.collapsed")).toBe('["x"]');
    expect(storage.getItem("kiln.a.nav.artifactsOpen")).toBe("false");
  });

  it("handles an unknown outgoing project (null) by only loading", () => {
    const storage = fakeStorage({ "kiln.b.nav.collapsed": '["y"]' });
    swapProjectStorage(storage, null, "b");
    expect(storage.getItem("kiln.nav.collapsed")).toBe('["y"]');
  });
});

describe("switchToProject", () => {
  it("activates BEFORE clearing the cache, re-keys storage, then resets the shell", async () => {
    const order: string[] = [];
    const storage = fakeStorage({ "kiln.nav.collapsed": '["x"]' });
    await switchToProject("b", {
      activeProjectId: "a",
      activate: async (id) => order.push(`activate:${id}`),
      storage,
      clearCache: () => order.push("clear"),
      onSwitched: (id) => order.push(`switched:${id}`),
    });
    expect(order).toEqual(["activate:b", "clear", "switched:b"]);
    expect(storage.getItem("kiln.a.nav.collapsed")).toBe('["x"]');
  });

  it("is a no-op for the already-active project", async () => {
    const order: string[] = [];
    await switchToProject("a", {
      activeProjectId: "a",
      activate: async () => order.push("activate"),
      storage: fakeStorage(),
      clearCache: () => order.push("clear"),
      onSwitched: () => order.push("switched"),
    });
    expect(order).toEqual([]);
  });

  it("does not clear the cache or reset when activation fails", async () => {
    const order: string[] = [];
    await expect(
      switchToProject("b", {
        activeProjectId: "a",
        activate: async () => {
          throw new Error("sidecar down");
        },
        storage: fakeStorage(),
        clearCache: () => order.push("clear"),
        onSwitched: () => order.push("switched"),
      }),
    ).rejects.toThrow("sidecar down");
    expect(order).toEqual([]);
  });
});

describe("createAndSwitch", () => {
  it("creates via the create route, then runs the full switch flow", async () => {
    const order: string[] = [];
    await createAndSwitch("Acme App", {
      activeProjectId: "a",
      create: async (name) => {
        order.push(`create:${name}`);
        return { id: "new" };
      },
      activate: async (id) => order.push(`activate:${id}`),
      storage: fakeStorage(),
      clearCache: () => order.push("clear"),
      onSwitched: (id) => order.push(`switched:${id}`),
    });
    expect(order).toEqual(["create:Acme App", "activate:new", "clear", "switched:new"]);
  });
});
