import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Brain,
  User,
  FileText,
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { rpc } from "../../rpc";
import type { KBGraph, KBGraphNode } from "@shared/rpc-types";

interface KnowledgeTreeProps {
  projectPath: string | null;
  activeFilePath?: string;
  onFileSelect: (filePath: string, title: string) => void;
}

const TYPE_ORDER = ["concept", "entity", "source", "other"] as const;

const TYPE_LABEL: Record<string, string> = {
  concept:  "Concepts",
  entity:   "Entities",
  source:   "Sources",
  overview: "Overview",
  other:    "Other",
};

function NodeIcon({ type }: { type: string }) {
  switch (type) {
    case "concept":  return <Brain    className="h-3 w-3 text-indigo-500 flex-shrink-0" />;
    case "entity":   return <User     className="h-3 w-3 text-amber-500  flex-shrink-0" />;
    case "source":   return <FileText className="h-3 w-3 text-emerald-500 flex-shrink-0" />;
    default:         return <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />;
  }
}

export function KnowledgeTree({
  projectPath,
  activeFilePath,
  onFileSelect,
}: KnowledgeTreeProps) {
  const [graph, setGraph]           = useState<KBGraph | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsed, setCollapsed]   = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!projectPath) { setGraph(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);

    rpc.getKBGraph(projectPath)
      .then(g  => { if (!cancelled) { setGraph(g);    setLoading(false); } })
      .catch(() => { if (!cancelled) { setError("Failed to load Knowledge Base"); setLoading(false); } });

    return () => { cancelled = true; };
  }, [projectPath]);

  // Group + sort nodes by type
  const grouped = useMemo<Record<string, KBGraphNode[]>>(() => {
    if (!graph) return {};
    const acc: Record<string, KBGraphNode[]> = {};
    for (const n of graph.nodes) {
      (acc[n.type] ??= []).push(n);
    }
    for (const arr of Object.values(acc)) arr.sort((a, b) => a.title.localeCompare(b.title));
    return acc;
  }, [graph]);

  // Apply search filter
  const filtered = useMemo<Record<string, KBGraphNode[]>>(() => {
    if (!searchQuery.trim()) return grouped;
    const q = searchQuery.toLowerCase();
    const acc: Record<string, KBGraphNode[]> = {};
    for (const [type, nodes] of Object.entries(grouped)) {
      const hits = nodes.filter(n => n.title.toLowerCase().includes(q) || n.id.includes(q));
      if (hits.length) acc[type] = hits;
    }
    return acc;
  }, [grouped, searchQuery]);

  const toggleSection = useCallback((type: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  }, []);

  // ── Empty / loading states ─────────────────────────────────────────────────

  if (!projectPath) return (
    <div className="flex-1 flex items-center justify-center p-4">
      <p className="text-xs text-muted-foreground text-center">Open a project to browse the Knowledge Base</p>
    </div>
  );

  if (loading) return (
    <div className="flex-1 flex items-center justify-center p-4">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  );

  if (error) return (
    <div className="flex-1 flex items-center justify-center p-4 text-center">
      <div className="flex flex-col items-center gap-1">
        <AlertCircle className="h-4 w-4 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
    </div>
  );

  if (!graph || graph.nodes.length === 0) return (
    <div className="flex-1 flex items-center justify-center p-4">
      <p className="text-xs text-muted-foreground text-center">
        No Knowledge Base found for this project
      </p>
    </div>
  );

  // ── Tree ───────────────────────────────────────────────────────────────────

  const visibleTypes = TYPE_ORDER.filter(t => (filtered[t]?.length ?? 0) > 0);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search */}
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            placeholder="Search knowledge..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-6 h-6 text-xs"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 px-1">
        <div className="py-1">
          {visibleTypes.map(type => {
            const nodes    = filtered[type] ?? [];
            const isOpen   = !collapsed.has(type);
            return (
              <div key={type}>
                {/* Section header */}
                <button
                  onClick={() => toggleSection(type)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isOpen
                    ? <ChevronDown  className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
                  <span>{TYPE_LABEL[type] ?? type}</span>
                  <span className="ml-auto text-[9px] font-normal bg-muted text-muted-foreground rounded px-1">
                    {nodes.length}
                  </span>
                </button>

                {/* Items */}
                {isOpen && nodes.map(node => (
                  <button
                    key={node.id}
                    onClick={() => onFileSelect(node.filePath, node.title)}
                    title={node.title}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-xs transition-colors",
                      activeFilePath === node.filePath
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-foreground hover:bg-sidebar-accent/60"
                    )}
                    style={{ paddingLeft: "20px" }}
                  >
                    <NodeIcon type={type} />
                    <span className="truncate">{node.title}</span>
                  </button>
                ))}
              </div>
            );
          })}

          {visibleTypes.length === 0 && searchQuery && (
            <p className="text-xs text-muted-foreground text-center py-4">No results</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
