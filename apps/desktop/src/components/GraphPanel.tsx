import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Entity, LinkType } from "@kiln/core";
import { api } from "../lib/client";
import { friendlyError } from "../lib/errors";
import { Badge, Button, Input, SectionHeader, Select, useToast } from "./ui";
import { color, font, radius, space } from "../theme";

// The knowledge-graph neighbourhood of the opened entity, as a right-hand
// panel (BP-5). Every row is an edge in the graph: clicking navigates, the
// forms create new edges. Which sections show depends on the entity type —
// the panel reads the same /linked and /linked-from routes as before, it
// just lives beside the document instead of below it.

function EntityRow({ entity, onSelect }: { entity: Entity; onSelect: (id: string) => void }) {
  return (
    <li>
      <button
        onClick={() => onSelect(entity.id)}
        title={entity.title}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space(1.5),
          width: "100%",
          textAlign: "left",
          padding: `${space(1)}px ${space(1.5)}px`,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          background: color.bg,
          cursor: "pointer",
          fontSize: font.sm,
        }}
      >
        <Badge type={entity.type} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entity.title}
        </span>
        {entity.status && (
          <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: font.xs, color: color.muted }}>
            {entity.status}
          </span>
        )}
      </button>
    </li>
  );
}

function Section({
  title,
  entities,
  onSelect,
  emptyLabel = "none",
  children,
}: {
  title: string;
  entities: Entity[] | undefined;
  onSelect: (id: string) => void;
  emptyLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: space(4) }}>
      <SectionHeader size="sm">
        {title}
        {entities && entities.length > 0 ? ` · ${entities.length}` : ""}
      </SectionHeader>
      {entities?.length === 0 && !children && (
        <p style={{ color: color.faint, fontSize: font.sm, margin: 0 }}>{emptyLabel}</p>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(1) }}>
        {entities?.map((e) => <EntityRow key={e.id} entity={e} onSelect={onSelect} />)}
      </ul>
      {children}
    </section>
  );
}

function useLinked(id: string, type: LinkType, enabled: boolean) {
  return useQuery({
    queryKey: ["linked", id, type],
    queryFn: () => api.linked(id, type),
    enabled,
  });
}

function useLinkedFrom(id: string, type: LinkType, enabled: boolean) {
  return useQuery({
    queryKey: ["linked-from", id, type],
    queryFn: () => api.linkedFrom(id, type),
    enabled,
  });
}

export function GraphPanel({ entityId, onSelect }: { entityId: string; onSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [childTitle, setChildTitle] = useState("");
  const [blueprintTitle, setBlueprintTitle] = useState("");
  const [artifactToRef, setArtifactToRef] = useState("");

  const entity = useQuery({ queryKey: ["entity", entityId], queryFn: () => api.getEntity(entityId) });
  const type = entity.data?.type;
  const isRequirement = type === "requirement";
  const isBlueprint = type === "blueprint";
  const isWorkOrder = type === "work_order";
  const isArtifact = type === "artifact";

  // Edge directions (BP-2): child --child_of--> parent, blueprint --details-->
  // requirement, work_order --implements--> blueprint, requirement
  // --references--> artifact.
  const parents = useLinked(entityId, "child_of", isRequirement);
  const children = useLinkedFrom(entityId, "child_of", isRequirement);
  const blueprints = useLinkedFrom(entityId, "details", isRequirement);
  const references = useLinked(entityId, "references", isRequirement);
  const detailsReq = useLinked(entityId, "details", isBlueprint);
  const workOrders = useLinkedFrom(entityId, "implements", isBlueprint);
  const implementsBp = useLinked(entityId, "implements", isWorkOrder);
  // depends_on both directions (WO-B2): what must finish before this one, and
  // what is waiting on it.
  const dependsOn = useLinked(entityId, "depends_on", isWorkOrder);
  const dependents = useLinkedFrom(entityId, "depends_on", isWorkOrder);
  const referencedBy = useLinkedFrom(entityId, "references", isArtifact);

  const artifacts = useQuery({
    queryKey: ["entities", "artifact"],
    queryFn: () => api.listEntities("artifact"),
    enabled: isRequirement,
  });

  const addChild = useMutation({
    mutationFn: async (title: string) => {
      const child = await api.createEntity({ type: "requirement", title });
      await api.link(child.id, entityId, "child_of");
      return child;
    },
    onSuccess: () => {
      setChildTitle("");
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["linked-from", entityId, "child_of"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  // Create a blueprint detailing this requirement (BP-6). The details edge is
  // written by core, which enforces its 1:1 rule (a blueprint details exactly
  // one requirement) — any rejection surfaces as a toast, not a webview check.
  const addBlueprint = useMutation({
    mutationFn: async (title: string) => {
      const blueprint = await api.createEntity({ type: "blueprint", title });
      await api.link(blueprint.id, entityId, "details");
      return blueprint;
    },
    onSuccess: (blueprint) => {
      setBlueprintTitle("");
      void queryClient.invalidateQueries({ queryKey: ["linked-from", entityId, "details"] });
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
      onSelect(blueprint.id);
    },
    onError: (e) => toast(friendlyError(e)),
  });

  const addReference = useMutation({
    mutationFn: (artifactId: string) => api.link(entityId, artifactId, "references"),
    onSuccess: () => {
      setArtifactToRef("");
      void queryClient.invalidateQueries({ queryKey: ["linked", entityId, "references"] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  const referencedIds = new Set(references.data?.map((a) => a.id));
  const referencable = artifacts.data?.filter((a) => !referencedIds.has(a.id)) ?? [];

  return (
    <aside data-testid="graph-panel" aria-label="Knowledge graph" style={{ padding: space(4) }}>
      {entity.data && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space(1.5),
            padding: `${space(1.5)}px ${space(2)}px`,
            border: `1px solid ${color.borderStrong}`,
            borderRadius: radius.md,
            background: color.chip,
            marginBottom: space(4),
            fontSize: font.sm,
            fontWeight: 600,
          }}
        >
          <Badge type={entity.data.type} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {entity.data.title}
          </span>
        </div>
      )}

      {isRequirement && (
        <>
          {(parents.data?.length ?? 0) > 0 && (
            <Section title="Parent requirement" entities={parents.data} onSelect={onSelect} />
          )}

          <Section title="Sub-requirements" entities={children.data} onSelect={onSelect} emptyLabel="none yet">
            <form
              style={{ display: "flex", gap: space(1), marginTop: space(1.5) }}
              onSubmit={(ev) => {
                ev.preventDefault();
                if (childTitle.trim()) addChild.mutate(childTitle.trim());
              }}
            >
              <Input
                aria-label="New sub-requirement title"
                value={childTitle}
                onChange={(ev) => setChildTitle(ev.target.value)}
                placeholder="New sub-requirement"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button type="submit" disabled={!childTitle.trim() || addChild.isPending}>
                +
              </Button>
            </form>
          </Section>

          <Section title="Blueprints" entities={blueprints.data} onSelect={onSelect} emptyLabel="none yet">
            <form
              style={{ display: "flex", gap: space(1), marginTop: space(1.5) }}
              onSubmit={(ev) => {
                ev.preventDefault();
                if (blueprintTitle.trim()) addBlueprint.mutate(blueprintTitle.trim());
              }}
            >
              <Input
                aria-label="New blueprint title"
                value={blueprintTitle}
                onChange={(ev) => setBlueprintTitle(ev.target.value)}
                placeholder="New blueprint"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button type="submit" disabled={!blueprintTitle.trim() || addBlueprint.isPending}>
                +
              </Button>
            </form>
          </Section>

          <Section title="Referenced artifacts" entities={references.data} onSelect={onSelect}>
            {referencable.length > 0 && (
              <form
                style={{ display: "flex", gap: space(1), marginTop: space(1.5) }}
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (artifactToRef) addReference.mutate(artifactToRef);
                }}
              >
                <Select
                  aria-label="Artifact to reference"
                  value={artifactToRef}
                  onChange={(ev) => setArtifactToRef(ev.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <option value="">reference an artifact…</option>
                  {referencable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </Select>
                <Button type="submit" disabled={!artifactToRef || addReference.isPending}>
                  +
                </Button>
              </form>
            )}
          </Section>
        </>
      )}

      {isBlueprint && (
        <>
          <Section title="Details requirement" entities={detailsReq.data} onSelect={onSelect} />
          <Section title="Work orders" entities={workOrders.data} onSelect={onSelect} emptyLabel="none extracted yet" />
        </>
      )}

      {isWorkOrder && (
        <>
          <Section title="Implements blueprint" entities={implementsBp.data} onSelect={onSelect} />
          <Section title="Depends on" entities={dependsOn.data} onSelect={onSelect} emptyLabel="no prerequisites" />
          <Section title="Blocks" entities={dependents.data} onSelect={onSelect} emptyLabel="nothing waits on this" />
        </>
      )}

      {isArtifact && <Section title="Referenced by" entities={referencedBy.data} onSelect={onSelect} />}
    </aside>
  );
}
