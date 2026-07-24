import { describe, expect, it } from "vitest";
import type { AgentAccessStatus, ProjectList } from "./client";
import {
  claudeMcpAddCommand,
  jsonConfigSnippet,
  rePinPrompt,
  showConnection,
  statusLine,
} from "./agent-access";

const running: AgentAccessStatus = {
  enabled: true,
  running: true,
  port: 4824,
  endpoint: "http://127.0.0.1:4824/mcp",
  token: "deadbeef".repeat(8),
  project: { id: "p1", name: "Kiln" },
  error: null,
};

const projects = (activeProject: string | null, names: Record<string, string> = { p1: "Kiln", p2: "Website" }): ProjectList => ({
  projects: Object.entries(names).map(([id, name]) => ({
    id,
    name,
    slug: name.toLowerCase(),
    createdAt: "2026-07-24T00:00:00.000Z",
    lastOpenedAt: null,
  })),
  defaultProject: null,
  activeProject,
});

describe("claudeMcpAddCommand", () => {
  it("renders the endpoint and token verbatim from status", () => {
    expect(claudeMcpAddCommand(running)).toBe(
      `claude mcp add --transport http kiln http://127.0.0.1:4824/mcp --header "Authorization: Bearer ${running.token}"`,
    );
  });

  it("re-renders in place when the token changes (regenerate)", () => {
    const rotated = { ...running, token: "cafef00d".repeat(8) };
    expect(claudeMcpAddCommand(rotated)).toContain(rotated.token);
    expect(claudeMcpAddCommand(rotated)).not.toContain(running.token);
  });
});

describe("jsonConfigSnippet", () => {
  it("is valid JSON carrying exactly the status url and bearer token", () => {
    const parsed = JSON.parse(jsonConfigSnippet(running));
    expect(parsed.mcpServers.kiln.url).toBe(running.endpoint);
    expect(parsed.mcpServers.kiln.headers.Authorization).toBe(`Bearer ${running.token}`);
    expect(parsed.mcpServers.kiln.type).toBe("http");
  });
});

describe("showConnection", () => {
  it("shows the snippet only when the listener is running", () => {
    expect(showConnection(running)).toBe(true);
    expect(showConnection({ ...running, running: false })).toBe(false);
  });

  it("hides the snippet while disabled and while enabled-but-not-running", () => {
    expect(showConnection({ ...running, enabled: false, running: false })).toBe(false);
    // Bind failed: enabled but not running, with an error — no dead command.
    expect(showConnection({ ...running, running: false, error: "port 4824 is already in use" })).toBe(false);
  });
});

describe("rePinPrompt", () => {
  it("is null when the active project equals the pin", () => {
    expect(rePinPrompt(running, projects("p1"))).toBeNull();
  });

  it("names both projects when active differs from the pin", () => {
    expect(rePinPrompt(running, projects("p2"))).toEqual({
      activeId: "p2",
      activeName: "Website",
      pinnedName: "Kiln",
    });
  });

  it("offers to adopt the active project when nothing is pinned (removed pin)", () => {
    const removed = { ...running, running: false, project: null, error: "pinned project was removed" };
    expect(rePinPrompt(removed, projects("p2"))).toEqual({
      activeId: "p2",
      activeName: "Website",
      pinnedName: null,
    });
  });

  it("is null when the active project is unknown or unresolvable", () => {
    expect(rePinPrompt(running, projects(null))).toBeNull();
    expect(rePinPrompt(running, undefined)).toBeNull();
    // active id not present in the project list
    expect(rePinPrompt(running, projects("ghost"))).toBeNull();
  });
});

describe("statusLine", () => {
  it("leads with the actionable error whenever one is present", () => {
    const line = statusLine({ ...running, running: false, error: "port 4824 is already in use" });
    expect(line.tone).toBe("error");
    expect(line.text).toBe("port 4824 is already in use");
  });

  it("reports the port and served project while running", () => {
    const line = statusLine(running);
    expect(line.tone).toBe("running");
    expect(line.text).toContain("4824");
    expect(line.text).toContain("Kiln");
  });

  it("reads stopped when disabled and not running", () => {
    expect(statusLine({ ...running, enabled: false, running: false })).toEqual({
      tone: "stopped",
      text: "Stopped",
    });
  });
});
