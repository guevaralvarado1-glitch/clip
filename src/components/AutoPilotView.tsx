import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Clapperboard,
  Film,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  AspectRatio,
  CameraMotion,
  Character,
  ColorGrade,
  CreationMode,
  Project,
  Scene,
  SubtitleCue,
  TransitionType,
  VoiceName,
} from '../types/studio';
import { getMediaBlob, saveMediaBlob, uid } from '../lib/storage';
import { generateEditorialSlateImage, SlatePalette } from '../lib/canvasCards';
import { ScriptGeneratorView } from './ScriptGeneratorView';

interface AutoPilotViewProps {
  project: Project;
  onCreateProject: (project: Project) => void;
  onUpdateProject: (updated: Project) => void;
  onOpenStudio: () => void;
}

type StepStatus = 'pending' | 'running' | 'done' | 'skipped';

interface PipelineStep {
  id: string;
  label: string;
  detail: string;
  status: StepStatus;
}

const STARTER_IDEAS = [
  'Documental de 90 segundos sobre los misterios de las profundidades del océano, con tono fascinante y pausado.',
  'Video vertical para Reels de 45 segundos con 4 hábitos reales para recuperar la concentración cada mañana.',
  'Historia cinematográfica de 1 minuto sobre un antiguo faro que guía barcos durante una tormenta nocturna.',
];

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export const AutoPilotView: React.FC<AutoPilotViewProps> = ({
  project,
  onCreateProject,
  onUpdateProject,
  onOpenStudio,
}) => {
  const [subMode, setSubMode] = useState<'autopilot' | 'manual_script'>('autopilot');
  const [idea, setIdea] = useState('');
  const [language, setLanguage] = useState(project.language || 'es-ES');
  const [userFiles, setUserFiles] = useState<File[]>([]);
  const [includeMusic, setIncludeMusic] = useState(true);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [autoDownloadMp4, setAutoDownloadMp4] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>([]);

  const filesInputRef = useRef<HTMLInputElement>(null);

  const updateStep = (id: string, patch: Partial<PipelineStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const handleRunAutoPilot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim()) {
      setError('Escribe tu idea para que el director autónomo pueda producir el video.');
      return;
    }

    setError(null);
    setRunning(true);

    const initialSteps: PipelineStep[] = [
      {
        id: 'analyze',
        label: 'Analizar material propio',
        detail: userFiles.length > 0 ? `${userFiles.length} archivos por revisar` : 'Sin archivos propios',
        status: userFiles.length > 0 ? 'running' : 'skipped',
      },
      { id: 'plan', label: 'Planificar formato, elenco y guion', detail: 'En espera', status: 'pending' },
      { id: 'visuals', label: 'Conseguir fotos/videos por escena', detail: 'En espera', status: 'pending' },
      { id: 'voices', label: 'Generar voces IA y ajustar tiempos', detail: 'En espera', status: 'pending' },
      { id: 'music', label: 'Componer música y subtítulos', detail: 'En espera', status: 'pending' },
      {
        id: 'export',
        label: 'Ensamblar y descargar MP4 final',
        detail: autoDownloadMp4 ? 'En espera' : 'Omitido (solo abrir en estudio)',
        status: autoDownloadMp4 ? 'pending' : 'skipped',
      },
    ];
    setSteps(initialSteps);

    try {
      // 1. Analyze user media if provided
      let analyzedUserMedia: Array<{
        index: number;
        originalName: string;
        mediaType: 'image' | 'video';
        durationSec: number;
        description: string;
      }> = [];
      const userBlobIds: string[] = [];

      if (userFiles.length > 0) {
        updateStep('analyze', { status: 'running', detail: 'Guardando y analizando archivos...' });
        for (const f of userFiles) {
          userBlobIds.push(await saveMediaBlob(f));
        }
        const fd = new FormData();
        for (const f of userFiles) {
          fd.append('files', f);
        }
        const analyzeRes = await fetch('/api/ai/analyze-media', { method: 'POST', body: fd });
        const analyzeData = await analyzeRes.json();
        if (!analyzeRes.ok) throw new Error(analyzeData.error || 'Error analizando archivos.');
        analyzedUserMedia = analyzeData.items || [];
        updateStep('analyze', {
          status: 'done',
          detail: `${analyzedUserMedia.length} archivos clasificados`,
        });
      }

      // 2. Autonomous Plan
      updateStep('plan', { status: 'running', detail: 'Diseñando estructura narrativa...' });
      const planRes = await fetch('/api/ai/auto-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: idea.trim(),
          language,
          userMedia: analyzedUserMedia,
        }),
      });
      const plan = await planRes.json();
      if (!planRes.ok) throw new Error(plan.error || 'Error al planificar el video.');

      const validVoices: VoiceName[] = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Zephyr'];
      const validModes: CreationMode[] = ['story', 'documentary', 'commercial', 'music_video', 'image_sequence'];
      const validMotions: CameraMotion[] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'ken_burns', 'static'];
      const validGrades: ColorGrade[] = ['none', 'cinema_warm', 'noir', 'cool_film', 'vibrant'];

      const aspectRatio: AspectRatio = plan.aspectRatio === '9:16' ? '9:16' : '16:9';
      const mode: CreationMode = validModes.includes(plan.mode) ? plan.mode : 'documentary';
      const transitionType: TransitionType = plan.transitionType === 'none' ? 'none' : 'fade';

      const characters: Character[] = (plan.characters || []).map(
        (c: Partial<Character>, idx: number) => ({
          id: uid('char'),
          name: c.name || (idx === 0 ? 'Narrador' : `Personaje ${idx + 1}`),
          role: c.role || 'Narración',
          visualDescription: c.visualDescription || '',
          voice: validVoices.includes(c.voice as VoiceName) ? (c.voice as VoiceName) : 'Charon',
          voiceStyle: c.voiceStyle || 'Claro y cinematográfico',
        })
      );

      const rawScenes = Array.isArray(plan.scenes) ? plan.scenes : [];
      updateStep('plan', {
        status: 'done',
        detail: `${rawScenes.length} escenas · ${aspectRatio} · ${characters.length} voces`,
      });

      // 3. Gather Visuals per scene (User match -> Hybrid Stock Fetch -> Editorial Slate fallback)
      updateStep('visuals', {
        status: 'running',
        detail: `0 de ${rawScenes.length} escenas`,
      });

      const palettes: SlatePalette[] = ['charcoal', 'amber_dusk', 'ocean_noir', 'forest_mist'];
      const builtScenes: Scene[] = [];

      for (let i = 0; i < rawScenes.length; i++) {
        const rs = rawScenes[i];
        updateStep('visuals', {
          detail: `Escena ${i + 1} de ${rawScenes.length}: ${rs.title || ''}`,
        });

        let imageBlobId: string | undefined;
        let videoClipBlobId: string | undefined;
        let durationSec = Math.max(4, Math.min(20, Math.round(Number(rs.durationSec) || 7)));

        const matchedIdx = Number(rs.matchedMediaIndex);
        if (
          Number.isInteger(matchedIdx) &&
          matchedIdx >= 0 &&
          matchedIdx < userFiles.length &&
          userBlobIds[matchedIdx]
        ) {
          const meta = analyzedUserMedia[matchedIdx];
          if (meta?.mediaType === 'video') {
            videoClipBlobId = userBlobIds[matchedIdx];
            if (meta.durationSec > 1) durationSec = Math.max(3, Math.round(meta.durationSec));
          } else {
            imageBlobId = userBlobIds[matchedIdx];
          }
        } else {
          // Fetch hybrid stock media (Pexels if configured, else Wikimedia Commons)
          try {
            const stockRes = await fetch('/api/media/fetch-stock', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: rs.searchQuery || rs.title || idea.slice(0, 40),
                aspectRatio,
                preferVideo: true,
              }),
            });
            if (stockRes.ok) {
              const kind = stockRes.headers.get('X-Media-Kind');
              const blob = await stockRes.blob();
              const savedId = await saveMediaBlob(blob);
              if (kind === 'video') {
                videoClipBlobId = savedId;
              } else {
                imageBlobId = savedId;
              }
            }
          } catch {
            // Fall through to editorial slate card
          }
        }

        if (!imageBlobId && !videoClipBlobId) {
          const slateBlob = await generateEditorialSlateImage(
            rs.title || `Escena ${i + 1}`,
            rs.subtitleText || rs.visualDirection || '',
            palettes[i % palettes.length],
            aspectRatio
          );
          imageBlobId = await saveMediaBlob(slateBlob);
        }

        builtScenes.push({
          id: uid('scene'),
          title: rs.title || `Escena ${i + 1}`,
          visualDirection: rs.visualDirection || '',
          narration: rs.narration || '',
          isDialogue: false,
          dialogueLines: [],
          speakerName: rs.speakerName || characters[0]?.name || 'Narrador',
          voice: validVoices.includes(rs.voice as VoiceName)
            ? (rs.voice as VoiceName)
            : characters[0]?.voice || 'Charon',
          voiceStyle: rs.voiceStyle || 'Narrador claro y natural',
          durationSec,
          cameraMotion: validMotions.includes(rs.cameraMotion as CameraMotion)
            ? (rs.cameraMotion as CameraMotion)
            : 'ken_burns',
          colorGrade: validGrades.includes(rs.colorGrade as ColorGrade)
            ? (rs.colorGrade as ColorGrade)
            : 'cinema_warm',
          imageBlobId,
          videoClipBlobId,
          subtitleText: rs.subtitleText || rs.narration || '',
          overlayCaption: rs.overlayCaption || '',
        });
      }

      updateStep('visuals', {
        status: 'done',
        detail: `${builtScenes.length} visuales listos`,
      });

      // 4. Generate AI Voices for every scene
      updateStep('voices', {
        status: 'running',
        detail: `0 de ${builtScenes.length} locuciones`,
      });

      for (let i = 0; i < builtScenes.length; i++) {
        const sc = builtScenes[i];
        if (!sc.narration.trim()) continue;
        updateStep('voices', {
          detail: `Voz ${i + 1} de ${builtScenes.length}: ${sc.title}`,
        });
        const ttsRes = await fetch('/api/ai/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: sc.narration,
            voice: sc.voice,
            voiceStyle: sc.voiceStyle,
            language,
          }),
        });
        const ttsData = await ttsRes.json();
        if (!ttsRes.ok) throw new Error(ttsData.error || `Error generando voz en escena ${i + 1}`);

        const wavBlob = base64ToBlob(ttsData.audioBase64, ttsData.mimeType || 'audio/wav');
        const audioBlobId = await saveMediaBlob(wavBlob);
        const audioDur = Number(ttsData.durationSec) || sc.durationSec;
        sc.audioBlobId = audioBlobId;
        sc.audioDurationSec = audioDur;
        sc.durationSec = Math.max(sc.durationSec, Math.ceil(audioDur + 0.6));
      }

      updateStep('voices', {
        status: 'done',
        detail: 'Todas las locuciones generadas',
      });

      // 5. Generate Ambient Soundtrack + Sync Subtitles
      updateStep('music', { status: 'running', detail: 'Componiendo música y subtítulos...' });
      let musicBlobId: string | undefined;
      let musicFileName: string | undefined;

      if (includeMusic) {
        const musicRes = await fetch('/api/media/generate-music', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mood: plan.musicMood || 'warm_documentary',
            durationSec: 30,
          }),
        });
        if (musicRes.ok) {
          const musicBlob = await musicRes.blob();
          musicBlobId = await saveMediaBlob(musicBlob);
          musicFileName = `Banda Sonora (${plan.musicMood || 'ambiental'}).mp3`;
        }
      }

      const transOverlap = transitionType === 'fade' ? 0.6 : 0;
      let cursor = 0;
      const subtitles: SubtitleCue[] = [];
      for (let i = 0; i < builtScenes.length; i++) {
        const sc = builtScenes[i];
        const text = (sc.subtitleText || sc.narration || '').trim();
        if (text) {
          subtitles.push({
            id: uid('sub'),
            startSec: Number(cursor.toFixed(2)),
            endSec: Number((cursor + sc.durationSec - 0.2).toFixed(2)),
            text,
          });
        }
        cursor += sc.durationSec - (i < builtScenes.length - 1 ? transOverlap : 0);
      }

      const newProject: Project = {
        id: uid('proj'),
        title: plan.title || 'Producción Automática',
        description: plan.description || idea.trim(),
        mode,
        aspectRatio,
        resolution: '720p',
        visualStyle: plan.visualStyle || 'Cinematográfico',
        targetDurationSec: Math.round(cursor),
        transitionType,
        transitionDurationSec: 0.6,
        musicBlobId,
        musicFileName,
        musicVolume: 0.26,
        voiceVolume: 1.0,
        clipAudioVolume: 0.45,
        burnSubtitles,
        language,
        characters,
        scenes: builtScenes,
        subtitles,
        updatedAt: Date.now(),
      };

      onCreateProject(newProject);
      updateStep('music', {
        status: 'done',
        detail: `${subtitles.length} subtítulos${musicBlobId ? ' + música ambiental' : ''}`,
      });

      // 6. Auto-export single MP4 if checked
      if (autoDownloadMp4) {
        updateStep('export', {
          status: 'running',
          detail: 'Renderizando y mezclando MP4 en el servidor...',
        });

        const fd = new FormData();
        fd.append(
          'manifest',
          JSON.stringify({
            title: newProject.title,
            aspectRatio: newProject.aspectRatio,
            resolution: newProject.resolution,
            transitionType: newProject.transitionType,
            transitionDurationSec: newProject.transitionDurationSec,
            musicVolume: newProject.musicVolume,
            voiceVolume: newProject.voiceVolume,
            clipAudioVolume: newProject.clipAudioVolume,
            burnSubtitles: newProject.burnSubtitles,
            subtitles: newProject.subtitles,
            scenes: newProject.scenes.map((sc) => ({
              id: sc.id,
              title: sc.title,
              durationSec: sc.durationSec,
              cameraMotion: sc.cameraMotion,
              colorGrade: sc.colorGrade,
              subtitleText: sc.subtitleText,
              narration: sc.narration,
              overlayCaption: sc.overlayCaption,
            })),
          })
        );

        for (const sc of newProject.scenes) {
          if (sc.videoClipBlobId) {
            const b = await getMediaBlob(sc.videoClipBlobId);
            if (b) fd.append(`clip_${sc.id}`, b, `clip_${sc.id}.mp4`);
          } else if (sc.imageBlobId) {
            const b = await getMediaBlob(sc.imageBlobId);
            if (b) fd.append(`image_${sc.id}`, b, `image_${sc.id}.png`);
          }
          if (sc.audioBlobId) {
            const b = await getMediaBlob(sc.audioBlobId);
            if (b) fd.append(`audio_${sc.id}`, b, `audio_${sc.id}.wav`);
          }
        }
        if (newProject.musicBlobId) {
          const mb = await getMediaBlob(newProject.musicBlobId);
          if (mb) fd.append('music_track', mb, newProject.musicFileName || 'music.mp3');
        }

        const expRes = await fetch('/api/export/mp4', { method: 'POST', body: fd });
        if (!expRes.ok) {
          const errData = await expRes.json().catch(() => ({}));
          throw new Error(errData.error || 'Error exportando el MP4 final.');
        }

        const mp4Blob = await expRes.blob();
        const url = URL.createObjectURL(mp4Blob);
        const a = document.createElement('a');
        a.href = url;
        const slug =
          newProject.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'video-autopiloto';
        a.download = `${slug}.mp4`;
        a.click();
        URL.revokeObjectURL(url);

        updateStep('export', { status: 'done', detail: 'MP4 descargado' });
      }

      onOpenStudio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error durante la producción automática.');
    } finally {
      setRunning(false);
    }
  };

  if (subMode === 'manual_script') {
    return (
      <div>
        <div className="max-w-4xl mx-auto px-6 pt-6 flex justify-end">
          <div className="inline-flex p-1 rounded-lg bg-[#13161D] border border-white/[0.08]">
            <button
              type="button"
              onClick={() => setSubMode('autopilot')}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-[#9CA3B2] hover:text-white cursor-pointer"
            >
              Piloto Automático (1 Clic)
            </button>
            <button
              type="button"
              onClick={() => setSubMode('manual_script')}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#E5A93B] text-[#0B0D11] cursor-pointer"
            >
              Director Manual
            </button>
          </div>
        </div>
        <ScriptGeneratorView
          project={project}
          onUpdateProject={onUpdateProject}
          onOpenStudio={onOpenStudio}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#F1F3F6] text-balance">
            Director Autónomo en Piloto Automático
          </h1>
          <p className="text-sm text-[#9CA3B2] mt-1">
            Escribe tu idea y la aplicación decide formato, guion, elenco, visuales, locuciones, música y subtítulos para entregarte el video listo.
          </p>
        </div>

        <div className="inline-flex p-1 rounded-lg bg-[#13161D] border border-white/[0.08] shrink-0">
          <button
            type="button"
            onClick={() => setSubMode('autopilot')}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#E5A93B] text-[#0B0D11] whitespace-nowrap cursor-pointer"
          >
            Piloto Automático
          </button>
          <button
            type="button"
            onClick={() => setSubMode('manual_script')}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-[#9CA3B2] hover:text-white whitespace-nowrap cursor-pointer"
          >
            Director Manual
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-200">
          {error}
        </div>
      )}

      <form onSubmit={handleRunAutoPilot} className="space-y-6">
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[#C8CDD8]">
            ¿Qué video quieres crear?
          </label>
          <textarea
            rows={5}
            disabled={running}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Ejemplo: Quiero un documental de 2 minutos sobre cómo nacieron los primeros relojes mecánicos, con voz profunda, tono histórico y subtítulos..."
            className="w-full px-4 py-3 rounded-xl bg-[#13161D] border border-white/[0.1] text-sm text-[#F1F3F6] placeholder-[#6B7280] focus:outline-none focus:border-[#E5A93B] leading-relaxed disabled:opacity-60"
          />

          <div className="flex flex-wrap gap-2 pt-1">
            {STARTER_IDEAS.map((sample, idx) => (
              <button
                key={idx}
                type="button"
                disabled={running}
                onClick={() => setIdea(sample)}
                className="text-left text-[11px] px-3 py-1.5 rounded-lg bg-[#13161D] border border-white/[0.08] text-[#9CA3B2] hover:text-[#F1F3F6] hover:border-white/[0.18] transition-colors cursor-pointer"
              >
                {sample.slice(0, 56)}...
              </button>
            ))}
          </div>
        </div>

        {/* Optional User Media Upload (Unordered photos/videos) */}
        <div className="p-5 rounded-xl bg-[#13161D] border border-white/[0.08] space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-[#F1F3F6]">
                Material propio (opcional)
              </h2>
              <p className="text-xs text-[#8C94A4] mt-0.5">
                Si subes fotos o videos (aunque estén desordenados), la IA los analiza, los ordena y escribe la narración encima. Si no subes nada, busca visuales automáticos.
              </p>
            </div>
            <input
              ref={filesInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(e) => {
                const picked = Array.from(e.target.files || []);
                if (picked.length > 0) setUserFiles((prev) => [...prev, ...picked]);
                e.target.value = '';
              }}
              className="hidden"
            />
            <button
              type="button"
              disabled={running}
              onClick={() => filesInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-medium text-[#F1F3F6] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5 text-[#E5A93B]" />
              Añadir fotos o videos
            </button>
          </div>

          {userFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.06]">
              {userFiles.map((f, idx) => (
                <div
                  key={`${f.name}_${idx}`}
                  className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#0B0D11] border border-white/[0.08] text-xs text-[#C8CDD8]"
                >
                  <Film className="w-3 h-3 text-[#E5A93B]" />
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => setUserFiles((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-[#8C94A4] hover:text-red-300 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Preferences & Action */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-center p-4 rounded-xl bg-[#13161D] border border-white/[0.08]">
          <div>
            <label className="block text-[11px] text-[#8C94A4] mb-1">Idioma</label>
            <select
              value={language}
              disabled={running}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full h-9 px-2.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6]"
            >
              <option value="es-ES">Español</option>
              <option value="en-US">Inglés</option>
              <option value="pt-BR">Portugués</option>
            </select>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-[#C8CDD8] cursor-pointer">
            <input
              type="checkbox"
              disabled={running}
              checked={includeMusic}
              onChange={(e) => setIncludeMusic(e.target.checked)}
              className="accent-[#E5A93B]"
            />
            Música ambiental
          </label>

          <label className="inline-flex items-center gap-2 text-xs text-[#C8CDD8] cursor-pointer">
            <input
              type="checkbox"
              disabled={running}
              checked={burnSubtitles}
              onChange={(e) => setBurnSubtitles(e.target.checked)}
              className="accent-[#E5A93B]"
            />
            Subtítulos incluidos
          </label>

          <label className="inline-flex items-center gap-2 text-xs text-[#C8CDD8] cursor-pointer">
            <input
              type="checkbox"
              disabled={running}
              checked={autoDownloadMp4}
              onChange={(e) => setAutoDownloadMp4(e.target.checked)}
              className="accent-[#E5A93B]"
            />
            Descargar MP4 al terminar
          </label>
        </div>

        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            disabled={running}
            onClick={onOpenStudio}
            className="inline-flex items-center gap-2 text-xs text-[#9CA3B2] hover:text-white cursor-pointer"
          >
            <Clapperboard className="w-3.5 h-3.5" />
            Ir directo al Estudio actual
          </button>

          <button
            type="submit"
            disabled={running}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-sm font-semibold hover:bg-[#F0B84F] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Produciendo en piloto automático...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Producir Video Completo
              </>
            )}
          </button>
        </div>
      </form>

      {/* Live Pipeline Progress */}
      {steps.length > 0 && (
        <section className="p-5 rounded-xl bg-[#13161D] border border-white/[0.08] space-y-3">
          <h3 className="text-xs font-semibold text-[#F1F3F6]">Progreso de producción</h3>
          <div className="space-y-2.5">
            {steps.map((step) => (
              <div key={step.id} className="flex items-center justify-between gap-4 text-xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  {step.status === 'done' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  {step.status === 'running' && (
                    <Loader2 className="w-4 h-4 text-[#E5A93B] animate-spin shrink-0" />
                  )}
                  {(step.status === 'pending' || step.status === 'skipped') && (
                    <Circle className="w-4 h-4 text-[#4B5563] shrink-0" />
                  )}
                  <span
                    className={
                      step.status === 'skipped'
                        ? 'text-[#6B7280]'
                        : step.status === 'running'
                        ? 'text-[#F1F3F6] font-medium'
                        : 'text-[#C8CDD8]'
                    }
                  >
                    {step.label}
                  </span>
                </div>
                <span className="text-[11px] text-[#8C94A4] truncate">{step.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
