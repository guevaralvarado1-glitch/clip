import React, { useRef, useState } from 'react';
import { Download, FolderOpen, Plus, Trash2, Upload } from 'lucide-react';
import { Project } from '../types/studio';
import { createDefaultProject, exportProjectBundle, importProjectBundle, uid } from '../lib/storage';
import { formatTimecode } from '../hooks/useBlobUrl';

interface ProjectsViewProps {
  projects: Project[];
  activeProjectId: string;
  onSelectProject: (project: Project) => void;
  onCreateProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onOpenStudio: () => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onOpenStudio,
}) => {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleNewBlank = () => {
    const base = createDefaultProject();
    const blank: Project = {
      ...base,
      id: uid('proj'),
      title: `Nuevo Proyecto ${projects.length + 1}`,
      description: 'Proyecto personalizado en blanco.',
      scenes: [
        {
          ...base.scenes[0],
          id: uid('scene'),
          title: '01. Introducción',
          narration: '',
          subtitleText: '',
          overlayCaption: '',
        },
      ],
      updatedAt: Date.now(),
    };
    onCreateProject(blank);
    onOpenStudio();
  };

  const handleExportJson = async (project: Project) => {
    try {
      setError(null);
      setBusyMessage(`Empaquetando "${project.title}"...`);
      const blob = await exportProjectBundle(project);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto';
      a.download = `${slug}.cinecraft.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo exportar el respaldo.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setError(null);
      setBusyMessage('Importando proyecto y medios locales...');
      const imported = await importProjectBundle(file);
      onCreateProject(imported);
      onOpenStudio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al importar el proyecto.');
    } finally {
      setBusyMessage(null);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#F1F3F6]">Proyectos Locales</h1>
          <p className="text-sm text-[#9CA3B2] mt-1">
            Guardados automáticamente en tu navegador (IndexedDB). Exporta respaldos para moverlos entre equipos.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <input
            ref={importInputRef}
            type="file"
            accept=".json,.cinecraft.json"
            onChange={handleImportJson}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-white/[0.12] bg-[#13161D] text-[#F1F3F6] hover:bg-[#1A1E27] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            Importar respaldo
          </button>
          <button
            type="button"
            onClick={handleNewBlank}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[#E5A93B] text-[#0B0D11] hover:bg-[#F0B84F] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Nuevo proyecto
          </button>
        </div>
      </div>

      {busyMessage && (
        <div className="px-4 py-3 rounded-lg bg-[#13161D] border border-white/[0.08] text-sm text-[#E5A93B]">
          {busyMessage}
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {projects.map((proj) => {
          const totalDuration = proj.scenes.reduce((acc, s) => acc + (s.durationSec || 0), 0);
          const isCurrent = proj.id === activeProjectId;
          return (
            <div
              key={proj.id}
              className={`p-5 rounded-xl border transition-colors ${
                isCurrent
                  ? 'bg-[#171B24] border-[#E5A93B]/60'
                  : 'bg-[#13161D] border-white/[0.08] hover:border-white/[0.18]'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-[#F1F3F6] truncate">{proj.title}</h2>
                  <p className="text-xs text-[#9CA3B2] mt-1 line-clamp-2">{proj.description}</p>
                </div>
                {isCurrent && (
                  <span className="text-xs font-medium text-[#E5A93B] shrink-0">Activo</span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-[#8C94A4] tabular-nums">
                <span>{proj.scenes.length} escenas</span>
                <span aria-hidden="true">·</span>
                <span>{formatTimecode(totalDuration)}</span>
                <span aria-hidden="true">·</span>
                <span>{proj.aspectRatio}</span>
                <span aria-hidden="true">·</span>
                <span>{proj.resolution}</span>
              </div>

              <div className="mt-5 pt-4 border-t border-white/[0.06] flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onSelectProject(proj);
                    onOpenStudio();
                  }}
                  className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-white/[0.08] text-[#F1F3F6] hover:bg-white/[0.14] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Abrir en estudio
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleExportJson(proj)}
                    title="Descargar respaldo .json"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-white/[0.08] text-[#C8CDD8] hover:text-white hover:bg-white/[0.05] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Respaldar
                  </button>
                  {projects.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDeleteProject(proj.id)}
                      title="Eliminar proyecto"
                      className="p-1.5 rounded-lg border border-white/[0.08] text-[#9CA3B2] hover:text-red-300 hover:border-red-500/30 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
