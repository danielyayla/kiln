import { describe, expect, it } from "vitest";
import type { Entity } from "@kiln/core";
import { entitySchema } from "./entity-schema.js";

// The bundled and standalone MCP endpoints hand `entitySchema` to clients as a
// tool `outputSchema`. Zod objects compile to JSON Schema with
// `additionalProperties: false`, so any field the store emits on an `Entity`
// that this mirror omits makes strict clients reject the whole response
// (regression: `criticality` was dropped, breaking get_work_order /
// update_work_order_status for strict clients). This guard fails the moment the
// two drift apart in either direction.
describe("entitySchema mirrors core Entity", () => {
  // A fully-populated Entity. Typed as `Entity`, so adding a field to core
  // without one here is a compile error — the runtime keys below stay complete.
  const fullEntity: Entity = {
    id: "e1",
    type: "work_order",
    title: "A work order",
    body: "Body.",
    status: "ready",
    workType: "bug",
    criticality: "critical",
    assignee: "agent",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };

  it("accepts a real Entity with no extra keys (strict) — catches a missing mirror field", () => {
    // strict() throws on keys present on the entity but absent from the schema,
    // which is exactly how a dropped field surfaces to a strict MCP client.
    expect(() => entitySchema.strict().parse(fullEntity)).not.toThrow();
  });

  it("has exactly the keys of core Entity — catches drift in either direction", () => {
    const schemaKeys = Object.keys(entitySchema.shape).sort();
    const entityKeys = Object.keys(fullEntity).sort();
    expect(schemaKeys).toEqual(entityKeys);
  });

  it("mirrors the nullable fields as nullable", () => {
    const withNulls: Entity = {
      ...fullEntity,
      status: null,
      workType: null,
      criticality: null,
      assignee: null,
    };
    expect(() => entitySchema.strict().parse(withNulls)).not.toThrow();
  });
});
