import React, { useRef, useState } from 'react';
import {
  Captions,
  Download,
  FileAudio,
  Loader2,
  Music,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import { Project, SubtitleCue, TransitionType } from '../types/studio';
import { saveMediaBlob, uid } from '../lib/storage';
import { apiFetch, safeJson } from '../lib/exportClient';
import { formatTimecode, useBlobUrl } from '../hooks/useBlobUrl';

interface AudioSubtitlesViewProps {
  project: Project;
  onUpdateProject: (updated: Project) => void;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function formatSrtTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export const AudioSubtitlesView: React.FC<AudioSubtitlesViewProps> = ({
  project,
  onUpdateProject,
}) => {
  const musicInputRef = useRef<HTMLInputElement>(null);
  const transcribeInputRef = useRef<HTMLInputElement>(null);
  const { url: musicUrl } = useBlobUrl(project.musicBlobId);

  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUploadMusic = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setError(null);
      const blobId = await saveMediaBlob(file);
      onUpdateProject({
        ...project,
        musicBlobId: blobId,
        musicFileName: file.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar música.');
    } finally {
      if (musicInputRef.current) musicInputRef.current.value = '';
    }
  };

  const handleBatchGenerateVoices = async () => {
    const pending = project.scenes.filter(
      (s) => !s.audioBlobId && (s.narration.trim().length > 0 || (s.isDialogue && s.dialogueLines.length > 0))
    );
    if (pending.length === 0) {
      setError('Todas las escenas con texto ya tienen voz generada.');
      return;
    }

    try {
      setError(null);
      let currentScenes = [...project.scenes];

      for (let i = 0; i < pending.length; i++) {
        const scene = pending[i];
        setBatchProgress(`Generando voz ${i + 1} de ${pending.length}: ${scene.title}`);

        const res = await apiFetch('/api/ai/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: scene.narration,
            voice: scene.voice,
            voiceStyle: scene.voiceStyle,
            language: project.language,
            isDialogue: scene.isDialogue,
            dialogueLines: scene.dialogueLines,
          }),
        });
        const data = await safeJson(res);
        if (!res.ok) {
          throw new Error(data.error || `Error en escena "${scene.title}"`);
        }

        const wavBlob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/wav');
        const audioBlobId = await saveMediaBlob(wavBlob);
        const audioDurationSec = Number(data.durationSec) || scene.durationSec;

        currentScenes = currentScenes.map((sc) =>
          sc.id === scene.id
            ? {
                ...sc,
                audioBlobId,
                audioDurationSec,
                durationSec: Math.max(sc.durationSec, Math.ceil(audioDurationSec + 0.5)),
              }
            : sc
        );
        onUpdateProject({ ...project, scenes: currentScenes });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error en generación por lotes.');
    } finally {
      setBatchProgress(null);
    }
  };

  const handleSyncSubtitlesFromScenes = () => {
    const transOverlap =
      project.transitionType === 'fade' ? Math.min(project.transitionDurationSec || 0.6, 1.2) : 0;
    let cursor = 0;
    const cues: SubtitleCue[] = [];

    for (let i = 0; i < project.scenes.length; i++) {
      const sc = project.scenes[i];
      const text = (sc.subtitleText || sc.narration || '').trim();
      const dur = Math.max(2, sc.durationSec || 5);
      if (text) {
        cues.push({
          id: uid('sub'),
          startSec: Number(cursor.toFixed(2)),
          endSec: Number((cursor + dur - 0.2).toFixed(2)),
          text,
        });
      }
      cursor += dur - (i < project.scenes.length - 1 ? transOverlap : 0);
    }

    onUpdateProject({ ...project, subtitles: cues });
  };

  const handleTranscribeFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setError(null);
      setTranscribing(true);
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch('/api/ai/transcribe', {
        method: 'POST',
        body: fd,
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Error al transcribir archivo.');

      const newCues: SubtitleCue[] = (data.cues || []).map(
        (c: { startSec: number; endSec: number; text: string }) => ({
          id: uid('sub'),
          startSec: Number(c.startSec) || 0,
          endSec: Number(c.endSec) || 2,
          text: c.text || '',
        })
      );

      onUpdateProject({
        ...project,
        subtitles: newCues,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error en transcripción.');
    } finally {
      setTranscribing(false);
      if (transcribeInputRef.current) transcribeInputRef.current.value = '';
    }
  };

  const handleDownloadSrt = () => {
    if (project.subtitles.length === 0) return;
    const srt = project.subtitles
      .map(
        (c, idx) =>
          `${idx + 1}\n${formatSrtTimestamp(c.startSec)} --> ${formatSrtTimestamp(c.endSec)}\n${c.text}\n`
      )
      .join('\n');
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'subtitulos'}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pendingVoiceCount = project.scenes.filter(
    (s) => !s.audioBlobId && (s.narration.trim().length > 0 || (s.isDialogue && s.dialogueLines.length > 0))
  ).length;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <div className="border-b border-white/[0.08] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-[#F1F3F6]">
          Estudio de Audio, Mezcla y Subtítulos
        </h1>
        <p className="text-sm text-[#9CA3B2] mt-1">
          Configura la música de fondo, genera las voces de todas las escenas en lote y administra los subtítulos del video final.
        </p>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Music & Mix Levels */}
        <section className="p-6 rounded-xl bg-[#13161D] border border-white/[0.08] space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <Music className="w-4 h-4 text-[#E5A93B]" />
              <h2 className="text-base font-semibold text-[#F1F3F6]">Música de Fondo y Mezcla</h2>
            </div>
            <input
              ref={musicInputRef}
              type="file"
              accept="audio/*"
              onChange={handleUploadMusic}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => musicInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-[#F1F3F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {project.musicBlobId ? 'Cambiar pista' : 'Subir música'}
            </button>
          </div>

          {musicUrl ? (
            <div className="p-3.5 rounded-lg bg-[#0B0D11] border border-white/[0.06] space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[#F1F3F6] truncate">
                  {project.musicFileName || 'Pista musical cargada'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateProject({ ...project, musicBlobId: undefined, musicFileName: undefined })
                  }
                  className="text-xs text-[#9CA3B2] hover:text-red-300 cursor-pointer"
                >
                  Quitar
                </button>
              </div>
              <audio controls src={musicUrl} className="w-full h-8" />
              <p className="text-[11px] text-[#8C94A4]">
                La pista se repetirá automáticamente en bucle hasta cubrir la duración total del video con entrada y salida suave.
              </p>
            </div>
          ) : (
            <div className="p-4 rounded-lg bg-[#0B0D11] border border-dashed border-white/[0.1] text-xs text-[#8C94A4]">
              Sin música de fondo. Sube un archivo MP3, WAV o M4A para añadir banda sonora continua.
            </div>
          )}

          <div className="space-y-4 pt-2">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#C8CDD8]">Volumen de Voces IA</span>
                <span className="font-mono tabular-nums text-[#E5A93B]">
                  {Math.round(project.voiceVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1.8}
                step={0.05}
                value={project.voiceVolume}
                onChange={(e) =>
                  onUpdateProject({ ...project, voiceVolume: Number(e.target.value) })
                }
                className="w-full accent-[#E5A93B]"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#C8CDD8]">Volumen de Música</span>
                <span className="font-mono tabular-nums text-[#E5A93B]">
                  {Math.round(project.musicVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1.0}
                step={0.02}
                value={project.musicVolume}
                onChange={(e) =>
                  onUpdateProject({ ...project, musicVolume: Number(e.target.value) })
                }
                className="w-full accent-[#E5A93B]"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#C8CDD8]">Audio original de clips subidos</span>
                <span className="font-mono tabular-nums text-[#E5A93B]">
                  {Math.round(project.clipAudioVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1.2}
                step={0.05}
                value={project.clipAudioVolume}
                onChange={(e) =>
                  onUpdateProject({ ...project, clipAudioVolume: Number(e.target.value) })
                }
                className="w-full accent-[#E5A93B]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/[0.06]">
              <div>
                <label className="block text-[11px] text-[#8C94A4] mb-1">Transición entre escenas</label>
                <select
                  value={project.transitionType}
                  onChange={(e) =>
                    onUpdateProject({
                      ...project,
                      transitionType: e.target.value as TransitionType,
                    })
                  }
                  className="w-full h-[34px] px-2.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6]"
                >
                  <option value="none">Corte directo</option>
                  <option value="fade">Fundido cruzado (Fade)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[#8C94A4] mb-1">Duración fundido (s)</label>
                <input
                  type="number"
                  min={0.2}
                  max={2.0}
                  step={0.1}
                  disabled={project.transitionType === 'none'}
                  value={project.transitionDurationSec}
                  onChange={(e) =>
                    onUpdateProject({
                      ...project,
                      transitionDurationSec: Math.max(0.2, Math.min(2, Number(e.target.value) || 0.6)),
                    })
                  }
                  className="w-full h-[34px] px-2.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6] tabular-nums disabled:opacity-40"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Batch TTS + Transcription */}
        <section className="p-6 rounded-xl bg-[#13161D] border border-white/[0.08] space-y-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Volume2 className="w-4 h-4 text-[#E5A93B]" />
              <h2 className="text-base font-semibold text-[#F1F3F6]">Locución Masiva (TTS)</h2>
            </div>
            <p className="text-xs text-[#9CA3B2]">
              Genera automáticamente la voz de todas las escenas que tienen narración o diálogo y aún no tienen audio ({pendingVoiceCount} pendientes).
            </p>
            <button
              type="button"
              disabled={Boolean(batchProgress) || pendingVoiceCount === 0}
              onClick={handleBatchGenerateVoices}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-sm font-semibold hover:bg-[#F0B84F] transition-colors cursor-pointer disabled:opacity-45"
            >
              {batchProgress ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {batchProgress}
                </>
              ) : (
                <>
                  <FileAudio className="w-4 h-4" />
                  Generar {pendingVoiceCount} voces pendientes
                </>
              )}
            </button>
          </div>

          <div className="pt-5 border-t border-white/[0.08] space-y-3">
            <div className="flex items-center gap-2.5">
              <Captions className="w-4 h-4 text-[#E5A93B]" />
              <h2 className="text-base font-semibold text-[#F1F3F6]">Transcripción y Subtítulos</h2>
            </div>
            <p className="text-xs text-[#9CA3B2]">
              Sincroniza subtítulos desde el guion de tus escenas o sube un video/audio para transcribirlo automáticamente con IA.
            </p>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleSyncSubtitlesFromScenes}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-[#F1F3F6] transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sincronizar desde guion
              </button>

              <input
                ref={transcribeInputRef}
                type="file"
                accept="audio/*,video/*"
                onChange={handleTranscribeFile}
                className="hidden"
              />
              <button
                type="button"
                disabled={transcribing}
                onClick={() => transcribeInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.12] hover:bg-white/[0.05] text-xs font-medium text-[#F1F3F6] transition-colors cursor-pointer disabled:opacity-50"
              >
                {transcribing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Transcribiendo...
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 h-3.5" />
                    Transcribir audio/video
                  </>
                )}
              </button>

              {project.subtitles.length > 0 && (
                <button
                  type="button"
                  onClick={handleDownloadSrt}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/[0.12] hover:bg-white/[0.05] text-xs font-medium text-[#E5A93B] transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar .SRT
                </button>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-[#C8CDD8] pt-1 cursor-pointer">
              <input
                type="checkbox"
                checked={project.burnSubtitles}
                onChange={(e) =>
                  onUpdateProject({ ...project, burnSubtitles: e.target.checked })
                }
                className="accent-[#E5A93B]"
              />
              Incrustar subtítulos visibles al exportar el archivo MP4 final
            </label>
          </div>
        </section>
      </div>

      {/* Subtitle Cues Table */}
      <section className="p-6 rounded-xl bg-[#13161D] border border-white/[0.08] space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-[#F1F3F6]">
            Líneas de Subtítulos ({project.subtitles.length})
          </h3>
          <button
            type="button"
            onClick={() => {
              const lastEnd =
                project.subtitles.length > 0
                  ? project.subtitles[project.subtitles.length - 1].endSec
                  : 0;
              onUpdateProject({
                ...project,
                subtitles: [
                  ...project.subtitles,
                  { id: uid('sub'), startSec: lastEnd, endSec: lastEnd + 4, text: '' },
                ],
              });
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-medium text-[#F1F3F6] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Añadir línea
          </button>
        </div>

        {project.subtitles.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#8C94A4]">
            No hay líneas de subtítulos todavía. Usa &quot;Sincronizar desde guion&quot; o transcribe un audio/video.
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {project.subtitles.map((cue, idx) => (
              <div
                key={cue.id}
                className="grid grid-cols-12 gap-2 items-center p-2 rounded-lg bg-[#0B0D11] border border-white/[0.06]"
              >
                <span className="col-span-1 text-[11px] font-mono tabular-nums text-[#8C94A4] text-center">
                  {idx + 1}
                </span>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={cue.startSec}
                  onChange={(e) => {
                    const val = Math.max(0, Number(e.target.value) || 0);
                    onUpdateProject({
                      ...project,
                      subtitles: project.subtitles.map((c) =>
                        c.id === cue.id ? { ...c, startSec: val } : c
                      ),
                    });
                  }}
                  title="Inicio (seg)"
                  className="col-span-2 px-2 py-1 rounded bg-[#13161D] border border-white/[0.08] text-xs font-mono tabular-nums text-[#F1F3F6]"
                />
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={cue.endSec}
                  onChange={(e) => {
                    const val = Math.max(0, Number(e.target.value) || 0);
                    onUpdateProject({
                      ...project,
                      subtitles: project.subtitles.map((c) =>
                        c.id === cue.id ? { ...c, endSec: val } : c
                      ),
                    });
                  }}
                  title="Fin (seg)"
                  className="col-span-2 px-2 py-1 rounded bg-[#13161D] border border-white/[0.08] text-xs font-mono tabular-nums text-[#F1F3F6]"
                />
                <input
                  type="text"
                  value={cue.text}
                  onChange={(e) =>
                    onUpdateProject({
                      ...project,
                      subtitles: project.subtitles.map((c) =>
                        c.id === cue.id ? { ...c, text: e.target.value } : c
                      ),
                    })
                  }
                  placeholder="Texto del subtítulo..."
                  className="col-span-6 px-2.5 py-1 rounded bg-[#13161D] border border-white/[0.08] text-xs text-[#F1F3F6]"
                />
                <div className="col-span-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateProject({
                        ...project,
                        subtitles: project.subtitles.filter((c) => c.id !== cue.id),
                      })
                    }
                    className="p-1 text-[#8C94A4] hover:text-red-300 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {project.subtitles.length > 0 && (
          <div className="text-[11px] text-[#8C94A4] tabular-nums">
            Cobertura: {formatTimecode(project.subtitles[0]?.startSec || 0)} –{' '}
            {formatTimecode(project.subtitles[project.subtitles.length - 1]?.endSec || 0)}
          </div>
        )}
      </section>
    </div>
  );
};
