import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Film,
  Image as ImageIcon,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Plus,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  AspectRatio,
  CameraMotion,
  ColorGrade,
  DialogueLine,
  Project,
  Resolution,
  Scene,
  VoiceName,
} from '../types/studio';
import { createEmptyScene, saveMediaBlob, uid } from '../lib/storage';
import { generateEditorialSlateImage, SlatePalette } from '../lib/canvasCards';
import { safeErrorMessage, safeJson } from '../lib/exportClient';
import { formatTimecode, useBlobUrl } from '../hooks/useBlobUrl';

interface StudioWorkspaceProps {
  project: Project;
  onUpdateProject: (updated: Project) => void;
  onGoToScript: () => void;
}

type InspectorTab = 'image_to_video' | 'video_to_video' | 'script_voice' | 'extend_ai';

const MOTIONS: Array<{ id: CameraMotion; label: string }> = [
  { id: 'ken_burns', label: 'Ken Burns dinámico' },
  { id: 'zoom_in', label: 'Zoom suave adentro' },
  { id: 'zoom_out', label: 'Zoom suave afuera' },
  { id: 'pan_left', label: 'Paneo izquierda' },
  { id: 'pan_right', label: 'Paneo derecha' },
  { id: 'static', label: 'Estático' },
];

const GRADES: Array<{ id: ColorGrade; label: string; cssFilter: string }> = [
  { id: 'none', label: 'Natural', cssFilter: 'none' },
  { id: 'cinema_warm', label: 'Cine cálido', cssFilter: 'contrast(1.08) saturate(1.12) sepia(0.14)' },
  { id: 'noir', label: 'Noir Blanco y Negro', cssFilter: 'grayscale(1) contrast(1.22)' },
  { id: 'cool_film', label: 'Fílmico frío', cssFilter: 'contrast(1.06) saturate(0.9) hue-rotate(10deg)' },
  { id: 'vibrant', label: 'Vibrante', cssFilter: 'contrast(1.1) saturate(1.32)' },
];

const VOICES: VoiceName[] = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Zephyr'];

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export const StudioWorkspace: React.FC<StudioWorkspaceProps> = ({
  project,
  onUpdateProject,
  onGoToScript,
}) => {
  const [selectedSceneId, setSelectedSceneId] = useState<string>(project.scenes[0]?.id || '');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('image_to_video');

  // Playback state across entire timeline
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);

  // Action states
  const [renderingClip, setRenderingClip] = useState(false);
  const [processingVideo, setProcessingVideo] = useState(false);
  const [generatingVoice, setGeneratingVoice] = useState(false);
  const [refiningScene, setRefiningScene] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [slatePalette, setSlatePalette] = useState<SlatePalette>('charcoal');
  const [videoTrimStart, setVideoTrimStart] = useState(0);
  const [videoTrimEnd, setVideoTrimEnd] = useState(0);
  const [videoSpeed, setVideoSpeed] = useState(1);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startImgInputRef = useRef<HTMLInputElement>(null);
  const endImgInputRef = useRef<HTMLInputElement>(null);
  const videoUploadInputRef = useRef<HTMLInputElement>(null);
  const batchImagesInputRef = useRef<HTMLInputElement>(null);

  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement>(null);
  const musicAudioRef = useRef<HTMLAudioElement>(null);

  // Ensure valid selected scene when project changes
  const selectedIndex = Math.max(
    0,
    project.scenes.findIndex((s) => s.id === selectedSceneId)
  );
  const selectedScene = project.scenes[selectedIndex] || project.scenes[0];

  useEffect(() => {
    if (selectedScene && selectedScene.id !== selectedSceneId) {
      setSelectedSceneId(selectedScene.id);
    }
  }, [selectedScene, selectedSceneId]);

  // Compute timeline spans
  const sceneSpans = useMemo(() => {
    let cursor = 0;
    return project.scenes.map((sc) => {
      const dur = Math.max(2, sc.durationSec || 5);
      const start = cursor;
      cursor += dur;
      return { id: sc.id, start, end: cursor, duration: dur, scene: sc };
    });
  }, [project.scenes]);

  const totalDuration = sceneSpans.length > 0 ? sceneSpans[sceneSpans.length - 1].end : 0;

  // Determine which scene is active at current playhead (when playing full sequence)
  const playheadSpan = useMemo(() => {
    return (
      sceneSpans.find((sp) => playheadSec >= sp.start && playheadSec < sp.end) ||
      sceneSpans[sceneSpans.length - 1]
    );
  }, [sceneSpans, playheadSec]);

  const previewScene = isPlaying && playheadSpan ? playheadSpan.scene : selectedScene;

  const { url: previewVideoUrl } = useBlobUrl(previewScene?.videoClipBlobId);
  const { url: previewImageUrl, blob: previewImageBlob } = useBlobUrl(previewScene?.imageBlobId);
  const { url: endImageUrl, blob: endImageBlob } = useBlobUrl(selectedScene?.endImageBlobId);
  const { url: selectedClipUrl, blob: selectedClipBlob } = useBlobUrl(selectedScene?.videoClipBlobId);
  const { url: previewVoiceUrl } = useBlobUrl(previewScene?.audioBlobId);
  const { url: selectedVoiceUrl } = useBlobUrl(selectedScene?.audioBlobId);
  const { url: musicUrl } = useBlobUrl(project.musicBlobId);

  // Global playhead timer
  useEffect(() => {
    if (!isPlaying) return;
    const interval = window.setInterval(() => {
      setPlayheadSec((prev) => {
        const next = prev + 0.1;
        if (next >= totalDuration) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [isPlaying, totalDuration]);

  // Sync audio & video elements when active preview scene switches during playback
  const activePreviewId = previewScene?.id;
  useEffect(() => {
    if (!isPlaying) {
      videoPlayerRef.current?.pause();
      voiceAudioRef.current?.pause();
      musicAudioRef.current?.pause();
      return;
    }

    if (videoPlayerRef.current && previewVideoUrl) {
      videoPlayerRef.current.currentTime = 0;
      videoPlayerRef.current.volume = previewScene?.originalVideoMuted
        ? 0
        : Math.min(1, project.clipAudioVolume);
      videoPlayerRef.current.play().catch(() => {});
    }

    if (voiceAudioRef.current && previewVoiceUrl) {
      voiceAudioRef.current.currentTime = 0;
      voiceAudioRef.current.volume = Math.min(1, project.voiceVolume);
      voiceAudioRef.current.play().catch(() => {});
    }
  }, [isPlaying, activePreviewId, previewVideoUrl, previewVoiceUrl, previewScene?.originalVideoMuted, project.clipAudioVolume, project.voiceVolume]);

  // Keep music synced while playing
  useEffect(() => {
    const musicEl = musicAudioRef.current;
    if (!musicEl || !musicUrl) return;
    musicEl.volume = Math.min(1, project.musicVolume);
    if (isPlaying) {
      musicEl.play().catch(() => {});
    } else {
      musicEl.pause();
    }
  }, [isPlaying, musicUrl, project.musicVolume]);

  // Active subtitle for playhead
  const activeSubtitleText = useMemo(() => {
    if (!project.burnSubtitles) return '';
    if (project.subtitles.length > 0) {
      const match = project.subtitles.find(
        (c) => playheadSec >= c.startSec && playheadSec <= c.endSec
      );
      if (match) return match.text;
    }
    return previewScene?.subtitleText || '';
  }, [project.burnSubtitles, project.subtitles, playheadSec, previewScene?.subtitleText]);

  const updateScene = (sceneId: string, patch: Partial<Scene>) => {
    onUpdateProject({
      ...project,
      scenes: project.scenes.map((sc) => (sc.id === sceneId ? { ...sc, ...patch } : sc)),
    });
  };

  const handleSelectScene = (sceneId: string) => {
    setIsPlaying(false);
    setSelectedSceneId(sceneId);
    const span = sceneSpans.find((sp) => sp.id === sceneId);
    if (span) setPlayheadSec(span.start);
  };

  const handleMoveScene = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= project.scenes.length) return;
    const next = [...project.scenes];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onUpdateProject({ ...project, scenes: next });
  };

  const handleDuplicateScene = (scene: Scene, idx: number) => {
    const copy: Scene = {
      ...scene,
      id: uid('scene'),
      title: `${scene.title} (Copia)`,
    };
    const next = [...project.scenes];
    next.splice(idx + 1, 0, copy);
    onUpdateProject({ ...project, scenes: next });
    setSelectedSceneId(copy.id);
  };

  const handleDeleteScene = (sceneId: string) => {
    if (project.scenes.length <= 1) return;
    const next = project.scenes.filter((s) => s.id !== sceneId);
    onUpdateProject({ ...project, scenes: next });
    if (selectedSceneId === sceneId && next[0]) {
      setSelectedSceneId(next[0].id);
    }
  };

  const handleAddScene = () => {
    const sc = createEmptyScene(project.scenes.length + 1);
    onUpdateProject({ ...project, scenes: [...project.scenes, sc] });
    setSelectedSceneId(sc.id);
  };

  const handleBatchImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    try {
      setError(null);
      const motions: CameraMotion[] = ['ken_burns', 'zoom_in', 'pan_right', 'zoom_out', 'pan_left'];
      const added: Scene[] = [];
      for (let i = 0; i < files.length; i++) {
        const blobId = await saveMediaBlob(files[i]);
        added.push({
          ...createEmptyScene(project.scenes.length + i + 1),
          title: files[i].name.replace(/\.[^.]+$/, ''),
          imageBlobId: blobId,
          cameraMotion: motions[i % motions.length],
        });
      }
      onUpdateProject({ ...project, scenes: [...project.scenes, ...added] });
      if (added[0]) setSelectedSceneId(added[0].id);
      setStatusNote(`Se añadieron ${added.length} escenas con sus imágenes.`);
    } finally {
      if (batchImagesInputRef.current) batchImagesInputRef.current.value = '';
    }
  };

  const handleUploadImage = async (
    e: React.ChangeEvent<HTMLInputElement>,
    field: 'imageBlobId' | 'endImageBlobId'
  ) => {
    const file = e.target.files?.[0];
    if (!file || !selectedScene) return;
    const blobId = await saveMediaBlob(file);
    updateScene(selectedScene.id, { [field]: blobId });
    e.target.value = '';
  };

  const handleCreateSlateCard = async () => {
    if (!selectedScene) return;
    try {
      setError(null);
      const blob = await generateEditorialSlateImage(
        selectedScene.title,
        selectedScene.subtitleText || selectedScene.visualDirection,
        slatePalette,
        project.aspectRatio
      );
      const blobId = await saveMediaBlob(blob);
      updateScene(selectedScene.id, { imageBlobId: blobId, videoClipBlobId: undefined });
      setStatusNote('Tarjeta visual generada. Ya puedes animarla a video.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar tarjeta visual.');
    }
  };

  const handleRenderImageToVideo = async () => {
    if (!selectedScene || !previewImageBlob) {
      setError('Sube una imagen o crea una tarjeta visual primero.');
      return;
    }
    try {
      setError(null);
      setRenderingClip(true);
      const fd = new FormData();
      fd.append('image', previewImageBlob, 'start.png');
      if (endImageBlob) {
        fd.append('endImage', endImageBlob, 'end.png');
      }
      fd.append('aspectRatio', project.aspectRatio);
      fd.append('resolution', project.resolution);
      fd.append('durationSec', String(selectedScene.durationSec));
      fd.append('motion', selectedScene.cameraMotion);
      fd.append('colorGrade', selectedScene.colorGrade);
      fd.append('overlayCaption', selectedScene.overlayCaption || '');

      const res = await fetch('/api/media/image-to-video', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        throw new Error(await safeErrorMessage(res, 'Error al animar la imagen.'));
      }
      const mp4Blob = await res.blob();
      const clipBlobId = await saveMediaBlob(mp4Blob);
      updateScene(selectedScene.id, { videoClipBlobId: clipBlobId });
      setStatusNote('Clip MP4 renderizado con movimiento cinematográfico.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al renderizar el clip.');
    } finally {
      setRenderingClip(false);
    }
  };

  const handleUploadRawVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedScene) return;
    try {
      setError(null);
      const blobId = await saveMediaBlob(file);
      // Probe video duration in browser
      const tempUrl = URL.createObjectURL(file);
      const tempVid = document.createElement('video');
      tempVid.preload = 'metadata';
      tempVid.src = tempUrl;
      tempVid.onloadedmetadata = () => {
        const dur = Math.max(2, Math.round(tempVid.duration || 6));
        updateScene(selectedScene.id, {
          videoClipBlobId: blobId,
          durationSec: dur,
        });
        setVideoTrimStart(0);
        setVideoTrimEnd(Math.round(tempVid.duration || 0));
        URL.revokeObjectURL(tempUrl);
      };
    } finally {
      e.target.value = '';
    }
  };

  const handleProcessVideoToVideo = async () => {
    if (!selectedScene || !selectedClipBlob) {
      setError('Sube un video en esta escena primero.');
      return;
    }
    try {
      setError(null);
      setProcessingVideo(true);
      const fd = new FormData();
      fd.append('video', selectedClipBlob, 'source.mp4');
      fd.append('aspectRatio', project.aspectRatio);
      fd.append('resolution', project.resolution);
      fd.append('colorGrade', selectedScene.colorGrade);
      fd.append('speed', String(videoSpeed));
      fd.append('trimStart', String(videoTrimStart));
      fd.append('trimEnd', String(videoTrimEnd));
      fd.append('muteOriginal', String(Boolean(selectedScene.originalVideoMuted)));
      fd.append('overlayCaption', selectedScene.overlayCaption || '');

      const res = await fetch('/api/media/process-video', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        throw new Error(await safeErrorMessage(res, 'Error al adaptar el video.'));
      }
      const outDur = Number(res.headers.get('X-Video-Duration')) || selectedScene.durationSec;
      const mp4Blob = await res.blob();
      const newClipId = await saveMediaBlob(mp4Blob);
      updateScene(selectedScene.id, {
        videoClipBlobId: newClipId,
        durationSec: Math.max(2, Math.round(outDur)),
      });
      setStatusNote('Video adaptado con estilo, recorte y formato del proyecto.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al procesar el video.');
    } finally {
      setProcessingVideo(false);
    }
  };

  const handleGenerateSceneVoice = async () => {
    if (!selectedScene) return;
    try {
      setError(null);
      setGeneratingVoice(true);
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: selectedScene.narration,
          voice: selectedScene.voice,
          voiceStyle: selectedScene.voiceStyle,
          language: project.language,
          isDialogue: selectedScene.isDialogue,
          dialogueLines: selectedScene.dialogueLines,
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Error al generar voz.');

      const wavBlob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/wav');
      const audioBlobId = await saveMediaBlob(wavBlob);
      const audioDur = Number(data.durationSec) || selectedScene.durationSec;
      updateScene(selectedScene.id, {
        audioBlobId,
        audioDurationSec: audioDur,
        durationSec: Math.max(selectedScene.durationSec, Math.ceil(audioDur + 0.5)),
      });
      setStatusNote(`Voz generada (${audioDur.toFixed(1)}s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar voz IA.');
    } finally {
      setGeneratingVoice(false);
    }
  };

  const handleAiRefineOrExtend = async (action: 'rewrite' | 'extend') => {
    if (!selectedScene) return;
    try {
      setError(null);
      setRefiningScene(true);
      const res = await fetch('/api/ai/refine-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene: selectedScene,
          instruction: aiInstruction,
          action,
          visualStyle: project.visualStyle,
          language: project.language,
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Error al consultar al asistente.');

      if (action === 'extend') {
        const additions: Scene[] = (data.scenes || []).map((raw: Partial<Scene>, i: number) => ({
          ...createEmptyScene(selectedIndex + i + 2),
          title: raw.title || `Continuación ${i + 1}`,
          visualDirection: raw.visualDirection || '',
          narration: raw.narration || '',
          speakerName: raw.speakerName || selectedScene.speakerName,
          voice: selectedScene.voice,
          voiceStyle: raw.voiceStyle || selectedScene.voiceStyle,
          durationSec: Math.max(3, Math.min(20, Math.round(Number(raw.durationSec) || 7))),
          cameraMotion: (raw.cameraMotion as CameraMotion) || 'ken_burns',
          colorGrade: (raw.colorGrade as ColorGrade) || selectedScene.colorGrade,
          subtitleText: raw.subtitleText || raw.narration || '',
        }));

        const nextScenes = [...project.scenes];
        nextScenes.splice(selectedIndex + 1, 0, ...additions);
        onUpdateProject({ ...project, scenes: nextScenes });
        if (additions[0]) setSelectedSceneId(additions[0].id);
        setStatusNote(`Se añadieron ${additions.length} escenas de continuación.`);
      } else if (data.scene) {
        updateScene(selectedScene.id, {
          title: data.scene.title || selectedScene.title,
          visualDirection: data.scene.visualDirection || selectedScene.visualDirection,
          narration: data.scene.narration ?? selectedScene.narration,
          voiceStyle: data.scene.voiceStyle || selectedScene.voiceStyle,
          durationSec: Math.max(3, Math.min(25, Math.round(Number(data.scene.durationSec) || selectedScene.durationSec))),
          cameraMotion: (data.scene.cameraMotion as CameraMotion) || selectedScene.cameraMotion,
          colorGrade: (data.scene.colorGrade as ColorGrade) || selectedScene.colorGrade,
          subtitleText: data.scene.subtitleText || data.scene.narration || selectedScene.subtitleText,
        });
        setStatusNote('Escena adaptada con IA.');
      }
      setAiInstruction('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error en asistente IA.');
    } finally {
      setRefiningScene(false);
    }
  };

  const activeGradeCss =
    GRADES.find((g) => g.id === previewScene?.colorGrade)?.cssFilter || 'none';

  return (
    <div className="flex flex-col h-[calc(100vh-61px)] overflow-hidden">
      {/* Hidden audio tracks for synchronized preview playback */}
      <audio ref={voiceAudioRef} src={previewVoiceUrl || undefined} className="hidden" />
      <audio ref={musicAudioRef} src={musicUrl || undefined} loop className="hidden" />

      {/* Main 2-column studio split */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Rail: Scene Stack */}
        <aside className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-white/[0.08] bg-[#0F1218] flex flex-col min-h-0 max-h-56 lg:max-h-none">
          <div className="p-3.5 border-b border-white/[0.08] flex items-center justify-between gap-2">
            <div className="min-w-0">
              <input
                type="text"
                value={project.title}
                onChange={(e) => onUpdateProject({ ...project, title: e.target.value })}
                className="w-full bg-transparent text-sm font-semibold text-[#F1F3F6] truncate focus:outline-none focus:bg-[#1A1E27] rounded px-1 -mx-1"
              />
              <div className="text-[11px] text-[#8C94A4] mt-0.5 tabular-nums">
                {project.scenes.length} escenas · {formatTimecode(totalDuration)}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <input
                ref={batchImagesInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleBatchImages}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => batchImagesInputRef.current?.click()}
                title="Importar lote de imágenes"
                className="p-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[#C8CDD8] cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleAddScene}
                title="Añadir escena"
                className="p-1.5 rounded-md bg-[#E5A93B] text-[#0B0D11] hover:bg-[#F0B84F] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {project.scenes.map((sc, idx) => {
              const active = sc.id === selectedScene?.id;
              const mediaKind = sc.videoClipBlobId
                ? 'Clip MP4'
                : sc.imageBlobId
                ? 'Imagen'
                : 'Tarjeta';
              return (
                <div
                  key={sc.id}
                  onClick={() => handleSelectScene(sc.id)}
                  className={`group p-2.5 rounded-lg border transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#191E29] border-[#E5A93B]/60'
                      : 'bg-transparent border-transparent hover:bg-[#141821] hover:border-white/[0.06]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[#F1F3F6] truncate">{sc.title}</span>
                    <span className="text-[11px] font-mono tabular-nums text-[#8C94A4] shrink-0">
                      {sc.durationSec}s
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[#8C94A4] truncate">
                      {mediaKind}
                      {sc.audioBlobId ? ' · Voz lista' : ''}
                    </span>
                    <div
                      className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => handleDuplicateScene(sc, idx)}
                        title="Duplicar"
                        className="p-1 text-[#9CA3B2] hover:text-white cursor-pointer"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      {project.scenes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleDeleteScene(sc.id)}
                          title="Eliminar"
                          className="p-1 text-[#9CA3B2] hover:text-red-300 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="p-3 border-t border-white/[0.08]">
            <button
              type="button"
              onClick={onGoToScript}
              className="w-full py-2 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.11] text-xs font-medium text-[#F1F3F6] transition-colors cursor-pointer"
            >
              Generar guion largo con IA
            </button>
          </div>
        </aside>

        {/* Center Stage: Preview + Inspector */}
        <div className="flex-1 min-w-0 flex flex-col lg:flex-row overflow-hidden">
          {/* Preview Monitor */}
          <div className="flex-1 min-w-0 flex flex-col bg-[#0B0D11] p-4 overflow-y-auto">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div className="text-xs text-[#9CA3B2] truncate">
                {isPlaying ? 'Reproducción completa' : `Editando: ${selectedScene?.title || ''}`}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={project.aspectRatio}
                  onChange={(e) =>
                    onUpdateProject({ ...project, aspectRatio: e.target.value as AspectRatio })
                  }
                  className="h-7 px-2 rounded bg-[#13161D] border border-white/[0.08] text-xs text-[#F1F3F6]"
                >
                  <option value="16:9">16:9 Horizontal</option>
                  <option value="9:16">9:16 Vertical</option>
                </select>
                <select
                  value={project.resolution}
                  onChange={(e) =>
                    onUpdateProject({ ...project, resolution: e.target.value as Resolution })
                  }
                  className="h-7 px-2 rounded bg-[#13161D] border border-white/[0.08] text-xs text-[#F1F3F6]"
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>
            </div>

            {/* Viewport Container */}
            <div className="flex-1 min-h-[240px] flex items-center justify-center">
              <div
                className={`relative bg-[#13161D] border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl flex items-center justify-center ${
                  project.aspectRatio === '9:16'
                    ? 'h-full max-h-[420px] aspect-[9/16]'
                    : 'w-full max-w-2xl aspect-video'
                }`}
              >
                {previewVideoUrl ? (
                  <video
                    ref={videoPlayerRef}
                    src={previewVideoUrl}
                    controls={!isPlaying}
                    playsInline
                    className="w-full h-full object-cover"
                    style={{ filter: activeGradeCss }}
                  />
                ) : previewImageUrl ? (
                  <img
                    src={previewImageUrl}
                    alt={previewScene?.title || 'Vista previa'}
                    referrerPolicy="no-referrer"
                    className={`w-full h-full object-cover transition-transform duration-1000 ${
                      isPlaying && previewScene?.cameraMotion === 'zoom_in' ? 'scale-110' : 'scale-100'
                    }`}
                    style={{ filter: activeGradeCss }}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center px-8 text-center bg-[#13161D]">
                    <div className="w-10 h-0.5 bg-[#E5A93B] mb-4" />
                    <h3 className="text-lg font-semibold text-[#F1F3F6] max-w-md text-balance">
                      {previewScene?.title || 'Sin escena'}
                    </h3>
                    <p className="text-xs text-[#9CA3B2] mt-2 max-w-md line-clamp-3">
                      {previewScene?.visualDirection || 'Sube una imagen, video o crea una tarjeta visual en el panel derecho.'}
                    </p>
                  </div>
                )}

                {previewScene?.overlayCaption && !previewVideoUrl && (
                  <div className="absolute left-6 bottom-12 px-3 py-1.5 rounded bg-black/70 text-xs font-medium text-white">
                    {previewScene.overlayCaption}
                  </div>
                )}

                {activeSubtitleText && (
                  <div className="absolute inset-x-6 bottom-4 flex justify-center pointer-events-none">
                    <div className="px-3.5 py-1.5 rounded bg-black/80 text-white text-xs sm:text-sm text-center max-w-[90%]">
                      {activeSubtitleText}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Transport Controls */}
            <div className="mt-3 pt-3 border-t border-white/[0.08] flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const prevIdx = Math.max(0, selectedIndex - 1);
                    if (project.scenes[prevIdx]) handleSelectScene(project.scenes[prevIdx].id);
                  }}
                  className="p-2 rounded-lg bg-[#13161D] border border-white/[0.08] text-[#C8CDD8] hover:text-white cursor-pointer"
                >
                  <SkipBack className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (!isPlaying && playheadSec >= totalDuration) setPlayheadSec(0);
                    setIsPlaying((p) => !p);
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-xs font-semibold hover:bg-[#F0B84F] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  {isPlaying ? 'Pausar secuencia' : 'Reproducir todo'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const nextIdx = Math.min(project.scenes.length - 1, selectedIndex + 1);
                    if (project.scenes[nextIdx]) handleSelectScene(project.scenes[nextIdx].id);
                  }}
                  className="p-2 rounded-lg bg-[#13161D] border border-white/[0.08] text-[#C8CDD8] hover:text-white cursor-pointer"
                >
                  <SkipForward className="w-4 h-4" />
                </button>
              </div>

              <div className="text-xs font-mono tabular-nums text-[#C8CDD8]">
                {formatTimecode(playheadSec)} / {formatTimecode(totalDuration)}
              </div>
            </div>
          </div>

          {/* Right Inspector Panel */}
          {selectedScene && (
            <aside className="w-full lg:w-[400px] shrink-0 border-t lg:border-t-0 lg:border-l border-white/[0.08] bg-[#10131A] flex flex-col min-h-0">
              {/* Inspector Tabs */}
              <div className="grid grid-cols-4 border-b border-white/[0.08] bg-[#0D1016]">
                {(
                  [
                    { id: 'image_to_video', label: 'Imagen', Icon: ImageIcon },
                    { id: 'video_to_video', label: 'Video', Icon: Scissors },
                    { id: 'script_voice', label: 'Voz IA', Icon: Volume2 },
                    { id: 'extend_ai', label: 'Extender', Icon: Wand2 },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setInspectorTab(id)}
                    className={`py-2.5 px-2 flex items-center justify-center gap-1.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                      inspectorTab === id
                        ? 'border-[#E5A93B] text-[#F1F3F6] bg-[#141821]'
                        : 'border-transparent text-[#8C94A4] hover:text-[#F1F3F6]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Feedback Banners */}
              {(statusNote || error) && (
                <div className="px-4 pt-3">
                  {error && (
                    <div className="p-2.5 rounded-lg bg-red-950/50 border border-red-500/30 text-xs text-red-200">
                      {error}
                    </div>
                  )}
                  {statusNote && !error && (
                    <div className="p-2.5 rounded-lg bg-[#19221A] border border-emerald-500/30 text-xs text-emerald-200 flex items-center justify-between gap-2">
                      <span>{statusNote}</span>
                      <button
                        type="button"
                        onClick={() => setStatusNote(null)}
                        className="text-emerald-300 hover:text-white cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* TAB 1: IMAGE TO VIDEO */}
                {inspectorTab === 'image_to_video' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="block text-[11px] font-medium text-[#C8CDD8]">
                          Imagen inicial
                        </label>
                        <input
                          ref={startImgInputRef}
                          type="file"
                          accept="image/*"
                          onChange={(e) => handleUploadImage(e, 'imageBlobId')}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => startImgInputRef.current?.click()}
                          className="w-full h-24 rounded-lg border border-dashed border-white/[0.14] bg-[#161A23] hover:border-[#E5A93B] overflow-hidden flex flex-col items-center justify-center text-xs text-[#9CA3B2] cursor-pointer"
                        >
                          {previewImageUrl ? (
                            <img
                              src={previewImageUrl}
                              alt="Inicio"
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <>
                              <Upload className="w-4 h-4 mb-1" />
                              Subir foto
                            </>
                          )}
                        </button>
                      </div>

                      <div className="space-y-1.5">
                        <label className="block text-[11px] font-medium text-[#C8CDD8]">
                          Imagen final (opcional)
                        </label>
                        <input
                          ref={endImgInputRef}
                          type="file"
                          accept="image/*"
                          onChange={(e) => handleUploadImage(e, 'endImageBlobId')}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => endImgInputRef.current?.click()}
                          className="w-full h-24 rounded-lg border border-dashed border-white/[0.14] bg-[#161A23] hover:border-[#E5A93B] overflow-hidden flex flex-col items-center justify-center text-xs text-[#9CA3B2] cursor-pointer"
                        >
                          {endImageUrl ? (
                            <img
                              src={endImageUrl}
                              alt="Fin"
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <>
                              <Upload className="w-4 h-4 mb-1" />
                              Transición a 2ª foto
                            </>
                          )}
                        </button>
                        {endImageUrl && (
                          <button
                            type="button"
                            onClick={() => updateScene(selectedScene.id, { endImageBlobId: undefined })}
                            className="text-[11px] text-[#9CA3B2] hover:text-red-300 cursor-pointer"
                          >
                            Quitar 2ª foto
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Instant Editorial Card generator & Auto Stock Search */}
                    <div className="p-3 rounded-lg bg-[#141821] border border-white/[0.06] space-y-2.5">
                      <button
                        type="button"
                        disabled={renderingClip}
                        onClick={async () => {
                          if (!selectedScene) return;
                          try {
                            setError(null);
                            setRenderingClip(true);
                            const q =
                              selectedScene.visualDirection ||
                              selectedScene.title ||
                              project.title;
                            const res = await fetch('/api/media/fetch-stock', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                query: q.slice(0, 70),
                                aspectRatio: project.aspectRatio,
                                preferVideo: true,
                              }),
                            });
                            if (!res.ok) {
                              throw new Error(
                                await safeErrorMessage(res, 'No se encontró visual automático.')
                              );
                            }
                            const kind = res.headers.get('X-Media-Kind');
                            const src = res.headers.get('X-Media-Source') || 'banco libre';
                            const blob = await res.blob();
                            const savedId = await saveMediaBlob(blob);
                            if (kind === 'video') {
                              updateScene(selectedScene.id, { videoClipBlobId: savedId });
                            } else {
                              updateScene(selectedScene.id, {
                                imageBlobId: savedId,
                                videoClipBlobId: undefined,
                              });
                            }
                            setStatusNote(`Visual automático cargado (${src}).`);
                          } catch (err) {
                            setError(
                              err instanceof Error ? err.message : 'Error buscando visual automático.'
                            );
                          } finally {
                            setRenderingClip(false);
                          }
                        }}
                        className="w-full py-2 rounded-md bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-[#E5A93B] transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Buscar foto/video automático para esta escena
                      </button>

                      <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2">
                        <span className="text-[11px] text-[#C8CDD8]">O crea una tarjeta visual:</span>
                        <select
                          value={slatePalette}
                          onChange={(e) => setSlatePalette(e.target.value as SlatePalette)}
                          className="px-2 py-1 rounded bg-[#0B0D11] border border-white/[0.08] text-[11px] text-[#F1F3F6]"
                        >
                          <option value="charcoal">Grafito y Ámbar</option>
                          <option value="amber_dusk">Ocaso Cálido</option>
                          <option value="ocean_noir">Océano Nocturno</option>
                          <option value="forest_mist">Bosque Niebla</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={handleCreateSlateCard}
                        className="w-full py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.11] text-xs font-medium text-[#F1F3F6] transition-colors cursor-pointer"
                      >
                        Generar imagen desde título de escena
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Movimiento de cámara</label>
                        <select
                          value={selectedScene.cameraMotion}
                          onChange={(e) =>
                            updateScene(selectedScene.id, {
                              cameraMotion: e.target.value as CameraMotion,
                            })
                          }
                          className="w-full h-9 px-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                        >
                          {MOTIONS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Duración (segundos)</label>
                        <input
                          type="number"
                          min={2}
                          max={30}
                          value={selectedScene.durationSec}
                          onChange={(e) =>
                            updateScene(selectedScene.id, {
                              durationSec: Math.max(2, Math.min(30, Number(e.target.value) || 5)),
                            })
                          }
                          className="w-full h-9 px-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6] tabular-nums"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Estilo / Color</label>
                        <select
                          value={selectedScene.colorGrade}
                          onChange={(e) =>
                            updateScene(selectedScene.id, {
                              colorGrade: e.target.value as ColorGrade,
                            })
                          }
                          className="w-full h-9 px-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                        >
                          {GRADES.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Texto en pantalla</label>
                        <input
                          type="text"
                          value={selectedScene.overlayCaption || ''}
                          onChange={(e) =>
                            updateScene(selectedScene.id, { overlayCaption: e.target.value })
                          }
                          placeholder="Opcional..."
                          className="w-full h-9 px-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={renderingClip || !previewImageBlob}
                      onClick={handleRenderImageToVideo}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-xs font-semibold hover:bg-[#F0B84F] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
                    >
                      {renderingClip ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Renderizando MP4...
                        </>
                      ) : (
                        <>
                          <Film className="w-4 h-4" />
                          Convertir Imagen a Video MP4
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* TAB 2: VIDEO TO VIDEO */}
                {inspectorTab === 'video_to_video' && (
                  <div className="space-y-4">
                    <div>
                      <input
                        ref={videoUploadInputRef}
                        type="file"
                        accept="video/*"
                        onChange={handleUploadRawVideo}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => videoUploadInputRef.current?.click()}
                        className="w-full py-4 px-4 rounded-lg border border-dashed border-white/[0.16] bg-[#161A23] hover:border-[#E5A93B] flex flex-col items-center justify-center gap-1.5 text-xs text-[#C8CDD8] cursor-pointer"
                      >
                        <Upload className="w-4 h-4 text-[#E5A93B]" />
                        {selectedClipUrl
                          ? 'Reemplazar archivo de video'
                          : 'Subir video para editar / adaptar'}
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Inicio (s)</label>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={videoTrimStart}
                          onChange={(e) => setVideoTrimStart(Math.max(0, Number(e.target.value) || 0))}
                          className="w-full h-8 px-2 rounded bg-[#161A23] border border-white/[0.08] text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Fin (s, 0=todo)</label>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={videoTrimEnd}
                          onChange={(e) => setVideoTrimEnd(Math.max(0, Number(e.target.value) || 0))}
                          className="w-full h-8 px-2 rounded bg-[#161A23] border border-white/[0.08] text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-[#8C94A4] mb-1">Velocidad</label>
                        <select
                          value={videoSpeed}
                          onChange={(e) => setVideoSpeed(Number(e.target.value))}
                          className="w-full h-8 px-2 rounded bg-[#161A23] border border-white/[0.08] text-xs tabular-nums"
                        >
                          <option value={0.75}>0.75x</option>
                          <option value={1}>1.0x</option>
                          <option value={1.25}>1.25x</option>
                          <option value={1.5}>1.5x</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-[#8C94A4] mb-1">Filtro de estilo visual</label>
                      <select
                        value={selectedScene.colorGrade}
                        onChange={(e) =>
                          updateScene(selectedScene.id, {
                            colorGrade: e.target.value as ColorGrade,
                          })
                        }
                        className="w-full h-9 px-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                      >
                        {GRADES.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-[#8C94A4] mb-1">
                        Rótulo / Personaje sobre el video
                      </label>
                      <input
                        type="text"
                        value={selectedScene.overlayCaption || ''}
                        onChange={(e) =>
                          updateScene(selectedScene.id, { overlayCaption: e.target.value })
                        }
                        placeholder="Ej. Entrevista · Elena Vance"
                        className="w-full h-9 px-3 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                      />
                    </div>

                    <label className="inline-flex items-center gap-2 text-xs text-[#C8CDD8] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedScene.originalVideoMuted)}
                        onChange={(e) =>
                          updateScene(selectedScene.id, { originalVideoMuted: e.target.checked })
                        }
                        className="accent-[#E5A93B]"
                      />
                      Silenciar audio original (para usar solo voz IA y música)
                    </label>

                    <button
                      type="button"
                      disabled={processingVideo || !selectedClipBlob}
                      onClick={handleProcessVideoToVideo}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-xs font-semibold hover:bg-[#F0B84F] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
                    >
                      {processingVideo ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Procesando video...
                        </>
                      ) : (
                        <>
                          <Scissors className="w-4 h-4" />
                          Aplicar cambios al video
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* TAB 3: SCRIPT & AI VOICE */}
                {inspectorTab === 'script_voice' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[11px] text-[#8C94A4] mb-1">Título de la escena</label>
                      <input
                        type="text"
                        value={selectedScene.title}
                        onChange={(e) => updateScene(selectedScene.id, { title: e.target.value })}
                        className="w-full h-9 px-3 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                      />
                    </div>

                    <div className="flex items-center justify-between p-2 rounded-lg bg-[#141821] border border-white/[0.06]">
                      <span className="text-xs text-[#C8CDD8]">Modo de voz</span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => updateScene(selectedScene.id, { isDialogue: false })}
                          className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer ${
                            !selectedScene.isDialogue
                              ? 'bg-[#E5A93B] text-[#0B0D11]'
                              : 'text-[#9CA3B2] hover:text-white'
                          }`}
                        >
                          Narrador único
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const initLines: DialogueLine[] =
                              selectedScene.dialogueLines.length > 0
                                ? selectedScene.dialogueLines
                                : [
                                    {
                                      id: uid('dl'),
                                      speaker: project.characters[0]?.name || 'Narrador',
                                      text: selectedScene.narration || '',
                                      voice: project.characters[0]?.voice || 'Charon',
                                      style: project.characters[0]?.voiceStyle || 'Natural',
                                    },
                                  ];
                            updateScene(selectedScene.id, {
                              isDialogue: true,
                              dialogueLines: initLines,
                            });
                          }}
                          className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer ${
                            selectedScene.isDialogue
                              ? 'bg-[#E5A93B] text-[#0B0D11]'
                              : 'text-[#9CA3B2] hover:text-white'
                          }`}
                        >
                          Diálogo multi-voz
                        </button>
                      </div>
                    </div>

                    {!selectedScene.isDialogue ? (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[11px] text-[#8C94A4] mb-1">Personaje / Voz</label>
                            <select
                              value={selectedScene.voice}
                              onChange={(e) =>
                                updateScene(selectedScene.id, { voice: e.target.value as VoiceName })
                              }
                              className="w-full h-8 px-2 rounded bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                            >
                              {VOICES.map((v) => (
                                <option key={v} value={v}>
                                  {v}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] text-[#8C94A4] mb-1">Estilo vocal</label>
                            <input
                              type="text"
                              value={selectedScene.voiceStyle}
                              onChange={(e) =>
                                updateScene(selectedScene.id, { voiceStyle: e.target.value })
                              }
                              className="w-full h-8 px-2.5 rounded bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] text-[#8C94A4] mb-1">Texto de narración</label>
                          <textarea
                            rows={4}
                            value={selectedScene.narration}
                            onChange={(e) =>
                              updateScene(selectedScene.id, {
                                narration: e.target.value,
                                subtitleText: e.target.value,
                              })
                            }
                            placeholder="Escribe lo que dirá la voz en esta escena..."
                            className="w-full p-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6] leading-relaxed"
                          />
                        </div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        {selectedScene.dialogueLines.map((line) => (
                          <div
                            key={line.id}
                            className="p-2.5 rounded-lg bg-[#141821] border border-white/[0.06] space-y-2"
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={line.speaker}
                                onChange={(e) =>
                                  updateScene(selectedScene.id, {
                                    dialogueLines: selectedScene.dialogueLines.map((l) =>
                                      l.id === line.id ? { ...l, speaker: e.target.value } : l
                                    ),
                                  })
                                }
                                placeholder="Personaje"
                                className="flex-1 h-7 px-2 rounded bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6]"
                              />
                              <select
                                value={line.voice}
                                onChange={(e) =>
                                  updateScene(selectedScene.id, {
                                    dialogueLines: selectedScene.dialogueLines.map((l) =>
                                      l.id === line.id
                                        ? { ...l, voice: e.target.value as VoiceName }
                                        : l
                                    ),
                                  })
                                }
                                className="h-7 px-2 rounded bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6]"
                              >
                                {VOICES.map((v) => (
                                  <option key={v} value={v}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() =>
                                  updateScene(selectedScene.id, {
                                    dialogueLines: selectedScene.dialogueLines.filter(
                                      (l) => l.id !== line.id
                                    ),
                                  })
                                }
                                className="text-[#8C94A4] hover:text-red-300 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <textarea
                              rows={2}
                              value={line.text}
                              onChange={(e) =>
                                updateScene(selectedScene.id, {
                                  dialogueLines: selectedScene.dialogueLines.map((l) =>
                                    l.id === line.id ? { ...l, text: e.target.value } : l
                                  ),
                                })
                              }
                              placeholder="Diálogo..."
                              className="w-full p-2 rounded bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6]"
                            />
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            updateScene(selectedScene.id, {
                              dialogueLines: [
                                ...selectedScene.dialogueLines,
                                {
                                  id: uid('dl'),
                                  speaker: project.characters[1]?.name || 'Elena',
                                  text: '',
                                  voice: project.characters[1]?.voice || 'Kore',
                                  style: 'Conversacional natural',
                                },
                              ],
                            })
                          }
                          className="w-full py-1.5 rounded bg-white/[0.06] hover:bg-white/[0.11] text-xs text-[#F1F3F6] cursor-pointer"
                        >
                          + Añadir intervención
                        </button>
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] text-[#8C94A4] mb-1">Subtítulo de la escena</label>
                      <input
                        type="text"
                        value={selectedScene.subtitleText}
                        onChange={(e) =>
                          updateScene(selectedScene.id, { subtitleText: e.target.value })
                        }
                        className="w-full h-8 px-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={generatingVoice}
                      onClick={handleGenerateSceneVoice}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#E5A93B] text-[#0B0D11] text-xs font-semibold hover:bg-[#F0B84F] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      {generatingVoice ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Sintetizando voz...
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-4 h-4" />
                          Generar Voz IA
                        </>
                      )}
                    </button>

                    {selectedVoiceUrl && (
                      <div className="p-2.5 rounded-lg bg-[#141821] border border-white/[0.06] space-y-1.5">
                        <div className="flex justify-between text-[11px] text-[#8C94A4] tabular-nums">
                          <span>Audio generado</span>
                          <span>{(selectedScene.audioDurationSec || 0).toFixed(1)}s</span>
                        </div>
                        <audio controls src={selectedVoiceUrl} className="w-full h-8" />
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 4: EXTEND / AI ASSISTANT */}
                {inspectorTab === 'extend_ai' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[11px] text-[#8C94A4] mb-1">
                        Notas de dirección visual
                      </label>
                      <textarea
                        rows={3}
                        value={selectedScene.visualDirection}
                        onChange={(e) =>
                          updateScene(selectedScene.id, { visualDirection: e.target.value })
                        }
                        className="w-full p-2.5 rounded-lg bg-[#161A23] border border-white/[0.08] text-xs text-[#F1F3F6]"
                      />
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#141821] border border-white/[0.06] space-y-3">
                      <label className="block text-xs font-medium text-[#F1F3F6]">
                        Edición conversacional de la escena
                      </label>
                      <textarea
                        rows={3}
                        value={aiInstruction}
                        onChange={(e) => setAiInstruction(e.target.value)}
                        placeholder="Ej. Haz la narración más emotiva y cambia el color a nocturno..."
                        className="w-full p-2.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6]"
                      />
                      <div className="grid grid-cols-1 gap-2">
                        <button
                          type="button"
                          disabled={refiningScene}
                          onClick={() => handleAiRefineOrExtend('rewrite')}
                          className="w-full py-2 px-3 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-[#F1F3F6] inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                        >
                          {refiningScene ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Wand2 className="w-3.5 h-3.5 text-[#E5A93B]" />
                          )}
                          Adaptar escena según instrucción
                        </button>

                        <button
                          type="button"
                          disabled={refiningScene}
                          onClick={() => handleAiRefineOrExtend('extend')}
                          className="w-full py-2 px-3 rounded-lg bg-[#E5A93B] text-[#0B0D11] hover:bg-[#F0B84F] text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                        >
                          {refiningScene ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <MessageSquarePlus className="w-3.5 h-3.5" />
                          )}
                          Extender en 2 escenas continuas
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>

      {/* Bottom Multi-Track Timeline */}
      <section className="h-44 shrink-0 border-t border-white/[0.08] bg-[#0D1016] flex flex-col">
        <div className="px-4 py-1.5 border-b border-white/[0.06] flex items-center justify-between text-[11px] text-[#8C94A4]">
          <div className="flex items-center gap-3">
            <span className="font-medium text-[#C8CDD8]">Línea de Tiempo</span>
            <span>
              Transición: {project.transitionType === 'fade' ? 'Fundido cruzado' : 'Corte directo'}
            </span>
          </div>
          <div className="tabular-nums font-mono">
            Duración total: {formatTimecode(totalDuration)}
          </div>
        </div>

        <div className="flex-1 overflow-x-auto overflow-y-hidden p-3 space-y-2">
          {/* Video Track */}
          <div className="flex items-center gap-1.5 min-w-max">
            <span className="w-16 shrink-0 text-[11px] text-[#8C94A4]">Video</span>
            {project.scenes.map((sc, idx) => {
              const active = sc.id === selectedScene?.id;
              const widthPx = Math.max(96, sc.durationSec * 18);
              return (
                <div
                  key={sc.id}
                  onClick={() => handleSelectScene(sc.id)}
                  style={{ width: `${widthPx}px` }}
                  className={`h-11 px-2.5 rounded-md border flex items-center justify-between gap-2 shrink-0 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#1D2330] border-[#E5A93B]'
                      : 'bg-[#141821] border-white/[0.08] hover:border-white/[0.2]'
                  }`}
                >
                  <span className="text-xs font-medium text-[#F1F3F6] truncate">{sc.title}</span>
                  <div
                    className="flex items-center gap-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => handleMoveScene(idx, -1)}
                      className="p-0.5 text-[#8C94A4] hover:text-white disabled:opacity-25 cursor-pointer"
                    >
                      <ArrowLeft className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === project.scenes.length - 1}
                      onClick={() => handleMoveScene(idx, 1)}
                      className="p-0.5 text-[#8C94A4] hover:text-white disabled:opacity-25 cursor-pointer"
                    >
                      <ArrowRight className="w-3 h-3" />
                    </button>
                    <span className="text-[10px] font-mono tabular-nums text-[#8C94A4] ml-1">
                      {sc.durationSec}s
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Voice Track */}
          <div className="flex items-center gap-1.5 min-w-max">
            <span className="w-16 shrink-0 text-[11px] text-[#8C94A4]">Voces</span>
            {project.scenes.map((sc) => {
              const widthPx = Math.max(96, sc.durationSec * 18);
              return (
                <div
                  key={`v_${sc.id}`}
                  onClick={() => {
                    handleSelectScene(sc.id);
                    setInspectorTab('script_voice');
                  }}
                  style={{ width: `${widthPx}px` }}
                  className={`h-7 px-2 rounded border flex items-center justify-between text-[11px] shrink-0 cursor-pointer ${
                    sc.audioBlobId
                      ? 'bg-[#172421] border-emerald-500/35 text-emerald-200'
                      : 'bg-[#11141B] border-white/[0.05] text-[#6B7280]'
                  }`}
                >
                  <span className="truncate">{sc.audioBlobId ? sc.speakerName : 'Sin voz'}</span>
                  {sc.audioDurationSec && (
                    <span className="font-mono tabular-nums text-[10px]">
                      {sc.audioDurationSec.toFixed(1)}s
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Music Track */}
          <div className="flex items-center gap-1.5 min-w-max">
            <span className="w-16 shrink-0 text-[11px] text-[#8C94A4]">Música</span>
            <div
              style={{
                width: `${Math.max(240, project.scenes.reduce((acc, s) => acc + Math.max(96, s.durationSec * 18), 0))}px`,
              }}
              className={`h-6 px-2.5 rounded border flex items-center justify-between text-[11px] ${
                project.musicBlobId
                  ? 'bg-[#1D1B14] border-[#E5A93B]/35 text-[#F0D395]'
                  : 'bg-[#11141B] border-white/[0.05] text-[#6B7280]'
              }`}
            >
              <span className="truncate">
                {project.musicBlobId
                  ? `${project.musicFileName || 'Pista musical'} (Bucle)`
                  : 'Sin pista de música cargada'}
              </span>
              {project.musicBlobId && (
                <span className="font-mono tabular-nums text-[10px]">
                  {Math.round(project.musicVolume * 100)}%
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
