import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import {
  AUTHORING_SKILLS_KEY,
  readAuthoringSkillDocs,
  resolveAuthoringSkills,
  writeAuthoringSkillDocs,
  type AuthoringSkillDoc,
} from "./skills";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

function doc(id: string, title: string, enabled = true): AuthoringSkillDoc {
  return { id, title, body: `${title} body`, enabled };
}

describe("readAuthoringSkillDocs / writeAuthoringSkillDocs", () => {
  it("reads an empty array when the setting is absent", () => {
    expect(readAuthoringSkillDocs(store)).toEqual([]);
  });

  it("round-trips docs preserving order and the enabled flag", () => {
    const docs = [doc("a", "Style guide"), doc("b", "Terminology", false), doc("c", "Templates")];
    writeAuthoringSkillDocs(store, docs);
    expect(readAuthoringSkillDocs(store)).toEqual(docs);
  });

  it("skips non-document entries and reads malformed values as empty", () => {
    store.setSetting(
      AUTHORING_SKILLS_KEY,
      JSON.stringify([doc("a", "Kept"), { id: "x" }, 42, null]),
    );
    expect(readAuthoringSkillDocs(store).map((d) => d.id)).toEqual(["a"]);

    store.setSetting(AUTHORING_SKILLS_KEY, "not json");
    expect(readAuthoringSkillDocs(store)).toEqual([]);
    store.setSetting(AUTHORING_SKILLS_KEY, JSON.stringify({ docs: [] }));
    expect(readAuthoringSkillDocs(store)).toEqual([]);
  });

  it("reads the legacy artifact-id shape (string array) as empty", () => {
    store.setSetting(AUTHORING_SKILLS_KEY, JSON.stringify(["some-artifact-id", "another"]));
    expect(readAuthoringSkillDocs(store)).toEqual([]);
  });
});

describe("resolveAuthoringSkills", () => {
  it("returns an empty array when nothing is stored or nothing is enabled", () => {
    expect(resolveAuthoringSkills(store)).toEqual([]);
    writeAuthoringSkillDocs(store, [doc("a", "Off", false)]);
    expect(resolveAuthoringSkills(store)).toEqual([]);
  });

  it("returns only enabled docs, in array order, as {title, body}", () => {
    writeAuthoringSkillDocs(store, [
      doc("c", "Terminology"),
      doc("a", "Style guide", false),
      doc("b", "Blueprint template"),
    ]);
    expect(resolveAuthoringSkills(store)).toEqual([
      { title: "Terminology", body: "Terminology body" },
      { title: "Blueprint template", body: "Blueprint template body" },
    ]);
  });

  it("exposes exactly the frozen agents contract — no id or enabled leakage", () => {
    writeAuthoringSkillDocs(store, [doc("a", "Style guide")]);
    const [skill] = resolveAuthoringSkills(store);
    expect(Object.keys(skill).sort()).toEqual(["body", "title"]);
  });
});
