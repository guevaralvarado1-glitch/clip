import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Project } from './types/studio';
import {
  createDefaultProject,
  deleteProject,
  listProjects,
  saveProject,
} from './lib/storage';
import { exportProjectMp4 } from './lib/exportClient';
import { StudioWorkspace } from './components/StudioWorkspace';
import { AutoPilotView } from './components/AutoPilotView';
import { CharactersView } from './components/CharactersView';
import { AudioSubtitlesView } from './components/AudioSubtitlesView';
import { ProjectsView } from './components/ProjectsView';

type ActiveView = 'autopilot' | 'studio' | 'characters' | 'audio' | 'projects';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [activeView, setActiveView] = useState<ActiveView>('autopilot');
  const [booting, setBooting] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    listProjects()
      .then(async (existing) => {
        if (!mounted) return;
        if (existing.length > 0) {
          setProjects(existing);
          setActiveProjectId(existing[0].id);
        } else {
          const starter = createDefaultProject();
          await saveProject(starter);
          if (!mounted) return;
          setProjects([starter]);
          setActiveProjectId(starter.id);
        }
      })
      .finally(() => {
        if (mounted) setBooting(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const activeProject =
    projects.find((p) => p.id === activeProjectId) || projects[0] || null;

  const handleUpdateProject = (updated: Project) => {
    const stamped = { ...updated, updatedAt: Date.now() };
    setProjects((prev) => prev.map((p) => (p.id === stamped.id ? stamped : p)));
    saveProject(stamped).catch(() => {});
  };

  const handleCreateProject = (proj: Project) => {
    setProjects((prev) => [proj, ...prev]);
    setActiveProjectId(proj.id);
    saveProject(proj).catch(() => {});
  };

  const handleDeleteProject = async (projectId: string) => {
    await deleteProject(projectId);
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== projectId);
      if (activeProjectId === projectId && remaining[0]) {
        setActiveProjectId(remaining[0].id);
      }
      return remaining;
    });
  };

  const handleExportMp4 = async () => {
    if (!activeProject || exporting) return;
    try {
      setExportError(null);
      setExporting(true);
      setExportProgress('Iniciando...');
      await exportProjectMp4(activeProject, (msg) => setExportProgress(msg));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Error al exportar MP4.');
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  if (booting || !activeProject) {
    return (
      <div className="min-h-screen bg-[#0B0D11] text-[#F1F3F6] flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-[#9CA3B2]">
          <Loader2 className="w-4 h-4 animate-spin text-[#E5A93B]" />
          Cargando estudio local...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F1F3F6] flex flex-col">
      {/* Top Bar Contract: Brand — 5 clean nav links — 1 primary CTA */}
      <header className="h-[61px] shrink-0 px-6 border-b border-white/[0.08] bg-[#0B0D11] flex items-center justify-between gap-8">
        <button
          type="button"
          onClick={() => setActiveView('autopilot')}
          className="text-lg font-bold tracking-tight text-[#F1F3F6] whitespace-nowrap shrink-0 cursor-pointer"
        >
          CineCraft
        </button>

        <nav className="flex items-center gap-6 overflow-x-auto">
          {(
            [
              { id: 'autopilot', label: 'Piloto Automático' },
              { id: 'studio', label: 'Estudio' },
              { id: 'characters', label: 'Personajes' },
              { id: 'audio', label: 'Audio y Subtítulos' },
              { id: 'projects', label: 'Proyectos' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveView(item.id)}
              className={`py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeView === item.id
                  ? 'border-[#E5A93B] text-[#F1F3F6]'
                  : 'border-transparent text-[#8C94A4] hover:text-[#F1F3F6]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            disabled={exporting}
            onClick={handleExportMp4}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-xs font-semibold hover:bg-[#F0B84F] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            {exporting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span className="max-w-[190px] truncate">{exportProgress || 'Renderizando MP4...'}</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                Exportar MP4
              </>
            )}
          </button>
        </div>
      </header>

      {exportError && (
        <div className="px-6 py-2.5 bg-red-950/70 border-b border-red-500/30 text-xs text-red-200 flex items-center justify-between">
          <span>Error de exportación: {exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="underline hover:text-white cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-y-auto">
        {activeView === 'autopilot' && (
          <AutoPilotView
            project={activeProject}
            onCreateProject={handleCreateProject}
            onUpdateProject={handleUpdateProject}
            onOpenStudio={() => setActiveView('studio')}
          />
        )}
        {activeView === 'studio' && (
          <StudioWorkspace
            key={activeProject.id}
            project={activeProject}
            onUpdateProject={handleUpdateProject}
            onGoToScript={() => setActiveView('autopilot')}
          />
        )}
        {activeView === 'characters' && (
          <CharactersView project={activeProject} onUpdateProject={handleUpdateProject} />
        )}
        {activeView === 'audio' && (
          <AudioSubtitlesView project={activeProject} onUpdateProject={handleUpdateProject} />
        )}
        {activeView === 'projects' && (
          <ProjectsView
            projects={projects}
            activeProjectId={activeProject.id}
            onSelectProject={(proj) => setActiveProjectId(proj.id)}
            onCreateProject={handleCreateProject}
            onDeleteProject={handleDeleteProject}
            onOpenStudio={() => setActiveView('studio')}
          />
        )}
      </main>
    </div>
  );
}
