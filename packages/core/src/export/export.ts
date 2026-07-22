import { LINK_TYPES, type Entity } from "../domain";
import type { Store } from "../store";
import { featureTree, type FeatureTreeNode } from "../graph/tree";

// Graph-to-markdown export (FRD Phase 5): the whole knowledge graph as plain
// files, so the data is never locked in and the graph diffs outside the app.
// This module is PURE — it returns file descriptions and touches no
// filesystem; the CLI owns all fs work.

export interface ExportFile {
  relativePath: string;
  contents: string;
}

// slugified title + 8-char id suffix: readable, and renames don't orphan the
// file's identity (round-trip-friendly naming).
function slug(entity: Entity): string {
  const base = entity.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "untitled"}-${entity.id.slice(0, 8)}`;
}

// YAML string scalar. JSON string escaping is valid YAML for double-quoted
// scalars, so this stays correct for quotes, colons, and newlines.
const yamlString = (s: string): string => JSON.stringify(s);

// Front-matter: id, type, title, status, and every OUTGOING link by type with
// target ids+titles — enough to rebuild the graph or review it in a diff.
function frontMatter(store: Store, entity: Entity): string {
  const lines = [
    "---",
    `id: ${entity.id}`,
    `type: ${entity.type}`,
    `title: ${yamlString(entity.title)}`,
  ];
  if (entity.status !== null) lines.push(`status: ${entity.status}`);
  if (entity.workType != null) lines.push(`workType: ${entity.workType}`);

  const linkLines: string[] = [];
  for (const type of LINK_TYPES) {
    const targets = [...store.linked(entity.id, type)].sort(byTitleThenId);
    if (targets.length === 0) continue;
    linkLines.push(`  ${type}:`);
    for (const t of targets) {
      linkLines.push(`    - id: ${t.id}`);
      linkLines.push(`      title: ${yamlString(t.title)}`);
    }
  }
  if (linkLines.length > 0) lines.push("links:", ...linkLines);

  lines.push("---");
  return lines.join("\n");
}

function render(store: Store, entity: Entity): string {
  const body = entity.body.length > 0 ? `\n${entity.body}\n` : "";
  return `${frontMatter(store, entity)}\n${body}`;
}

// Deterministic ordering everywhere: created_at can tie within a millisecond,
// so every sibling list is re-sorted by (title, id) before layout.
const byTitleThenId = (a: Entity, b: Entity): number =>
  a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

// Export the whole graph. Layout follows the feature tree: each requirement is
// a folder (nested by child_of), holding its own document plus the blueprints
// detailing it and the work orders implementing those blueprints. Artifacts
// live under artifacts/. Every entity the tree walk did not place — parentless
// cycles, blueprints detailing nothing, work orders implementing nothing —
// lands under unfiled/ so nothing is silently dropped.
export function exportGraph(store: Store): ExportFile[] {
  const files: ExportFile[] = [];
  const placed = new Set<string>();

  const place = (dir: string, entity: Entity): void => {
    placed.add(entity.id);
    files.push({ relativePath: `${dir}${slug(entity)}.md`, contents: render(store, entity) });
  };

  const walk = (node: FeatureTreeNode, parentDir: string): void => {
    const dir = `${parentDir}${slug(node.entity)}/`;
    place(dir, node.entity);
    for (const bp of [...(node.blueprints ?? [])].sort((a, b) => byTitleThenId(a.entity, b.entity))) {
      place(dir, bp.entity);
      for (const wo of [...bp.workOrders].sort(byTitleThenId)) {
        // A work order can implement two blueprints beside the same
        // requirement; first placement wins, the file is not duplicated.
        if (!placed.has(wo.id)) place(dir, wo);
      }
    }
    for (const child of [...node.children].sort((a, b) => byTitleThenId(a.entity, b.entity))) {
      walk(child, dir);
    }
  };

  for (const root of [...featureTree(store, { expand: "chain" })].sort((a, b) =>
    byTitleThenId(a.entity, b.entity),
  )) {
    walk(root, "");
  }

  for (const artifact of [...store.listEntities("artifact")].sort(byTitleThenId)) {
    place("artifacts/", artifact);
  }

  // Everything the walk missed, in one predictable place.
  const orphans = (["requirement", "blueprint", "work_order"] as const)
    .flatMap((type) => store.listEntities(type))
    .filter((e) => !placed.has(e.id))
    .sort(byTitleThenId);
  for (const orphan of orphans) place("unfiled/", orphan);

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
