import { Project } from '../types/studio';
import { getMediaBlob } from './storage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function safeJson<T = any>(res: Response): Promise<T> {
  const raw = await res.text();
  if (!raw || !raw.trim()) {
    if (!res.ok) {
      throw new Error(`El servidor respondió sin contenido (HTTP ${res.status}).`);
    }
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    if (res.status === 413) {
      throw new Error('El archivo enviado supera el límite permitido por el servidor (HTTP 413).');
    }
    if (res.status === 504 || res.status === 502 || raw.includes('The page c')) {
      throw new Error(
        `La operación tardó demasiado en responder (HTTP ${res.status}). Intenta de nuevo o usa clips más ligeros.`
      );
    }
    const snippet = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    throw new Error(`Respuesta inesperada del servidor (HTTP ${res.status}): ${snippet || 'formato inválido'}`);
  }
}

export async function safeErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await safeJson<{ error?: string }>(res);
    return data?.error || fallback;
  } catch (err) {
    return err instanceof Error ? err.message : fallback;
  }
}

export interface MediaPreviewResult {
  mediaType: 'image' | 'video';
  durationSec: number;
  thumbnailBase64: string;
}

function canvasToJpegBase64(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxWidth = 640
): string {
  const safeW = Math.max(1, srcW);
  const safeH = Math.max(1, srcH);
  const scale = safeW > maxWidth ? maxWidth / safeW : 1;
  const w = Math.max(1, Math.round(safeW * scale));
  const h = Math.max(1, Math.round(safeH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(source, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
}

export async function extractMediaPreviewThumbnail(file: File): Promise<MediaPreviewResult> {
  const isVideo = file.type.startsWith('video/');
  const objectUrl = URL.createObjectURL(file);

  try {
    if (isVideo) {
      return await new Promise<MediaPreviewResult>((resolve) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';

        let settled = false;
        const finish = (durationSec: number, thumbnailBase64: string) => {
          if (settled) return;
          settled = true;
          video.removeAttribute('src');
          video.load();
          resolve({
            mediaType: 'video',
            durationSec: Math.max(2, Math.round(durationSec || 6)),
            thumbnailBase64,
          });
        };

        const timeout = window.setTimeout(() => finish(6, ''), 6000);

        video.onloadedmetadata = () => {
          const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 6;
          const seekTarget = Math.min(1.0, dur * 0.25);
          if (seekTarget > 0.05) {
            video.currentTime = seekTarget;
          } else {
            window.clearTimeout(timeout);
            const b64 = canvasToJpegBase64(video, video.videoWidth || 640, video.videoHeight || 360);
            finish(dur, b64);
          }
        };

        video.onseeked = () => {
          window.clearTimeout(timeout);
          const b64 = canvasToJpegBase64(video, video.videoWidth || 640, video.videoHeight || 360);
          finish(video.duration, b64);
        };

        video.onerror = () => {
          window.clearTimeout(timeout);
          finish(6, '');
        };

        video.src = objectUrl;
      });
    }

    return await new Promise<MediaPreviewResult>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const b64 = canvasToJpegBase64(img, img.naturalWidth || 640, img.naturalHeight || 360);
        resolve({
          mediaType: 'image',
          durationSec: 0,
          thumbnailBase64: b64,
        });
      };
      img.onerror = () => {
        resolve({
          mediaType: 'image',
          durationSec: 0,
          thumbnailBase64: '',
        });
      };
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function exportProjectMp4(
  project: Project,
  onProgress?: (msg: string) => void
): Promise<void> {
  if (!project.scenes || project.scenes.length === 0) {
    throw new Error('Agrega al menos una escena antes de exportar.');
  }

  const manifest = {
    title: project.title,
    aspectRatio: project.aspectRatio,
    resolution: project.resolution,
    transitionType: project.transitionType,
    transitionDurationSec: project.transitionDurationSec,
    musicVolume: project.musicVolume,
    voiceVolume: project.voiceVolume,
    clipAudioVolume: project.clipAudioVolume,
    burnSubtitles: project.burnSubtitles,
    subtitles: project.subtitles,
    scenes: project.scenes.map((sc) => ({
      id: sc.id,
      title: sc.title,
      durationSec: sc.durationSec,
      cameraMotion: sc.cameraMotion,
      colorGrade: sc.colorGrade,
      subtitleText: sc.subtitleText,
      narration: sc.narration,
      overlayCaption: sc.overlayCaption,
      originalVideoMuted: sc.originalVideoMuted,
    })),
  };

  onProgress?.('Iniciando trabajo de exportación...');
  const startRes = await fetch('/api/export/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  const startData = await safeJson<{ jobId?: string; error?: string }>(startRes);
  if (!startRes.ok || !startData.jobId) {
    throw new Error(startData.error || 'No se pudo iniciar la exportación.');
  }
  const jobId = startData.jobId;

  const uploadAsset = async (key: string, blob: Blob, filename: string) => {
    const fd = new FormData();
    fd.append('key', key);
    fd.append('file', blob, filename);
    const res = await fetch(`/api/export/${jobId}/asset`, {
      method: 'POST',
      body: fd,
    });
    const data = await safeJson<{ ok?: boolean; error?: string }>(res);
    if (!res.ok) {
      throw new Error(data.error || `Error al subir archivo (${filename}).`);
    }
  };

  // Upload scene assets one by one to stay well below proxy body limits
  for (let i = 0; i < project.scenes.length; i++) {
    const sc = project.scenes[i];
    onProgress?.(`Subiendo escena ${i + 1} de ${project.scenes.length}...`);
    if (sc.videoClipBlobId) {
      const b = await getMediaBlob(sc.videoClipBlobId);
      if (b) await uploadAsset(`clip_${sc.id}`, b, `clip_${sc.id}.mp4`);
    } else if (sc.imageBlobId) {
      const b = await getMediaBlob(sc.imageBlobId);
      if (b) await uploadAsset(`image_${sc.id}`, b, `image_${sc.id}.png`);
    }
    if (sc.audioBlobId) {
      const b = await getMediaBlob(sc.audioBlobId);
      if (b) await uploadAsset(`audio_${sc.id}`, b, `audio_${sc.id}.wav`);
    }
  }

  if (project.musicBlobId) {
    onProgress?.('Subiendo música ambiental...');
    const mb = await getMediaBlob(project.musicBlobId);
    if (mb) await uploadAsset('music_track', mb, project.musicFileName || 'music.mp3');
  }

  // Trigger asynchronous FFmpeg render
  onProgress?.('Renderizando video en el servidor...');
  const renderRes = await fetch(`/api/export/${jobId}/render`, { method: 'POST' });
  const renderData = await safeJson<{ status?: string; error?: string }>(renderRes);
  if (!renderRes.ok) {
    throw new Error(renderData.error || 'Error iniciando el renderizado FFmpeg.');
  }

  // Poll job status until done or error
  const maxAttempts = 240; // ~6 minutes max
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => window.setTimeout(r, 1500));
    const statusRes = await fetch(`/api/export/${jobId}/status`);
    const statusData = await safeJson<{
      status?: 'uploading' | 'rendering' | 'done' | 'error';
      progress?: string;
      error?: string;
    }>(statusRes);

    if (!statusRes.ok) {
      throw new Error(statusData.error || 'Error consultando el estado del renderizado.');
    }
    if (statusData.progress) {
      onProgress?.(statusData.progress);
    }
    if (statusData.status === 'error') {
      throw new Error(statusData.error || 'Falló el ensamblado del video MP4.');
    }
    if (statusData.status === 'done') {
      break;
    }
    if (attempt === maxAttempts - 1) {
      throw new Error('El renderizado tardó demasiado en completarse.');
    }
  }

  // Download assembled MP4
  onProgress?.('Descargando MP4 final...');
  const dlRes = await fetch(`/api/export/${jobId}/download`);
  if (!dlRes.ok) {
    throw new Error(await safeErrorMessage(dlRes, 'Error descargando el archivo MP4 final.'));
  }
  const mp4Blob = await dlRes.blob();
  const url = URL.createObjectURL(mp4Blob);
  const a = document.createElement('a');
  a.href = url;
  const slug =
    project.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'cinecraft-video';
  a.download = `${slug}.mp4`;
  a.click();
  URL.revokeObjectURL(url);
}
