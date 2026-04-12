import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import * as d3 from "d3";
import { Network, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KBGraph, KBGraphNode } from "@shared/rpc-types";

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  type: KBGraphNode["type"];
  filePath: string;
  degree: number;
}

type SimLink = d3.SimulationLinkDatum<SimNode>;

interface Props {
  graph: KBGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: KBGraphNode) => void;
  onClearSelection: () => void;
}

const NODE_COLOR: Record<string, string> = {
  concept:  "#6366f1",
  entity:   "#f59e0b",
  source:   "#10b981",
  overview: "#8b5cf6",
  other:    "#94a3b8",
};

const NODE_TYPE_LABEL: Record<string, string> = {
  concept:  "Concept",
  entity:   "Entity",
  source:   "Source",
  overview: "Overview",
  other:    "Other",
};

const TYPE_ORDER = ["concept", "entity", "source", "overview", "other"] as const;

function nodeRadius(degree: number): number {
  return Math.sqrt(degree + 1) * 4.5 + 4;
}

function resolveId(val: string | number | SimNode): string {
  return typeof val === "object" ? val.id : String(val);
}

export function KnowledgeGraphPanel({
  graph,
  selectedNodeId,
  onNodeClick,
  onClearSelection,
}: Props) {
  const svgRef       = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef      = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  // Persist node positions across simulation rebuilds so toggling a type
  // doesn't reset the layout of already-positioned nodes.
  const savedPositions = useRef<Map<string, { x: number; y: number }>>(new Map());

  const typeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of graph.nodes) m[n.type] = (m[n.type] ?? 0) + 1;
    return m;
  }, [graph.nodes]);

  const presentTypes = useMemo(() => new Set(Object.keys(typeCounts)), [typeCounts]);

  // Default: show only Concepts (fastest initial render).
  // Only "concept" is on; entity/source start hidden.
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(
    () => new Set(["concept"])
  );

  // When the graph data changes (new project), clear saved positions and
  // reset visibility back to concept-only.
  useEffect(() => {
    savedPositions.current.clear();
    setVisibleTypes(new Set(["concept"]));
  }, [graph]);

  // If the selected node's type gets hidden, clear the selection.
  useEffect(() => {
    if (!selectedNodeId) return;
    const node = graph.nodes.find(n => n.id === selectedNodeId);
    if (node && !visibleTypes.has(node.type)) onClearSelection();
  }, [visibleTypes, selectedNodeId, graph.nodes, onClearSelection]);

  // Stable callback refs so D3 closures stay fresh without rebuilding simulation.
  const onNodeClickRef = useRef(onNodeClick);
  const onClearRef     = useRef(onClearSelection);
  useEffect(() => { onNodeClickRef.current = onNodeClick; },     [onNodeClick]);
  useEffect(() => { onClearRef.current     = onClearSelection; }, [onClearSelection]);

  // Pre-build a nodeType lookup (id → type) for edge filtering.
  const nodeTypeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of graph.nodes) m.set(n.id, n.type);
    return m;
  }, [graph.nodes]);

  // ── Build simulation — reruns when graph OR visibleTypes changes ────────────
  // Only visible nodes enter the simulation → performance scales with visible set.
  useEffect(() => {
    if (!svgRef.current) return;

    const el     = svgRef.current;
    const width  = el.clientWidth  || containerRef.current?.clientWidth  || 420;
    const height = el.clientHeight || containerRef.current?.clientHeight || 600;

    const svg = d3.select<SVGSVGElement, unknown>(el);
    svg.selectAll("*").remove();

    // Filter to visible nodes only
    const visibleNodeData = graph.nodes.filter(n => visibleTypes.has(n.type));

    if (visibleNodeData.length === 0) return;

    // Build SimNode array, reusing saved positions where available
    const cx = width / 2, cy = height / 2;
    const nodes: SimNode[] = visibleNodeData.map(n => {
      const pos = savedPositions.current.get(n.id);
      return {
        id: n.id, title: n.title, type: n.type, filePath: n.filePath, degree: n.degree,
        x: pos?.x ?? cx + (Math.random() - 0.5) * 80,
        y: pos?.y ?? cy + (Math.random() - 0.5) * 80,
      };
    });
    const nodeById = new Map<string, SimNode>(nodes.map(n => [n.id, n]));

    // Only include edges where BOTH endpoints are in the visible set
    const links: SimLink[] = graph.edges
      .filter(e => {
        const s = e.source as string, t = e.target as string;
        return nodeById.has(s) && nodeById.has(t);
      })
      .map(e => ({
        source: nodeById.get(e.source as string)!,
        target: nodeById.get(e.target as string)!,
      }));

    // ── Zoom ────────────────────────────────────────────────────────────────
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 6])
      .on("zoom", (ev: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", ev.transform.toString());
      });
    svg.call(zoom);
    zoomRef.current = zoom;
    svg.on("click", () => onClearRef.current());

    const g = svg.append("g").attr("class", "graph-root");

    // ── Links ────────────────────────────────────────────────────────────────
    const linkSel = g.append("g").attr("class", "links")
      .selectAll<SVGLineElement, SimLink>("line")
      .data(links)
      .join("line")
      .attr("stroke", "#cbd5e1")
      .attr("stroke-width", 1.5)
      .attr("opacity", 0)   // fade in
      .transition().duration(400).attr("opacity", 0.55);

    const linkSelStatic = g.select<SVGGElement>(".links")
      .selectAll<SVGLineElement, SimLink>("line");

    // ── Drag ────────────────────────────────────────────────────────────────
    const drag = d3.drag<SVGGElement, SimNode>()
      .on("start", (ev: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!ev.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag",  (ev: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        d.fx = ev.x; d.fy = ev.y;
      })
      .on("end",   (ev: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!ev.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });

    // ── Nodes ────────────────────────────────────────────────────────────────
    const nodeSel = g.append("g").attr("class", "nodes")
      .selectAll<SVGGElement, SimNode>("g.node")
      .data(nodes, (d) => d.id)
      .join("g")
      .attr("class", "node")
      .attr("opacity", 0)   // fade in
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        onNodeClickRef.current(d);
      })
      .call(drag);

    nodeSel.transition().duration(400).attr("opacity", 1);

    nodeSel.append("circle")
      .attr("r",    (d) => nodeRadius(d.degree))
      .attr("fill", (d) => NODE_COLOR[d.type] ?? NODE_COLOR.other)
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);

    nodeSel.append("text")
      .attr("x", (d) => nodeRadius(d.degree) + 4)
      .attr("y", "0.35em")
      .style("font-size", "10px")
      .style("font-family", "system-ui, sans-serif")
      .style("fill", "#374151")
      .style("pointer-events", "none")
      .text((d) => d.title.length > 24 ? d.title.slice(0, 22) + "…" : d.title);

    // ── Simulation ───────────────────────────────────────────────────────────
    const sim = d3.forceSimulation<SimNode>(nodes)
      .force("link",    d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(85))
      .force("charge",  d3.forceManyBody<SimNode>().strength(-200))
      .force("center",  d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<SimNode>((d) => nodeRadius(d.degree) + 7));

    sim.on("tick", () => {
      linkSelStatic
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);
      nodeSel.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      sim.stop();
      // Save current positions so they survive the next rebuild
      for (const n of nodes) {
        if (n.x != null && n.y != null) {
          savedPositions.current.set(n.id, { x: n.x, y: n.y });
        }
      }
    };
  }, [graph, visibleTypes]); // Rebuild when either changes

  // ── Selection highlight (no simulation restart needed) ──────────────────────
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select<SVGSVGElement, unknown>(svgRef.current);

    if (!selectedNodeId) {
      svg.selectAll<SVGGElement,  SimNode>(".node").attr("opacity", 1);
      svg.selectAll<SVGLineElement, SimLink>("line")
        .attr("opacity", 0.55).attr("stroke-width", 1.5).attr("stroke", "#cbd5e1");
      return;
    }

    const neighbours = new Set<string>([selectedNodeId]);
    svg.selectAll<SVGLineElement, SimLink>("line").each((d) => {
      const s = resolveId(d.source as string | SimNode);
      const t = resolveId(d.target as string | SimNode);
      if (s === selectedNodeId) neighbours.add(t);
      if (t === selectedNodeId) neighbours.add(s);
    });

    svg.selectAll<SVGGElement, SimNode>(".node")
      .attr("opacity", (d) => neighbours.has(d.id) ? 1 : 0.12);

    svg.selectAll<SVGLineElement, SimLink>("line")
      .attr("opacity", (d) => {
        const s = resolveId(d.source as string | SimNode);
        const t = resolveId(d.target as string | SimNode);
        return (s === selectedNodeId || t === selectedNodeId) ? 0.9 : 0.04;
      })
      .attr("stroke-width", (d) => {
        const s = resolveId(d.source as string | SimNode);
        const t = resolveId(d.target as string | SimNode);
        return (s === selectedNodeId || t === selectedNodeId) ? 2.5 : 1;
      })
      .attr("stroke", (d) => {
        const s = resolveId(d.source as string | SimNode);
        const t = resolveId(d.target as string | SimNode);
        return (s === selectedNodeId || t === selectedNodeId) ? "#6366f1" : "#cbd5e1";
      });
  }, [selectedNodeId]);

  const handleResetZoom = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select<SVGSVGElement, unknown>(svgRef.current)
      .transition().duration(450)
      .call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);

  const toggleType = useCallback((type: string) => {
    setVisibleTypes(prev => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  }, []);

  const legendItems = TYPE_ORDER.filter(t => (typeCounts[t] ?? 0) > 0);

  // Visible node count (for toolbar)
  const visibleCount = useMemo(
    () => graph.nodes.filter(n => visibleTypes.has(n.type)).length,
    [graph.nodes, visibleTypes]
  );

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-gray-50 border-r border-border">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <Network className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">KB Graph</span>
          <span className="text-[10px] text-muted-foreground ml-1">
            {visibleCount} / {graph.nodes.length} nodes · {graph.edges.length} links
          </span>
        </div>
        <div className="flex items-center gap-1">
          {selectedNodeId && (
            <button
              onClick={onClearSelection}
              className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors"
              title="Clear selection (Escape)"
            >
              Clear
            </button>
          )}
          <button
            onClick={handleResetZoom}
            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent transition-colors"
            title="Reset zoom"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="flex-1 overflow-hidden relative">
        <svg ref={svgRef} className="w-full h-full" />
      </div>

      {/* Legend — toggle buttons */}
      <div className="px-3 py-2.5 border-t border-border bg-background flex-shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
          Node Types
        </p>
        <div className="flex flex-wrap gap-1.5">
          {legendItems.map(type => {
            const isOn  = visibleTypes.has(type);
            const color = NODE_COLOR[type];
            const count = typeCounts[type] ?? 0;
            const label = NODE_TYPE_LABEL[type] ?? type;
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                title={isOn ? `Hide ${label}s` : `Show ${label}s`}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-all select-none",
                  isOn
                    ? "text-foreground shadow-sm"
                    : "border-border bg-transparent text-muted-foreground opacity-40"
                )}
                style={isOn ? {
                  backgroundColor: color + "22",
                  borderColor: color + "88",
                } : {}}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: isOn ? color : "#9ca3af" }}
                />
                {label}
                <span className="text-[10px] font-normal opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
