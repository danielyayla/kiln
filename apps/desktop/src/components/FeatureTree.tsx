import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlueprintNode, Entity, FeatureTreeNode } from "@kiln/core";
import { api } from "../lib/client";
import { productRootNode, treeProgress } from "../lib/tree-stats";
import { Badge, Button, Chevron, Input, RowMenu, SectionHeader, StatusDot, type RowMenuItem } from "./ui";
import { color, font, radius, space } from "../theme";

// The unified navigator (BP-6, redesigned in BP-15): requirements as the
// spine (child_of), each carrying its details-linked blueprints and their
// implements-linked work orders. When the store has a product root (the
// Phase 14 single-root convention, read client-side via productRootNode) the
// sidebar opens with a pinned PRODUCT block — overview + architecture — and
// the root's children render as depth-0 features; a flat store renders
// exactly as before. Row actions (add child / rename / delete) are plain
// store calls.

const COLLAPSED_KEY = "kiln.nav.collapsed";

// Section headers stay readable while the sidebar scrolls: they stick to the
// scrollport top (the nav's top padding scrolls away with the content) and
// carry the surface background so rows vanish under them.
export const stickyHeader: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: color.surface,
  paddingTop: space(1),
  paddingBottom: space(1),
};

function loadCollapsed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

const INDENT = 14;

function TreeRow({
  entity,
  depth,
  selected,
  expandable,
  open,
  onToggle,
  onSelect,
  menuItems,
  renaming,
  badge,
  meta,
}: {
  entity: Entity;
  depth: number;
  selected: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: () => void;
  menuItems: RowMenuItem[];
  renaming: ReactNode | null;
  badge?: ReactNode;
  /** Right-aligned row signal: a status dot, a progress fraction, … */
  meta?: ReactNode;
}) {
  return (
    <div
      className={`k-tree-row${selected ? " k-tree-row--selected" : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(1),
        padding: `2px ${space(1)}px`,
        paddingLeft: space(1) + depth * INDENT,
        borderRadius: radius.sm,
      }}
    >
      {expandable ? (
        <button
          aria-label={`${open ? "collapse" : "expand"} ${entity.title}`}
          aria-expanded={open}
          onClick={onToggle}
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex" }}
        >
          <Chevron open={open} />
        </button>
      ) : (
        <span style={{ width: 12, flexShrink: 0 }} />
      )}
      {badge}
      {renaming ?? (
        <button
          className="k-tree-label"
          onClick={onSelect}
          title={entity.title}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            padding: 0,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entity.title}
        </button>
      )}
      {meta}
      <RowMenu label={`actions for ${entity.title}`} items={menuItems} />
    </div>
  );
}

function InlineInput({
  depth,
  label,
  placeholder,
  initial = "",
  busy,
  onSubmit,
  onCancel,
}: {
  depth: number;
  label: string;
  placeholder: string;
  initial?: string;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: space(1), padding: `2px 0`, paddingLeft: space(1) + depth * INDENT }}>
      <Input
        autoFocus
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onBlur={onCancel}
        style={{ flex: 1, minWidth: 0, padding: `1px ${space(1.5)}px` }}
      />
      {/* onMouseDown beats the input's onBlur so submit-by-click still works */}
      <Button type="submit" disabled={!value.trim() || busy} onMouseDown={(e) => e.preventDefault()}>
        ✓
      </Button>
    </form>
  );
}

export function FeatureTree({
  selectedId,
  onSelect,
  onDeleted,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [addingChildOf, setAddingChildOf] = useState<string | null>(null);
  const [addingRoot, setAddingRoot] = useState(false);

  const tree = useQuery({ queryKey: ["tree", "chain"], queryFn: () => api.tree("chain") });

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });

  const createRequirement = useMutation({
    mutationFn: async ({ title, parentId }: { title: string; parentId?: string }) => {
      const entity = await api.createEntity({ type: "requirement", title });
      if (parentId) await api.link(entity.id, parentId, "child_of");
      return entity;
    },
    onSuccess: (entity, { parentId }) => {
      setAddingChildOf(null);
      setAddingRoot(false);
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
      if (parentId) void queryClient.invalidateQueries({ queryKey: ["linked-from", parentId, "child_of"] });
      onSelect(entity.id);
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patchEntity(id, { title }),
    onSuccess: (entity) => {
      setRenamingId(null);
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["entity", entity.id] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
      // A renamed ancestor appears in its descendants' breadcrumbs.
      void queryClient.invalidateQueries({ queryKey: ["ancestors"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEntity(id),
    onSuccess: (_res, id) => {
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["entities"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
      onDeleted(id);
    },
  });

  const confirmDelete = (entity: Entity) => {
    if (window.confirm(`Delete "${entity.title}"? This also removes its links, suggestions, and revisions.`)) {
      remove.mutate(entity.id);
    }
  };

  // Rendered inside the row (replacing the label), so it needs no indent.
  const renameInput = (entity: Entity) =>
    renamingId === entity.id ? (
      <InlineInput
        depth={0}
        label={`rename ${entity.title}`}
        placeholder="Title"
        initial={entity.title}
        busy={rename.isPending}
        onSubmit={(title) => rename.mutate({ id: entity.id, title })}
        onCancel={() => setRenamingId(null)}
      />
    ) : null;

  const renderWorkOrder = (wo: Entity, depth: number) => (
    <li key={wo.id}>
      <TreeRow
        entity={wo}
        depth={depth}
        selected={wo.id === selectedId}
        expandable={false}
        open={false}
        onToggle={() => {}}
        onSelect={() => onSelect(wo.id)}
        badge={<Badge type="work_order" />}
        meta={<StatusDot status={wo.status ?? "draft"} />}
        renaming={renameInput(wo)}
        menuItems={[
          { label: "Rename", onSelect: () => setRenamingId(wo.id) },
          { label: "Delete", danger: true, onSelect: () => confirmDelete(wo) },
        ]}
      />
    </li>
  );

  const renderBlueprint = (node: BlueprintNode, depth: number) => {
    const expandable = node.workOrders.length > 0;
    const open = expandable && !collapsed.has(node.entity.id);
    return (
      <li key={node.entity.id}>
        <TreeRow
          entity={node.entity}
          depth={depth}
          selected={node.entity.id === selectedId}
          expandable={expandable}
          open={open}
          onToggle={() => toggle(node.entity.id)}
          onSelect={() => onSelect(node.entity.id)}
          badge={<Badge type="blueprint" />}
          renaming={renameInput(node.entity)}
          menuItems={[
            { label: "Rename", onSelect: () => setRenamingId(node.entity.id) },
            { label: "Delete", danger: true, onSelect: () => confirmDelete(node.entity) },
          ]}
        />
        {open && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {node.workOrders.map((wo) => renderWorkOrder(wo, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const renderRequirement = (node: FeatureTreeNode, depth: number) => {
    const kidCount = node.children.length + (node.blueprints?.length ?? 0);
    const expandable = kidCount > 0;
    const open = expandable && !collapsed.has(node.entity.id);
    // Depth-0 rows are the features — the one level where a progress readout
    // orients more than it clutters.
    const progress = depth === 0 ? treeProgress(node) : null;
    return (
      <li key={node.entity.id}>
        <TreeRow
          entity={node.entity}
          depth={depth}
          selected={node.entity.id === selectedId}
          expandable={expandable}
          open={open}
          onToggle={() => toggle(node.entity.id)}
          onSelect={() => onSelect(node.entity.id)}
          renaming={renameInput(node.entity)}
          meta={
            progress && progress.total > 0 ? (
              <span
                title={`${progress.done} of ${progress.total} work orders done`}
                style={{
                  flexShrink: 0,
                  fontSize: font.xs,
                  color: progress.done === progress.total ? color.ok : color.muted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {progress.done}/{progress.total}
              </span>
            ) : undefined
          }
          menuItems={[
            { label: "Add child", onSelect: () => setAddingChildOf(node.entity.id) },
            { label: "Rename", onSelect: () => setRenamingId(node.entity.id) },
            { label: "Delete", danger: true, onSelect: () => confirmDelete(node.entity) },
          ]}
        />
        {addingChildOf === node.entity.id && (
          <InlineInput
            depth={depth + 1}
            label={`new child of ${node.entity.title}`}
            placeholder="New sub-requirement"
            busy={createRequirement.isPending}
            onSubmit={(title) => createRequirement.mutate({ title, parentId: node.entity.id })}
            onCancel={() => setAddingChildOf(null)}
          />
        )}
        {open && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {node.blueprints?.map((b) => renderBlueprint(b, depth + 1))}
            {node.children.map((c) => renderRequirement(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const product = productRootNode(tree.data ?? []);
  const features = product ? product.children : (tree.data ?? []);
  const overall = product ? treeProgress(product) : null;
  // With a product root, new requirements are features UNDER it — a second
  // parentless requirement would silently dissolve the Phase 14 convention.
  const newRequirementParent = product?.entity.id;

  return (
    <section aria-label="Feature tree">
      {product && (
        <div style={{ marginBottom: space(4) }}>
          <SectionHeader style={{ ...stickyHeader, margin: 0, marginBottom: space(0.5) }}>Product</SectionHeader>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <li>
              <TreeRow
                entity={product.entity}
                depth={0}
                selected={product.entity.id === selectedId}
                expandable={false}
                open={false}
                onToggle={() => {}}
                onSelect={() => onSelect(product.entity.id)}
                renaming={renameInput(product.entity)}
                meta={
                  overall && overall.total > 0 ? (
                    <span
                      title={`${overall.done} of ${overall.total} work orders done across the project`}
                      style={{
                        flexShrink: 0,
                        fontSize: font.xs,
                        color: color.muted,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {overall.done}/{overall.total}
                    </span>
                  ) : undefined
                }
                // Deleting the product root belongs to the document view, not
                // a one-click sidebar menu.
                menuItems={[
                  { label: "New feature", onSelect: () => setAddingRoot(true) },
                  { label: "Rename", onSelect: () => setRenamingId(product.entity.id) },
                ]}
              />
              {(product.blueprints?.length ?? 0) > 0 && (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {product.blueprints?.map((b) => renderBlueprint(b, 1))}
                </ul>
              )}
            </li>
          </ul>
        </div>
      )}
      <div style={{ ...stickyHeader, display: "flex", alignItems: "center", marginBottom: space(0.5) }}>
        <SectionHeader style={{ margin: 0, flex: 1 }}>Features</SectionHeader>
        <Button
          variant="ghost"
          aria-label={product ? "New feature" : "New requirement"}
          onClick={() => setAddingRoot(true)}
          style={{ padding: `0 ${space(1.5)}px`, color: color.muted }}
        >
          +
        </Button>
      </div>
      {features.length === 0 && !addingRoot && <p style={{ color: color.muted }}>No requirements yet.</p>}
      <ul data-testid="feature-tree" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {features.map((n) => renderRequirement(n, 0))}
      </ul>
      {addingRoot && (
        <InlineInput
          depth={0}
          label={product ? "New feature title" : "New requirement title"}
          placeholder={product ? "New feature" : "New requirement"}
          busy={createRequirement.isPending}
          onSubmit={(title) => createRequirement.mutate({ title, parentId: newRequirementParent })}
          onCancel={() => setAddingRoot(false)}
        />
      )}
    </section>
  );
}
