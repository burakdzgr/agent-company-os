// Memory relation graph (12 §8.2): nodes styled by type/scope, size ∝
// importance, opacity ∝ confidence; edges styled per relation kind —
// contradicts red dashed, derived_from thick directional, supports green,
// supersedes gray, related_to thin. Server caps at 500 nodes.
import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@acos/ui";
import { api } from "../../lib/api.js";

const SCOPE_COLOR: Record<string, string> = {
  company: "#7c3aed",
  project: "#2563eb",
  agent: "#059669",
};

const EDGE_STYLE: Record<string, { color: string; style: "solid" | "dashed"; width: number }> = {
  contradicts: { color: "#dc2626", style: "dashed", width: 2.5 },
  derived_from: { color: "#7c3aed", style: "solid", width: 3 },
  supports: { color: "#16a34a", style: "solid", width: 1.5 },
  supersedes: { color: "#6b7280", style: "solid", width: 2 },
  related_to: { color: "#9ca3af", style: "solid", width: 1 },
};

export function MemoryGraph({
  companyId,
  onSelect,
}: {
  companyId: string;
  onSelect: (memoryId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graph = useQuery({
    queryKey: [companyId, "memories", "graph"],
    queryFn: () => api.memories.graph(companyId),
  });

  useEffect(() => {
    if (!containerRef.current || !graph.data) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...graph.data.nodes.map((node) => ({
          data: { ...node, label: node.title.slice(0, 40) },
        })),
        ...graph.data.edges.map((edge, i) => ({
          data: { id: `e${i}`, source: edge.from, target: edge.to, kind: edge.kind },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "font-size": "9px",
            "text-valign": "bottom",
            shape: "ellipse",
            width: (el: cytoscape.NodeSingular) => 20 + 30 * (el.data("importance") as number),
            height: (el: cytoscape.NodeSingular) => 20 + 30 * (el.data("importance") as number),
            "background-color": (el: cytoscape.NodeSingular) =>
              SCOPE_COLOR[el.data("scope") as string] ?? "#6b7280",
            "background-opacity": (el: cytoscape.NodeSingular) =>
              0.35 + 0.65 * (el.data("confidence") as number),
            "border-width": (el: cytoscape.NodeSingular) =>
              el.data("status") === "candidate" ? 2 : 0,
            "border-style": "dashed",
            "border-color": "#f59e0b",
          },
        },
        ...Object.entries(EDGE_STYLE).map(([kind, style]) => ({
          selector: `edge[kind = "${kind}"]`,
          style: {
            width: style.width,
            "line-color": style.color,
            "line-style": style.style,
            "target-arrow-shape": "triangle" as const,
            "target-arrow-color": style.color,
            "curve-style": "bezier" as const,
          },
        })),
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: () => 8000 },
    });
    cy.on("tap", "node", (event) => onSelect(event.target.id() as string));
    cy.on("tap", (event) => {
      if (event.target === cy) onSelect(null);
    });
    return () => cy.destroy();
  }, [graph.data, onSelect]);

  return (
    <Card className="p-2" data-testid="memory-graph">
      {graph.data?.capped && (
        <p className="p-2 text-xs text-amber-600">
          Graph capped at 500 nodes — narrow the filters.
        </p>
      )}
      <div ref={containerRef} style={{ height: 560 }} />
    </Card>
  );
}
