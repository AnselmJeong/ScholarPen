import React, { useEffect, useState } from "react";
import { rpc } from "../../rpc";
import type { ProjectInfo } from "../../../shared/rpc-types";

interface ProjectSidebarProps {
  activeProject: ProjectInfo | null;
  onProjectChange: (project: ProjectInfo) => void;
}

export function ProjectSidebar({ activeProject, onProjectChange }: ProjectSidebarProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    rpc.listProjects().then(setProjects).catch(console.error);
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const project = await rpc.createProject(newName.trim());
      setProjects((prev) => [project, ...prev]);
      onProjectChange(project);
      setNewName("");
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="w-52 flex-shrink-0 bg-gray-100 border-r border-gray-200 flex flex-col h-full">
      <div className="px-3 py-3 border-b border-gray-200">
        <h1 className="text-sm font-semibold text-gray-700 tracking-wide">ScholarPen</h1>
      </div>

      {/* New project input */}
      <div className="px-2 py-2 border-b border-gray-200">
        <div className="flex gap-1">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="New project..."
            className="flex-1 text-xs px-2 py-1 rounded border border-gray-300 bg-white focus:outline-none focus:border-blue-400"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
          >
            +
          </button>
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto py-1">
        {projects.length === 0 ? (
          <p className="text-xs text-gray-400 px-3 py-2">No projects yet</p>
        ) : (
          projects.map((p) => (
            <button
              key={p.path}
              onClick={() => onProjectChange(p)}
              className={`w-full text-left px-3 py-1.5 text-xs truncate hover:bg-gray-200 transition-colors ${
                activeProject?.path === p.path
                  ? "bg-blue-50 text-blue-700 font-medium"
                  : "text-gray-700"
              }`}
            >
              📄 {p.name}
            </button>
          ))
        )}
      </div>

      {/* Section tabs */}
      <div className="border-t border-gray-200 px-2 py-2 flex flex-col gap-1">
        {["Docs", "References", "Knowledge Base"].map((label) => (
          <button
            key={label}
            className="text-xs text-left px-2 py-1 rounded text-gray-500 hover:bg-gray-200 transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
