import type { Store } from "../store/store";

// The settings key holding the authoring skills. Since the 2026-07-13 reversal
// (see the "Authoring skills & prompt injection" blueprint) the value is a JSON
// array of FULL skill documents — skills are app configuration, not entities,
// and live only in Settings. Array order = injection order.
export const AUTHORING_SKILLS_KEY = "kiln.authoring.skills";

// What agents receive. This contract is frozen — packages/agents depends on
// exactly {title, body} and stays blind to storage.
export interface AuthoringSkill {
  title: string;
  body: string;
}

// What Settings stores and edits: a skill document with a stable identity and
// an on/off switch. Disabled skills stay listed in Settings instead of being
// forgotten; only enabled ones reach prompts.
export interface AuthoringSkillDoc extends AuthoringSkill {
  id: string;
  enabled: boolean;
}

function isSkillDoc(value: unknown): value is AuthoringSkillDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.enabled === "boolean"
  );
}

// Read every stored skill document, in order. Malformed values, non-object
// entries, and the legacy artifact-id shape (an array of strings) all read as
// empty/skipped — a read never throws over a bad setting.
export function readAuthoringSkillDocs(store: Store): AuthoringSkillDoc[] {
  const raw = store.getSetting(AUTHORING_SKILLS_KEY);
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isSkillDoc);
}

// Persist the skill documents verbatim. The caller owns validation beyond the
// shape (e.g. id uniqueness at the API boundary).
export function writeAuthoringSkillDocs(store: Store, docs: AuthoringSkillDoc[]): void {
  store.setSetting(AUTHORING_SKILLS_KEY, JSON.stringify(docs));
}

// Resolve what agents should see: the ENABLED skills, in array order, reduced
// to the frozen {title, body} contract.
export function resolveAuthoringSkills(store: Store): AuthoringSkill[] {
  return readAuthoringSkillDocs(store)
    .filter((doc) => doc.enabled)
    .map(({ title, body }) => ({ title, body }));
}
