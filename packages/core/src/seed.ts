import type { Entity } from "./domain";
import type { Store } from "./store";

// Seeding a new project (Projects feature): every project is born with the same
// root shape Kiln itself has — a product-root requirement (the PRD-equivalent:
// overview + non-goals) AND its `details` blueprint (the project design doc:
// architecture, stack, conventions). See docs/authoring-methodology.md §1.
//
// Seeding the design doc here (not leaving it to be added later through the UI)
// is what makes it "global": Phase-14 lineage inheritance folds the product
// root's `details` blueprint into EVERY work order's assembled context as tier-3
// background, so the design doc reaches every agent handoff for free. A project
// without one silently ships a degraded context to every downstream work order.

// A fill-in starter for the project design doc. Non-empty on purpose: it clears
// contextHealth's `missing-architecture` warning and gives the author a shape to
// fill rather than a blank page. Headings match the architecture-blueprint
// sections Kiln's own design doc uses.
export const DESIGN_DOC_TEMPLATE = `## Overview

_What this product is and the problem it solves, in a paragraph or two._

## Architecture

_The major components and how they fit together. A diagram helps._

## Data flow

_How information moves through the system — the important paths, not every call._

## Stack & conventions

_Languages, frameworks, key libraries, and the house rules for working in this
codebase._

## Non-goals

_What this product deliberately does not do._
`;

export interface SeededProject {
  root: Entity;
  designDoc: Entity;
}

// Seeds a fresh store with the product root and its design-doc blueprint. Shared
// by both create paths (desktop sidecar + CLI) so they can never drift.
export function seedProject(store: Store, name: string): SeededProject {
  const root = store.createEntity({ type: "requirement", title: name, body: "" });
  const designDoc = store.createEntity({
    type: "blueprint",
    title: `${name} system architecture`,
    body: DESIGN_DOC_TEMPLATE,
  });
  // `details` direction: blueprint -> requirement (1:1, enforced store-side).
  store.link(designDoc.id, root.id, "details");
  return { root, designDoc };
}
