// Display-only detection of template-override declarations in an authoring
// skill body. The real convention (parsing, first-enabled-wins resolution)
// lives in packages/agents — this helper only tells the Settings list which
// badges to show and must never feed prompt assembly.

const TEMPLATE_TYPES = ["requirement", "blueprint", "work-order"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

const HEADING = /^##\s*Template:\s*(requirement|blueprint|work-order)\s*$/;

// Returns the template types a body declares, in order of appearance,
// deduplicated. Heading lines inside code fences don't count — fenced content
// is template PAYLOAD, not a declaration.
export function declaredTemplateTypes(body: string): TemplateType[] {
  const found: TemplateType[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING.exec(line.trimEnd());
    const type = m?.[1] as TemplateType | undefined;
    if (type && !found.includes(type)) found.push(type);
  }
  return found;
}
