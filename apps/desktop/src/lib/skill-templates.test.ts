import { describe, expect, it } from "vitest";
import { declaredTemplateTypes } from "./skill-templates";

describe("declaredTemplateTypes", () => {
  it("returns empty for a body with no template headings", () => {
    expect(declaredTemplateTypes("Just prose.\n## Structure\nMore prose.")).toEqual([]);
  });

  it("detects a single declared type", () => {
    expect(declaredTemplateTypes("intro\n## Template: blueprint\n\n```\n## Approach\n```\n")).toEqual([
      "blueprint",
    ]);
  });

  it("detects multiple types in order of appearance, deduplicated", () => {
    const body = [
      "## Template: work-order",
      "```",
      "## Scope",
      "```",
      "## Template: requirement",
      "## Template: work-order",
    ].join("\n");
    expect(declaredTemplateTypes(body)).toEqual(["work-order", "requirement"]);
  });

  it("ignores heading lines inside code fences", () => {
    const body = ["```", "## Template: blueprint", "```", "prose"].join("\n");
    expect(declaredTemplateTypes(body)).toEqual([]);
  });

  it("ignores unknown types and non-heading mentions", () => {
    const body = ["## Template: essay", "mentions ## Template: blueprint inline"].join("\n");
    expect(declaredTemplateTypes(body)).toEqual([]);
  });

  it("tolerates surrounding whitespace in the heading", () => {
    expect(declaredTemplateTypes("##  Template:  requirement  ")).toEqual(["requirement"]);
  });
});
