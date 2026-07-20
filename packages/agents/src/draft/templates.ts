import type { AuthoringSkill } from "@kiln/core";

// A template is the "house style" for a document kind (BP-4): it tells the
// drafting agent what structure a good document has. Swapping the template
// changes the structure of what gets drafted — nothing else in the pipeline
// changes.
export interface DraftTemplate {
  name: string;
  /** One line describing what kind of document this template drafts. */
  kind: string;
  /** The required document structure, stated as concrete section headings. */
  structure: string;
  /** Optional extra style guidance. */
  guidance?: string;
}

// Structures follow the house authoring methodology (the "Kiln authoring
// methodology" artifact in the store / docs/authoring-methodology.md).
export const REQUIREMENT_TEMPLATE: DraftTemplate = {
  name: "methodology-requirement",
  kind: "requirement (a capability the user gains)",
  structure: `## Capability
<one paragraph: what the user can do after this exists that they cannot today — user terms, not system terms>

## Why
<the motivating problem or opportunity, grounded in the source artifacts>

## Scope
- <observable behavior that is IN>

## Non-goals
- <adjacent scope explicitly declined — never "None">

## Success criteria
- <observable, ideally demoable check>`,
  guidance:
    "Ground every claim in the source artifacts. A requirement states a capability the user gains, not a batch of work. " +
    "At least one non-goal is mandatory — every feature has adjacent scope it should decline. " +
    "Success criteria must be verifiable without asking the author.",
};

export const BLUEPRINT_TEMPLATE: DraftTemplate = {
  name: "methodology-blueprint",
  kind: "blueprint (a feature's technical how, for exactly one requirement)",
  structure: `## Approach
<the chosen design in one or two paragraphs — a reader should be able to predict the shape of the diff>

## Key decisions
- **<decision>** — chosen because <reason>. Rejected: <alternative> (<one-line reason>).

## Affected components
- <package/layer that changes>: <how>
- Untouched: <what explicitly does not change>

## Conventions & constraints
- <rule the implementation must follow that the code cannot express>

## Verification strategy
<which layers get unit tests; what must be verified live in the running app>`,
  guidance:
    "Optimize for decisions, not prose; stay at the architectural altitude. " +
    "Record at least one rejected alternative — it saves the next agent from re-litigating. " +
    "State what is untouched, not only what changes.",
};

// The document types a skill can declare a template override for, spelled the
// way the convention spells them in the `## Template: <type>` header.
export type TemplateTargetType = "requirement" | "blueprint" | "work-order";

// Find a user-authored template override for `type` in the active skills: the
// content of the first `## Template: <type>` section, in skill array order —
// first declaring skill wins, deterministically. Template bodies legitimately
// contain `##` headings themselves (they ARE document structures), so the
// section cannot end at the next heading. Instead: if the section opens with a
// ``` fence, the fence interior is the template; otherwise it runs to the next
// `## Template:` declaration or end of body. Returned verbatim (trimmed);
// null when no skill declares one.
export function templateSectionFromSkills(
  skills: AuthoringSkill[],
  type: TemplateTargetType,
): string | null {
  for (const skill of skills) {
    const lines = skill.body.split("\n");
    const start = lines.findIndex((l) => l.trim() === `## Template: ${type}`);
    if (start === -1) continue;

    // Skip blank lines after the header.
    let i = start + 1;
    while (i < lines.length && lines[i].trim() === "") i++;

    let section: string;
    if (lines[i]?.trim().startsWith("```")) {
      // Fenced template: take the fence interior.
      const close = lines.findIndex((l, j) => j > i && l.trim().startsWith("```"));
      section = lines.slice(i + 1, close === -1 ? lines.length : close).join("\n");
    } else {
      let end = lines.length;
      for (let j = i; j < lines.length; j++) {
        if (lines[j].trim().startsWith("## Template:")) {
          end = j;
          break;
        }
      }
      section = lines.slice(i, end).join("\n");
    }
    const trimmed = section.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
