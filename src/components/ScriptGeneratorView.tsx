import React, { useRef, useState } from 'react';
import { Clapperboard, ImagePlus, Loader2, Sparkles } from 'lucide-react';
import {
  AspectRatio,
  CameraMotion,
  ColorGrade,
  CreationMode,
  Project,
  Resolution,
  Scene,
} from '../types/studio';
import { saveMediaBlob, uid } from '../lib/storage';
import { safeJson } from '../lib/exportClient';

interface ScriptGeneratorViewProps {
  project: Project;
  onUpdateProject: (updated: Project) => void;
  onOpenStudio: () => void;
}

const MODES: Array<{ id: CreationMode; label: string; hint: string }> = [
  { id: 'story', label: 'Historia / Corto', hint: 'Arco narrativo con inicio, desarrollo y cierre.' },
  { id: 'documentary', label: 'Documental', hint: 'Ritmo informativo con narración descriptiva.' },
  { id: 'commercial', label: 'Comercial', hint: 'Enfoque dinámico de producto o marca.' },
  { id: 'music_video', label: 'Videoclip / Poético', hint: 'Escenas rítmicas pensadas para música.' },
  { id: 'image_sequence', label: 'Secuencia Visual', hint: 'Tomas pausadas para animar tus fotos.' },
];

const DURATIONS = [
  { sec: 30, label: '30 seg' },
  { sec: 60, label: '1 min' },
  { sec: 120, label: '2 min' },
  { sec: 180, label: '3 min' },
  { sec: 300, label: '5 min' },
];

export const ScriptGeneratorView: React.FC<ScriptGeneratorViewProps> = ({
  project,
  onUpdateProject,
  onOpenStudio,
}) => {
  const [topicOrScript, setTopicOrScript] = useState('');
  const [mode, setMode] = useState<CreationMode>(project.mode);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(project.aspectRatio);
  const [resolution, setResolution] = useState<Resolution>(project.resolution);
  const [targetDurationSec, setTargetDurationSec] = useState<number>(project.targetDurationSec || 60);
  const [visualStyle, setVisualStyle] = useState(project.visualStyle);
  const [language, setLanguage] = useState(project.language || 'es-ES');
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const batchImagesRef = useRef<HTMLInputElement>(null);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicOrScript.trim()) {
      setError('Escribe una idea, tema o pega tu guion para construir las escenas.');
      return;
    }

    try {
      setError(null);
      setLoading(true);
      const res = await fetch('/api/ai/storyboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicOrScript,
          mode,
          targetDurationSec,
          aspectRatio,
          visualStyle,
          characters: project.characters,
          language,
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        throw new Error(data.error || 'Error al generar el storyboard.');
      }

      const generatedScenes: Scene[] = (data.scenes || []).map(
        (raw: {
          title?: string;
          visualDirection?: string;
          narration?: string;
          speakerName?: string;
          voiceStyle?: string;
          durationSec?: number;
          cameraMotion?: string;
          colorGrade?: string;
          subtitleText?: string;
        }, idx: number) => {
          const matchedChar = project.characters.find(
            (c) => c.name.toLowerCase() === String(raw.speakerName || '').toLowerCase()
          );
          const validMotions: CameraMotion[] = [
            'zoom_in',
            'zoom_out',
            'pan_left',
            'pan_right',
            'ken_burns',
            'static',
          ];
          const validGrades: ColorGrade[] = ['none', 'cinema_warm', 'noir', 'cool_film', 'vibrant'];
          const motion = validMotions.includes(raw.cameraMotion as CameraMotion)
            ? (raw.cameraMotion as CameraMotion)
            : 'ken_burns';
          const grade = validGrades.includes(raw.colorGrade as ColorGrade)
            ? (raw.colorGrade as ColorGrade)
            : 'cinema_warm';

          return {
            id: uid('scene'),
            title: raw.title || `Escena ${idx + 1}`,
            visualDirection: raw.visualDirection || '',
            narration: raw.narration || '',
            isDialogue: false,
            dialogueLines: [],
            speakerName: matchedChar?.name || raw.speakerName || 'Narrador',
            voice: matchedChar?.voice || 'Charon',
            voiceStyle: raw.voiceStyle || matchedChar?.voiceStyle || 'Narrador claro y expresivo',
            durationSec: Math.max(3, Math.min(25, Math.round(Number(raw.durationSec) || 8))),
            cameraMotion: motion,
            colorGrade: grade,
            subtitleText: raw.subtitleText || raw.narration || '',
            overlayCaption: '',
          };
        }
      );

      onUpdateProject({
        ...project,
        title: data.title || project.title,
        description: data.summary || project.description,
        mode,
        aspectRatio,
        resolution,
        visualStyle,
        targetDurationSec,
        language,
        scenes: replaceExisting ? generatedScenes : [...project.scenes, ...generatedScenes],
      });
      onOpenStudio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    try {
      setError(null);
      setLoading(true);
      const motions: CameraMotion[] = ['ken_burns', 'zoom_in', 'pan_right', 'zoom_out', 'pan_left'];
      const newScenes: Scene[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const blobId = await saveMediaBlob(file);
        newScenes.push({
          id: uid('scene'),
          title: file.name.replace(/\.[^.]+$/, '') || `Escena ${i + 1}`,
          visualDirection: `Animación de imagen: ${file.name}`,
          narration: '',
          isDialogue: false,
          dialogueLines: [],
          speakerName: 'Narrador',
          voice: 'Charon',
          voiceStyle: 'Narrador documental sereno',
          durationSec: 6,
          cameraMotion: motions[i % motions.length],
          colorGrade: 'none',
          imageBlobId: blobId,
          subtitleText: '',
        });
      }

      onUpdateProject({
        ...project,
        aspectRatio,
        resolution,
        scenes: replaceExisting ? newScenes : [...project.scenes, ...newScenes],
      });
      onOpenStudio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al importar imágenes.');
    } finally {
      setLoading(false);
      if (batchImagesRef.current) batchImagesRef.current.value = '';
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div className="border-b border-white/[0.08] pb-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#F1F3F6]">
            Director y Guionista con IA
          </h1>
          <p className="text-sm text-[#9CA3B2] mt-1">
            Describe una idea o pega un guion largo. La IA lo estructura en escenas listas para locutar, animar y exportar.
          </p>
        </div>
        <div className="shrink-0">
          <input
            ref={batchImagesRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleBatchImages}
            className="hidden"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => batchImagesRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-white/[0.12] bg-[#13161D] text-[#F1F3F6] hover:bg-[#1A1E27] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <ImagePlus className="w-4 h-4 text-[#E5A93B]" />
            Importar lote de fotos
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-200">
          {error}
        </div>
      )}

      <form onSubmit={handleGenerate} className="space-y-6">
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[#C8CDD8]">Formato de creación</label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                  mode === m.id
                    ? 'bg-[#1D222E] border-[#E5A93B] text-[#F1F3F6]'
                    : 'bg-[#13161D] border-white/[0.08] text-[#9CA3B2] hover:border-white/[0.18]'
                }`}
              >
                <div className="text-xs font-semibold truncate">{m.label}</div>
                <div className="text-[11px] text-[#8C94A4] mt-1 line-clamp-2">{m.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#C8CDD8] mb-1.5">Relación de aspecto</label>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#13161D] border border-white/[0.08]">
              {(['16:9', '9:16'] as AspectRatio[]).map((ar) => (
                <button
                  key={ar}
                  type="button"
                  onClick={() => setAspectRatio(ar)}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    aspectRatio === ar ? 'bg-[#E5A93B] text-[#0B0D11]' : 'text-[#9CA3B2] hover:text-white'
                  }`}
                >
                  {ar === '16:9' ? '16:9 Cine' : '9:16 Vertical'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#C8CDD8] mb-1.5">Resolución</label>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#13161D] border border-white/[0.08]">
              {(['720p', '1080p'] as Resolution[]).map((res) => (
                <button
                  key={res}
                  type="button"
                  onClick={() => setResolution(res)}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    resolution === res ? 'bg-white/[0.14] text-white' : 'text-[#9CA3B2] hover:text-white'
                  }`}
                >
                  {res}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#C8CDD8] mb-1.5">Idioma del guion</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full h-[38px] px-3 rounded-lg bg-[#13161D] border border-white/[0.08] text-sm text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B]"
            >
              <option value="es-ES">Español</option>
              <option value="en-US">Inglés</option>
              <option value="pt-BR">Portugués</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#C8CDD8] mb-1.5">
              Duración objetivo ({targetDurationSec}s)
            </label>
            <select
              value={targetDurationSec}
              onChange={(e) => setTargetDurationSec(Number(e.target.value))}
              className="w-full h-[38px] px-3 rounded-lg bg-[#13161D] border border-white/[0.08] text-sm text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B] tabular-nums"
            >
              {DURATIONS.map((d) => (
                <option key={d.sec} value={d.sec}>
                  {d.label} ({d.sec}s)
                </option>
              ))}
              <option value={480}>8 min (480s)</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#C8CDD8] mb-1.5">Estilo visual y tono</label>
          <input
            type="text"
            value={visualStyle}
            onChange={(e) => setVisualStyle(e.target.value)}
            placeholder="Ej. Documental nostálgico con iluminación cálida y planos lentos"
            className="w-full px-3.5 py-2.5 rounded-lg bg-[#13161D] border border-white/[0.08] text-sm text-[#F1F3F6] placeholder-[#6B7280] focus:outline-none focus:border-[#E5A93B]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#C8CDD8] mb-1.5">
            Idea, tema o guion completo
          </label>
          <textarea
            rows={6}
            value={topicOrScript}
            onChange={(e) => setTopicOrScript(e.target.value)}
            placeholder="Ejemplo: Un mini documental de 2 minutos sobre cómo la arquitectura de las ciudades antiguas inspiró el diseño moderno, narrado con un tono poético..."
            className="w-full px-3.5 py-3 rounded-lg bg-[#13161D] border border-white/[0.08] text-sm text-[#F1F3F6] placeholder-[#6B7280] focus:outline-none focus:border-[#E5A93B] leading-relaxed"
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
          <label className="inline-flex items-center gap-2 text-xs text-[#9CA3B2] cursor-pointer">
            <input
              type="checkbox"
              checked={replaceExisting}
              onChange={(e) => setReplaceExisting(e.target.checked)}
              className="rounded border-white/20 bg-[#13161D] accent-[#E5A93B]"
            />
            Reemplazar escenas actuales (si desmarcas, se añaden al final del video)
          </label>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-[#E5A93B] text-[#0B0D11] hover:bg-[#F0B84F] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Estructurando escenas...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generar Storyboard
              </>
            )}
          </button>
        </div>
      </form>

      <div className="pt-4 border-t border-white/[0.06] flex items-center justify-between text-xs text-[#8C94A4]">
        <span>Personajes activos en Biblia: {project.characters.length}</span>
        <button
          type="button"
          onClick={onOpenStudio}
          className="inline-flex items-center gap-1.5 text-[#E5A93B] hover:underline cursor-pointer"
        >
          <Clapperboard className="w-3.5 h-3.5" />
          Volver al Estudio
        </button>
      </div>
    </div>
  );
};
