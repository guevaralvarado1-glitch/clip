import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const TEMP_ROOT = path.join(os.tmpdir(), 'cinecraft-studio');
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const upload = multer({
  dest: path.join(TEMP_ROOT, 'uploads'),
  limits: { fileSize: 250 * 1024 * 1024 },
});

function getAiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no está configurada en el servidor.');
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getAiBetaClient(): GoogleGenAI {
  return getAiClient('v1beta');
}

function isTransientAiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('429') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT')
  );
}

async function withGeminiRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransientAiError(err)) {
        const delayMs = 1500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function formatAiError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
    return 'El servicio de IA está saturado temporalmente (503). Intenta nuevamente en unos segundos.';
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return 'Se alcanzó el límite temporal de solicitudes gratuitas de IA (429). Espera un momento e inténtalo de nuevo.';
  }
  return raw || fallback;
}

async function generateWithFallback(
  ai: GoogleGenAI,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contents: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseSchema?: any,
  timeoutMs = 15000
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildConfig = (level: ThinkingLevel): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = { thinkingConfig: { thinkingLevel: level } };
    if (responseSchema) {
      cfg.responseMimeType = 'application/json';
      cfg.responseSchema = responseSchema;
    }
    return cfg;
  };

  const runWithTimeout = async (model: string, level: ThinkingLevel, ms: number): Promise<string> => {
    const callPromise = ai.models.generateContent({
      model,
      contents,
      config: buildConfig(level),
    });
    const timerPromise = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('ETIMEDOUT_PRIMARY_MODEL')), ms)
    );
    const resp = await Promise.race([callPromise, timerPromise]);
    return (resp.text ?? '').trim();
  };

  try {
    return await runWithTimeout('gemini-4-hydrogen', ThinkingLevel.LOW, timeoutMs);
  } catch (primaryErr) {
    const msg = primaryErr instanceof Error ? primaryErr.message : '';
    if (!isTransientAiError(primaryErr) && msg !== 'ETIMEDOUT_PRIMARY_MODEL') {
      throw primaryErr;
    }

    const fallbackPlan: Array<{ model: string; level: ThinkingLevel; delayMs: number; waitMs: number }> = [
      { model: 'gemini-3.1-flash-lite', level: ThinkingLevel.MINIMAL, delayMs: 800, waitMs: 30000 },
      { model: 'gemini-3.1-flash-lite', level: ThinkingLevel.MINIMAL, delayMs: 2500, waitMs: 30000 },
      { model: 'gemini-4-hydrogen', level: ThinkingLevel.LOW, delayMs: 4000, waitMs: 30000 },
      { model: 'gemini-3.1-flash-lite', level: ThinkingLevel.MINIMAL, delayMs: 6000, waitMs: 35000 },
    ];

    let lastErr: unknown = primaryErr;
    for (const step of fallbackPlan) {
      await new Promise((r) => setTimeout(r, step.delayMs));
      try {
        return await runWithTimeout(step.model, step.level, step.waitMs);
      } catch (err) {
        lastErr = err;
        const errMsg = err instanceof Error ? err.message : '';
        if (!isTransientAiError(err) && errMsg !== 'ETIMEDOUT_PRIMARY_MODEL') {
          throw err;
        }
      }
    }
    throw lastErr;
  }
}

function getResolutionDims(aspectRatio: string, resolution: string): { width: number; height: number } {
  const is1080 = resolution === '1080p';
  if (aspectRatio === '9:16') {
    return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  }
  return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
}

function buildColorGradeFilter(grade: string | undefined): string | null {
  switch (grade) {
    case 'cinema_warm':
      return 'eq=contrast=1.08:saturation=1.12,colorbalance=rs=0.06:gs=0.01:bs=-0.06:rm=0.04:bm=-0.04';
    case 'noir':
      return 'hue=s=0,eq=contrast=1.22:brightness=-0.02';
    case 'cool_film':
      return 'eq=contrast=1.06:saturation=0.92,colorbalance=rs=-0.05:gs=0.01:bs=0.08:rm=-0.03:bm=0.05';
    case 'vibrant':
      return 'eq=contrast=1.10:saturation=1.32:brightness=0.02';
    default:
      return null;
  }
}

function buildZoompanFilter(
  motion: string | undefined,
  width: number,
  height: number,
  durationSec: number,
  fps = 30
): string {
  const frames = Math.max(30, Math.round(durationSec * fps));
  const upW = width * 2;
  const upH = height * 2;
  const preScale = `scale=${upW}:${upH}:force_original_aspect_ratio=increase,crop=${upW}:${upH},setsar=1`;

  switch (motion) {
    case 'zoom_in':
      return `${preScale},zoompan=z='min(1.0+0.20*(on/${frames}),1.20)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'zoom_out':
      return `${preScale},zoompan=z='max(1.20-0.20*(on/${frames}),1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'pan_left':
      return `${preScale},zoompan=z='1.15':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'pan_right':
      return `${preScale},zoompan=z='1.15':x='(iw-iw/zoom)*(on/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'ken_burns':
      return `${preScale},zoompan=z='min(1.0+0.18*(on/${frames}),1.18)':x='(iw-iw/zoom)*0.35*(on/${frames})':y='(ih-ih/zoom)*0.25*(on/${frames})':d=${frames}:s=${width}x${height}:fps=${fps}`;
    case 'static':
    default:
      return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`;
  }
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} falló (código ${code}): ${stderr.slice(-800)}`));
      }
    });
  });
}

async function probeMedia(filePath: string): Promise<{ duration: number; hasAudio: boolean; hasVideo: boolean }> {
  try {
    const { stdout } = await runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type',
      '-of',
      'json',
      filePath,
    ]);
    const parsed = JSON.parse(stdout);
    const duration = Number(parsed?.format?.duration) || 0;
    const streams: Array<{ codec_type?: string }> = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const hasAudio = streams.some((s) => s.codec_type === 'audio');
    const hasVideo = streams.some((s) => s.codec_type === 'video');
    return { duration, hasAudio, hasVideo };
  } catch {
    return { duration: 0, hasAudio: false, hasVideo: false };
  }
}

function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function estimateWavDuration(wavBuffer: Buffer): number {
  if (wavBuffer.length <= 44) return 0;
  // Standard Gemini TTS WAV: 24kHz, mono, 16-bit = 48,000 bytes/sec
  const byteRate = wavBuffer.readUInt32LE(28) || 48000;
  const dataBytes = wavBuffer.length - 44;
  return Math.max(0.5, Number((dataBytes / byteRate).toFixed(2)));
}

async function safeUnlink(filePath: string | undefined) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore cleanup errors
  }
}

async function safeRmDir(dirPath: string | undefined) {
  if (!dirPath) return;
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

const FONT_PATH = '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // 0A. Autonomous Director Planner (async job + sync compatibility, with fast fallback)
  interface AutoPlanJob {
    status: 'running' | 'done' | 'error';
    plan?: unknown;
    error?: string;
    createdAt: number;
  }
  const PLAN_JOBS_DIR = path.join(TEMP_ROOT, 'plan-jobs');
  fs.mkdirSync(PLAN_JOBS_DIR, { recursive: true });
  const autoPlanJobs = new Map<string, AutoPlanJob>();

  async function savePlanJob(jobId: string, job: AutoPlanJob) {
    autoPlanJobs.set(jobId, job);
    try {
      await fsp.writeFile(path.join(PLAN_JOBS_DIR, `${jobId}.json`), JSON.stringify(job), 'utf8');
    } catch {
      // ignore disk cache error
    }
  }

  async function loadPlanJob(jobId: string): Promise<AutoPlanJob | undefined> {
    const mem = autoPlanJobs.get(jobId);
    if (mem) return mem;
    try {
      const raw = await fsp.readFile(path.join(PLAN_JOBS_DIR, `${jobId}.json`), 'utf8');
      const parsed = JSON.parse(raw) as AutoPlanJob;
      autoPlanJobs.set(jobId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  async function runAutoPlan(
    idea: string,
    language = 'es-ES',
    userMedia: Array<{ index: number; mediaType: string; description: string; durationSec?: number }> = []
  ): Promise<unknown> {
    const ai = getAiClient();
    const langName = language.startsWith('en') ? 'Inglés' : language.startsWith('pt') ? 'Portugués' : 'Español';
    const mediaContext =
      Array.isArray(userMedia) && userMedia.length > 0
        ? `El usuario subió ${userMedia.length} archivos propios (úsalos donde mejor encajen asignando matchedMediaIndex de 0 a ${userMedia.length - 1}, o -1 si la escena debe buscar un visual automático):\n` +
          userMedia
            .map(
              (m) =>
                `- Archivo [${m.index}] (${m.mediaType}${m.durationSec ? `, ${Math.round(m.durationSec)}s` : ''}): ${m.description}`
            )
            .join('\n')
        : 'El usuario no subió archivos propios; todas las escenas deben usar matchedMediaIndex = -1 y un searchQuery excelente.';

    const prompt = `Eres un director de cine y productor ejecutivo autónomo.
El usuario te da únicamente esta idea:
"""
${idea.trim()}
"""

Idioma del contenido: ${langName}.
${mediaContext}

Toma TODAS las decisiones creativas apropiadas según la idea:
1. Decide aspectRatio: usa "9:16" si menciona TikTok, Reels, Shorts, vertical o formato corto para redes; en caso contrario usa "16:9".
2. Decide mode: entre "story", "documentary", "commercial", "music_video", "image_sequence".
3. Decide la duración total apropiada según lo que pide la idea (entre 35 segundos y 240 segundos si pide un video largo; por defecto ~60-90s si no especifica). Divide en escenas de 6 a 14 segundos cada una (entre 4 y 14 escenas).
4. Decide musicMood: entre "calm_ambient", "epic_pulse", "warm_documentary", "mystery_dark", "upbeat_commercial".
5. Crea de 1 a 3 personajes en characters (al menos "Narrador" con voz "Charon" o "Kore"; voces válidas: Charon, Kore, Puck, Fenrir, Zephyr).
6. Para cada escena:
   - "searchQuery": 2 a 4 palabras clave EN INGLÉS muy visuales y concretas para encontrar una foto o video real en un banco multimedia (ej. "deep ocean bioluminescence", "barista pouring espresso", "ancient roman colosseum").
   - "cameraMotion": elige entre zoom_in, zoom_out, pan_left, pan_right, ken_burns.
   - "colorGrade": elige entre none, cinema_warm, noir, cool_film, vibrant.
   - "narration": texto natural con ~2.2 palabras por segundo para caber en durationSec.
   - "matchedMediaIndex": índice entero del archivo subido por el usuario que mejor encaja, o -1 si no aplica.`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        description: { type: Type.STRING },
        mode: { type: Type.STRING },
        aspectRatio: { type: Type.STRING },
        visualStyle: { type: Type.STRING },
        transitionType: { type: Type.STRING },
        musicMood: { type: Type.STRING },
        characters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              role: { type: Type.STRING },
              visualDescription: { type: Type.STRING },
              voice: { type: Type.STRING },
              voiceStyle: { type: Type.STRING },
            },
            required: ['name', 'role', 'visualDescription', 'voice', 'voiceStyle'],
          },
        },
        scenes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              visualDirection: { type: Type.STRING },
              searchQuery: { type: Type.STRING },
              narration: { type: Type.STRING },
              speakerName: { type: Type.STRING },
              voice: { type: Type.STRING },
              voiceStyle: { type: Type.STRING },
              durationSec: { type: Type.NUMBER },
              cameraMotion: { type: Type.STRING },
              colorGrade: { type: Type.STRING },
              subtitleText: { type: Type.STRING },
              overlayCaption: { type: Type.STRING },
              matchedMediaIndex: { type: Type.INTEGER },
            },
            required: [
              'title',
              'visualDirection',
              'searchQuery',
              'narration',
              'speakerName',
              'voice',
              'voiceStyle',
              'durationSec',
              'cameraMotion',
              'colorGrade',
              'subtitleText',
              'overlayCaption',
              'matchedMediaIndex',
            ],
          },
        },
      },
      required: [
        'title',
        'description',
        'mode',
        'aspectRatio',
        'visualStyle',
        'transitionType',
        'musicMood',
        'characters',
        'scenes',
      ],
    };

    const rawPlan = await generateWithFallback(ai, prompt, responseSchema, 15000);
    return JSON.parse(rawPlan || '{}');
  }

  app.post('/api/ai/auto-plan/start', async (req, res) => {
    const { idea, language = 'es-ES', userMedia = [] } = req.body ?? {};
    if (!idea || typeof idea !== 'string' || !idea.trim()) {
      res.status(400).json({ error: 'Escribe una idea para iniciar el Piloto Automático.' });
      return;
    }

    const jobId = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await savePlanJob(jobId, { status: 'running', createdAt: Date.now() });

    runAutoPlan(idea, language, userMedia)
      .then((plan) => savePlanJob(jobId, { status: 'done', plan, createdAt: Date.now() }))
      .catch((error) =>
        savePlanJob(jobId, {
          status: 'error',
          error: formatAiError(error, 'Error en la planificación autónoma.'),
          createdAt: Date.now(),
        })
      );

    res.json({ jobId });
  });

  app.get('/api/ai/auto-plan/:jobId/status', async (req, res) => {
    const job = await loadPlanJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Planificación no encontrada.' });
      return;
    }
    if (job.status === 'done') {
      const plan = job.plan;
      autoPlanJobs.delete(req.params.jobId);
      await safeUnlink(path.join(PLAN_JOBS_DIR, `${req.params.jobId}.json`));
      res.json({ status: 'done', plan });
      return;
    }
    if (job.status === 'error') {
      const error = job.error;
      autoPlanJobs.delete(req.params.jobId);
      await safeUnlink(path.join(PLAN_JOBS_DIR, `${req.params.jobId}.json`));
      res.json({ status: 'error', error });
      return;
    }
    res.json({ status: 'running' });
  });

  app.post('/api/ai/auto-plan', async (req, res) => {
    try {
      const { idea, language = 'es-ES', userMedia = [] } = req.body ?? {};
      if (!idea || typeof idea !== 'string' || !idea.trim()) {
        res.status(400).json({ error: 'Escribe una idea para iniciar el Piloto Automático.' });
        return;
      }
      const plan = await runAutoPlan(idea, language, userMedia);
      res.json(plan);
    } catch (error) {
      res.status(500).json({ error: formatAiError(error, 'Error en la planificación autónoma.') });
    }
  });

  // 0B. Multimodal User Media Analyzer (understands uploaded unordered photos & videos)
  app.post('/api/ai/analyze-media', upload.array('files', 20), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    const tempThumbs: string[] = [];

    try {
      if (files.length === 0) {
        res.json({ items: [] });
        return;
      }

      const ai = getAiClient();
      const results: Array<{
        index: number;
        originalName: string;
        mediaType: 'image' | 'video';
        durationSec: number;
        description: string;
      }> = [];

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const isVideo = f.mimetype.startsWith('video/');
        let imgPath = f.path;
        let mimeType = f.mimetype || 'image/jpeg';
        let durationSec = 0;

        if (isVideo) {
          const probe = await probeMedia(f.path);
          durationSec = Math.max(2, probe.duration || 6);
          const thumbPath = `${f.path}_thumb.jpg`;
          tempThumbs.push(thumbPath);
          await runCommand('ffmpeg', [
            '-y',
            '-ss',
            String(Math.min(1.0, durationSec * 0.25)),
            '-i',
            f.path,
            '-vframes',
            '1',
            '-q:v',
            '3',
            thumbPath,
          ]);
          imgPath = thumbPath;
          mimeType = 'image/jpeg';
        }

        const imgBuf = await fsp.readFile(imgPath);
        const resp = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: mimeType.startsWith('image/') ? mimeType : 'image/jpeg',
                  data: imgBuf.toString('base64'),
                },
              },
              {
                text: 'Describe brevemente en 1 frase qué muestra esta imagen/escena, su ambiente y qué momento narrativo podría representar.',
              },
            ],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });

        results.push({
          index: i,
          originalName: f.originalname,
          mediaType: isVideo ? 'video' : 'image',
          durationSec,
          description: (resp.text || f.originalname).trim(),
        });
      }

      res.json({ items: results });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al analizar los archivos subidos.';
      res.status(500).json({ error: message });
    } finally {
      for (const f of files) await safeUnlink(f.path);
      for (const t of tempThumbs) await safeUnlink(t);
    }
  });

  // 0B-bis. Fast Thumbnail Analyzer (accepts lightweight browser-extracted JPEG previews < 100KB)
  app.post('/api/ai/analyze-thumbnails', async (req, res) => {
    try {
      const items: Array<{
        index: number;
        originalName: string;
        mediaType: 'image' | 'video';
        durationSec: number;
        thumbnailBase64: string;
      }> = Array.isArray(req.body?.items) ? req.body.items : [];

      if (items.length === 0) {
        res.json({ items: [] });
        return;
      }

      const ai = getAiClient();
      const analyzed = await Promise.all(
        items.map(async (item) => {
          if (!item.thumbnailBase64) {
            return {
              index: item.index,
              originalName: item.originalName,
              mediaType: item.mediaType,
              durationSec: item.durationSec,
              description: item.originalName,
            };
          }
          const text = await generateWithFallback(
            ai,
            {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: item.thumbnailBase64,
                  },
                },
                {
                  text: 'Describe brevemente en 1 frase qué muestra esta imagen/escena, su ambiente y qué momento narrativo podría representar.',
                },
              ],
            },
            undefined,
            12000
          );
          return {
            index: item.index,
            originalName: item.originalName,
            mediaType: item.mediaType,
            durationSec: item.durationSec,
            description: (text || item.originalName).trim(),
          };
        })
      );

      res.json({ items: analyzed });
    } catch (error) {
      res.status(500).json({ error: formatAiError(error, 'Error al analizar las miniaturas.') });
    }
  });

  // 0C. Hybrid Stock Media Fetcher (Pexels API if PEXELS_API_KEY exists, otherwise keyless Wikimedia Commons)
  app.post('/api/media/fetch-stock', async (req, res) => {
    try {
      const { query, aspectRatio = '16:9', preferVideo = true } = req.body ?? {};
      const cleanQuery = String(query || '').trim();
      if (!cleanQuery) {
        res.status(400).json({ error: 'Consulta visual requerida.' });
        return;
      }

      const pexelsKey = (process.env.PEXELS_API_KEY || '').trim();
      const orientation = aspectRatio === '9:16' ? 'portrait' : 'landscape';

      // 1. Try Pexels if key is configured
      if (pexelsKey) {
        if (preferVideo) {
          const vidResp = await fetch(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(cleanQuery)}&orientation=${orientation}&per_page=4`,
            { headers: { Authorization: pexelsKey } }
          );
          if (vidResp.ok) {
            const vidData = await vidResp.json();
            const firstVid = vidData?.videos?.[0];
            const files: Array<{ link: string; width?: number; file_type?: string }> =
              firstVid?.video_files || [];
            const mp4 =
              files.find((vf) => vf.file_type === 'video/mp4' && (vf.width || 0) >= 720 && (vf.width || 0) <= 1920) ||
              files.find((vf) => vf.file_type === 'video/mp4') ||
              files[0];

            if (mp4?.link) {
              const bin = await fetch(mp4.link);
              if (bin.ok) {
                const buf = Buffer.from(await bin.arrayBuffer());
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('X-Media-Kind', 'video');
                res.setHeader('X-Media-Source', 'pexels');
                res.send(buf);
                return;
              }
            }
          }
        }

        const photoResp = await fetch(
          `https://api.pexels.com/v1/search?query=${encodeURIComponent(cleanQuery)}&orientation=${orientation}&per_page=4`,
          { headers: { Authorization: pexelsKey } }
        );
        if (photoResp.ok) {
          const photoData = await photoResp.json();
          const url = photoData?.photos?.[0]?.src?.large2x || photoData?.photos?.[0]?.src?.large;
          if (url) {
            const bin = await fetch(url);
            if (bin.ok) {
              const buf = Buffer.from(await bin.arrayBuffer());
              res.setHeader('Content-Type', 'image/jpeg');
              res.setHeader('X-Media-Kind', 'image');
              res.setHeader('X-Media-Source', 'pexels');
              res.send(buf);
              return;
            }
          }
        }
      }

      // 2. Default keyless fallback: Wikimedia Commons public API
      const tryWikimedia = async (q: string): Promise<{ buf: Buffer; mime: string } | null> => {
        const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
          `${q} filetype:bitmap`
        )}&gsrlimit=8&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1280&format=json&origin=*`;
        const resp = await fetch(apiUrl, {
          headers: { 'User-Agent': 'CineCraftStudio/1.0 (https://aistudio.google.com)' },
        });
        if (!resp.ok) return null;
        const json = await resp.json();
        const pages = Object.values(json?.query?.pages || {}) as Array<{
          imageinfo?: Array<{
            url?: string;
            thumburl?: string;
            mime?: string;
            width?: number;
          }>;
        }>;

        for (const p of pages) {
          const info = p.imageinfo?.[0];
          if (!info) continue;
          const mime = info.mime || '';
          if (mime !== 'image/jpeg' && mime !== 'image/png') continue;
          if ((info.width || 0) < 500) continue;
          const targetUrl = info.thumburl || info.url;
          if (!targetUrl) continue;
          const imgRes = await fetch(targetUrl, {
            headers: { 'User-Agent': 'CineCraftStudio/1.0 (https://aistudio.google.com)' },
          });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (buf.length > 8000) {
              return { buf, mime };
            }
          }
        }
        return null;
      };

      let found = await tryWikimedia(cleanQuery);
      if (!found) {
        const shorter = cleanQuery.split(/\s+/).slice(0, 2).join(' ');
        if (shorter && shorter !== cleanQuery) {
          found = await tryWikimedia(shorter);
        }
      }

      if (found) {
        res.setHeader('Content-Type', found.mime);
        res.setHeader('X-Media-Kind', 'image');
        res.setHeader('X-Media-Source', 'wikimedia');
        res.send(found.buf);
        return;
      }

      res.status(404).json({ error: 'No se encontró media automática para esta consulta.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al buscar media automática.';
      res.status(500).json({ error: message });
    }
  });

  // 0D. Procedural Ambient Soundtrack Generator (FFmpeg local audio synthesis, zero paid API cost)
  app.post('/api/media/generate-music', async (req, res) => {
    const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'music-'));
    try {
      const mood = String(req.body?.mood || 'warm_documentary');
      const durationSec = Math.max(15, Math.min(60, Number(req.body?.durationSec) || 30));
      const outPath = path.join(workDir, 'ambient.mp3');

      const moodExpr: Record<string, { expr: string; lowpass: number; echo: string }> = {
        calm_ambient: {
          expr: '0.16*sin(2*PI*130.81*t)*(0.6+0.4*sin(2*PI*0.12*t))+0.12*sin(2*PI*196.00*t)+0.10*sin(2*PI*246.94*t)*(0.5+0.5*cos(2*PI*0.09*t))+0.08*sin(2*PI*293.66*t)',
          lowpass: 650,
          echo: 'aecho=0.8:0.85:180|340:0.35|0.25',
        },
        warm_documentary: {
          expr: '0.16*sin(2*PI*146.83*t)+0.12*sin(2*PI*220.00*t)*(0.65+0.35*sin(2*PI*0.18*t))+0.10*sin(2*PI*293.66*t)+0.08*sin(2*PI*369.99*t)*(0.5+0.5*sin(2*PI*0.11*t))',
          lowpass: 780,
          echo: 'aecho=0.8:0.8:140|280:0.30|0.20',
        },
        epic_pulse: {
          expr: '0.20*sin(2*PI*110.00*t)*(0.55+0.45*sin(2*PI*1.5*t))+0.14*sin(2*PI*164.81*t)+0.11*sin(2*PI*220.00*t)*(0.5+0.5*sin(2*PI*0.75*t))+0.07*sin(2*PI*329.63*t)',
          lowpass: 920,
          echo: 'aecho=0.8:0.75:120|240:0.28|0.18',
        },
        mystery_dark: {
          expr: '0.18*sin(2*PI*73.42*t)+0.13*sin(2*PI*110.00*t)*(0.6+0.4*sin(2*PI*0.15*t))+0.10*sin(2*PI*174.61*t)*(0.5+0.5*cos(2*PI*0.08*t))+0.06*sin(2*PI*220.00*t)',
          lowpass: 540,
          echo: 'aecho=0.8:0.88:220|420:0.40|0.28',
        },
        upbeat_commercial: {
          expr: '0.15*sin(2*PI*174.61*t)*(0.55+0.45*sin(2*PI*2.0*t))+0.12*sin(2*PI*220.00*t)+0.10*sin(2*PI*261.63*t)*(0.6+0.4*cos(2*PI*1.0*t))+0.08*sin(2*PI*329.63*t)',
          lowpass: 1100,
          echo: 'aecho=0.8:0.7:90|180:0.22|0.15',
        },
      };

      const cfg = moodExpr[mood] || moodExpr.warm_documentary;
      const fadeOutStart = Math.max(1, durationSec - 2.5);
      const filter = `lowpass=f=${cfg.lowpass},${cfg.echo},afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutStart.toFixed(
        2
      )}:d=2.5`;

      await runCommand('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${cfg.expr}:s=44100:d=${durationSec}`,
        '-af',
        filter,
        '-ac',
        '2',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '160k',
        outPath,
      ]);

      const buf = await fsp.readFile(outPath);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buf);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al generar música ambiental.';
      res.status(500).json({ error: message });
    } finally {
      await safeRmDir(workDir);
    }
  });

  // 1. AI Storyboard & Script Generator (async job polling + fast fallback)
  async function runStoryboard(body: {
    topicOrScript?: string;
    mode?: string;
    targetDurationSec?: number;
    aspectRatio?: string;
    visualStyle?: string;
    characters?: Array<{ name: string; role: string; visualDescription: string; voice: string }>;
    language?: string;
  }): Promise<unknown> {
    const {
      topicOrScript = '',
      mode = 'story',
      targetDurationSec = 60,
      aspectRatio = '16:9',
      visualStyle = 'Cinematográfico realista',
      characters = [],
      language = 'es-ES',
    } = body ?? {};

    const ai = getAiClient();
    const approxScenes = Math.max(3, Math.min(18, Math.round(Number(targetDurationSec) / 10)));
    const charList = Array.isArray(characters) && characters.length > 0
      ? characters.map((c) => `- ${c.name} (${c.role}): ${c.visualDescription}. Voz sugerida: ${c.voice}`).join('\n')
      : 'Sin personajes predefinidos (usa Narrador por defecto).';

    const modeInstructions: Record<string, string> = {
      story: 'Narrativa cinematográfica con inicio, desarrollo, clímax y cierre emocional.',
      documentary: 'Estilo documental informativo con datos claros, ritmo pausado y tomas descriptivas.',
      commercial: 'Video comercial dinámico enfocado en beneficios, problema/solución y llamado a la acción.',
      music_video: 'Estructura rítmica y poética pensada para acompañar música de fondo.',
      image_sequence: 'Secuencia visual contemplativa con descripciones claras para animar imágenes.',
    };

    const prompt = `Eres un director de cine y guionista profesional.
Crea un storyboard completo para un video en formato ${aspectRatio} (${modeInstructions[mode] || modeInstructions.story}).
Duración total objetivo aproximada: ${targetDurationSec} segundos (divide en aproximadamente ${approxScenes} escenas de 6 a 15 segundos cada una).
Estilo visual del proyecto: ${visualStyle}.
Idioma del guion y narración: ${language.startsWith('en') ? 'Inglés' : language.startsWith('pt') ? 'Portugués' : 'Español'}.

Personajes disponibles en la Biblia del proyecto:
${charList}

Idea o guion del usuario:
"""
${topicOrScript.trim()}
"""

Reglas:
- Ajusta la longitud de la narración de cada escena para que quepa cómodamente en su durationSec (aprox. 2.2 palabras por segundo).
- Varía los movimientos de cámara entre: zoom_in, zoom_out, pan_left, pan_right, ken_burns.
- Elige un colorGrade adecuado entre: none, cinema_warm, noir, cool_film, vibrant.
- Asigna speakerName usando uno de los personajes si encaja, o "Narrador".
- subtitleText debe ser una versión limpia y concisa de la narración para subtítulos en pantalla.`;

    const rawJson = await generateWithFallback(
      ai,
      prompt,
      {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          scenes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                visualDirection: { type: Type.STRING },
                narration: { type: Type.STRING },
                speakerName: { type: Type.STRING },
                voiceStyle: { type: Type.STRING },
                durationSec: { type: Type.NUMBER },
                cameraMotion: { type: Type.STRING },
                colorGrade: { type: Type.STRING },
                subtitleText: { type: Type.STRING },
              },
              required: [
                'title',
                'visualDirection',
                'narration',
                'speakerName',
                'voiceStyle',
                'durationSec',
                'cameraMotion',
                'colorGrade',
                'subtitleText',
              ],
            },
          },
        },
        required: ['title', 'summary', 'scenes'],
      },
      15000
    );

    return JSON.parse(rawJson || '{}');
  }

  app.post('/api/ai/storyboard/start', async (req, res) => {
    const topicOrScript = req.body?.topicOrScript;
    if (!topicOrScript || typeof topicOrScript !== 'string' || !topicOrScript.trim()) {
      res.status(400).json({ error: 'Escribe una idea o guion para generar el storyboard.' });
      return;
    }

    const jobId = `sb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await savePlanJob(jobId, { status: 'running', createdAt: Date.now() });

    runStoryboard(req.body)
      .then((plan) => savePlanJob(jobId, { status: 'done', plan, createdAt: Date.now() }))
      .catch((error) =>
        savePlanJob(jobId, {
          status: 'error',
          error: formatAiError(error, 'Error al generar el storyboard.'),
          createdAt: Date.now(),
        })
      );

    res.json({ jobId });
  });

  app.get('/api/ai/storyboard/:jobId/status', async (req, res) => {
    const job = await loadPlanJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Storyboard no encontrado.' });
      return;
    }
    if (job.status === 'done') {
      const data = job.plan;
      autoPlanJobs.delete(req.params.jobId);
      await safeUnlink(path.join(PLAN_JOBS_DIR, `${req.params.jobId}.json`));
      res.json({ status: 'done', data });
      return;
    }
    if (job.status === 'error') {
      const error = job.error;
      autoPlanJobs.delete(req.params.jobId);
      await safeUnlink(path.join(PLAN_JOBS_DIR, `${req.params.jobId}.json`));
      res.json({ status: 'error', error });
      return;
    }
    res.json({ status: 'running' });
  });

  app.post('/api/ai/storyboard', async (req, res) => {
    try {
      const topicOrScript = req.body?.topicOrScript;
      if (!topicOrScript || typeof topicOrScript !== 'string' || !topicOrScript.trim()) {
        res.status(400).json({ error: 'Escribe una idea o guion para generar el storyboard.' });
        return;
      }
      const parsed = await runStoryboard(req.body);
      res.json(parsed);
    } catch (error) {
      res.status(500).json({ error: formatAiError(error, 'Error al generar el storyboard.') });
    }
  });

  // 2. AI Scene Refiner / Extender (gemini-4-hydrogen)
  app.post('/api/ai/refine-scene', async (req, res) => {
    try {
      const { scene, instruction, action = 'rewrite', visualStyle = 'Cinematográfico', language = 'es-ES' } = req.body ?? {};
      if (!scene) {
        res.status(400).json({ error: 'Escena requerida.' });
        return;
      }

      const ai = getAiClient();
      const langName = language.startsWith('en') ? 'Inglés' : language.startsWith('pt') ? 'Portugués' : 'Español';

      if (action === 'extend') {
        const prompt = `Eres un director de cine continuando un video largo.
Estilo visual: ${visualStyle}. Idioma: ${langName}.
Escena actual:
- Título: ${scene.title}
- Dirección visual: ${scene.visualDirection}
- Narración: ${scene.narration}

Instrucción adicional del usuario (opcional): ${instruction || 'Continúa la escena de forma fluida y natural.'}

Genera exactamente 2 escenas de continuación que den continuidad narrativa y visual directa a esta escena.`;

        const rawJson = await generateWithFallback(
          ai,
          prompt,
          {
            type: Type.OBJECT,
            properties: {
              scenes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    visualDirection: { type: Type.STRING },
                    narration: { type: Type.STRING },
                    speakerName: { type: Type.STRING },
                    voiceStyle: { type: Type.STRING },
                    durationSec: { type: Type.NUMBER },
                    cameraMotion: { type: Type.STRING },
                    colorGrade: { type: Type.STRING },
                    subtitleText: { type: Type.STRING },
                  },
                  required: [
                    'title',
                    'visualDirection',
                    'narration',
                    'speakerName',
                    'voiceStyle',
                    'durationSec',
                    'cameraMotion',
                    'colorGrade',
                    'subtitleText',
                  ],
                },
              },
            },
            required: ['scenes'],
          },
          15000
        );
        res.json(JSON.parse(rawJson || '{}'));
        return;
      }

      const prompt = `Reescribe o adapta esta escena de video según la instrucción del usuario.
Idioma: ${langName}. Estilo visual: ${visualStyle}.
Escena actual:
- Título: ${scene.title}
- Dirección visual: ${scene.visualDirection}
- Narración: ${scene.narration}
- Duración: ${scene.durationSec}s
- Movimiento de cámara: ${scene.cameraMotion}
- Color: ${scene.colorGrade}

Instrucción del usuario: "${instruction || 'Mejora el ritmo narrativo y el detalle visual.'}"`;

      const rawJson = await generateWithFallback(
        ai,
        prompt,
        {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            visualDirection: { type: Type.STRING },
            narration: { type: Type.STRING },
            voiceStyle: { type: Type.STRING },
            durationSec: { type: Type.NUMBER },
            cameraMotion: { type: Type.STRING },
            colorGrade: { type: Type.STRING },
            subtitleText: { type: Type.STRING },
          },
          required: [
            'title',
            'visualDirection',
            'narration',
            'voiceStyle',
            'durationSec',
            'cameraMotion',
            'colorGrade',
            'subtitleText',
          ],
        },
        15000
      );
      res.json({ scene: JSON.parse(rawJson || '{}') });
    } catch (error) {
      res.status(500).json({ error: formatAiError(error, 'Error al refinar la escena.') });
    }
  });

  // 3. AI Speech Generation (TTS single & multi-speaker)
  app.post('/api/ai/tts', async (req, res) => {
    try {
      const {
        text,
        voice = 'Kore',
        voiceStyle = 'Narrador cinematográfico claro y expresivo',
        language = 'es-ES',
        isDialogue = false,
        dialogueLines = [],
      } = req.body ?? {};

      const ai = getAiBetaClient();

      if (isDialogue && Array.isArray(dialogueLines) && dialogueLines.length > 0) {
        const speakerMap = new Map<string, string>();
        for (const line of dialogueLines) {
          if (line.speaker && !speakerMap.has(line.speaker)) {
            speakerMap.set(line.speaker, line.voice || 'Kore');
          }
        }
        const speakers = Array.from(speakerMap.entries()).slice(0, 4).map(([speaker, v]) => ({
          speaker,
          voice: v,
        }));

        const inputBlocks = dialogueLines
          .filter((l: { text?: string }) => l.text && l.text.trim())
          .map((l: { speaker: string; text: string; style?: string }) => ({
            type: 'text' as const,
            text: `${l.speaker}: ${l.text.trim()}`,
            annotations: [
              {
                type: 'speech_metadata' as const,
                speaker: l.speaker,
                style: l.style || 'Natural conversational delivery',
              },
            ],
          }));

        if (inputBlocks.length === 0) {
          res.status(400).json({ error: 'Agrega líneas de diálogo para generar el audio.' });
          return;
        }

        const interaction = await withGeminiRetry(() =>
          ai.interactions.create({
            model: 'gemini-3.8-flash-tts',
            input: inputBlocks,
            response_format: { type: 'audio' },
            generation_config: {
              speech_config: {
                speakers,
              },
            },
          })
        );

        const audio = interaction.output_audio;
        if (!audio?.data) {
          throw new Error('No se recibió audio del modelo de diálogo.');
        }
        const wavBuf = Buffer.from(audio.data, 'base64');
        res.json({
          audioBase64: audio.data,
          mimeType: audio.mime_type || 'audio/wav',
          durationSec: estimateWavDuration(wavBuf),
        });
        return;
      }

      if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'El texto de narración está vacío.' });
        return;
      }

      const interaction = await withGeminiRetry(() =>
        ai.interactions.create({
          model: 'gemini-3.8-flash-lite-tts',
          input: [
            {
              type: 'text',
              text: text.trim(),
              annotations: [
                {
                  type: 'speech_metadata',
                  style: voiceStyle,
                },
              ],
            },
          ],
          response_format: { type: 'audio' },
          generation_config: {
            speech_config: [
              {
                language,
                voice,
              },
            ],
          },
        })
      );

      const audio = interaction.output_audio;
      if (!audio?.data) {
        throw new Error('No se recibió audio del modelo TTS.');
      }
      const wavBuf = Buffer.from(audio.data, 'base64');
      res.json({
        audioBase64: audio.data,
        mimeType: audio.mime_type || 'audio/wav',
        durationSec: estimateWavDuration(wavBuf),
      });
    } catch (error) {
      res.status(500).json({ error: formatAiError(error, 'Error al generar voz con IA.') });
    }
  });

  // 4. AI Audio/Video Transcription & Timed Subtitles (gemini-3.5-transcribe + gemini-4-hydrogen)
  app.post('/api/ai/transcribe', upload.single('file'), async (req, res) => {
    const uploadedPath = req.file?.path;
    const tempAudioPath = uploadedPath ? `${uploadedPath}_audio.mp3` : undefined;

    try {
      if (!req.file || !uploadedPath) {
        res.status(400).json({ error: 'Sube un archivo de audio o video para transcribir.' });
        return;
      }

      const probed = await probeMedia(uploadedPath);
      const origExt = path.extname(req.file.originalname || '').toLowerCase();
      const extMimeMap: Record<string, string> = {
        '.mp3': 'audio/mp3',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.webm': 'audio/webm',
      };
      const rawMime = req.file.mimetype && req.file.mimetype !== 'application/octet-stream'
        ? req.file.mimetype
        : (extMimeMap[origExt] || '');
      const isVideo = rawMime.startsWith('video/') || (probed.hasVideo && !rawMime.startsWith('audio/'));

      let audioPath = uploadedPath;
      let mimeType = rawMime.startsWith('audio/') ? rawMime : 'audio/mp3';

      if (isVideo || !rawMime.startsWith('audio/')) {
        if (!probed.hasAudio) {
          res.status(400).json({ error: 'El archivo subido no contiene pista de audio para transcribir.' });
          return;
        }
        await runCommand('ffmpeg', [
          '-y',
          '-i',
          uploadedPath,
          '-vn',
          '-acodec',
          'libmp3lame',
          '-b:a',
          '128k',
          tempAudioPath!,
        ]);
        audioPath = tempAudioPath!;
        mimeType = 'audio/mp3';
      }

      const audioBuffer = await fsp.readFile(audioPath);
      const base64AudioData = audioBuffer.toString('base64');

      const aiBeta = getAiBetaClient();
      const ai = getAiClient();
      const interaction = await withGeminiRetry(() =>
        aiBeta.interactions.create({
          model: 'gemini-3.5-transcribe',
          input: [
            {
              type: 'audio',
              data: base64AudioData,
              mime_type: mimeType,
            },
            {
              type: 'text',
              text: 'Transcribe con precisión todo el audio hablado. Devuelve únicamente el texto transcrito.',
            },
          ],
        })
      );

      const transcript = (interaction.output_text || '').trim();
      const totalDur = Math.max(2, probed.duration || 10);

      // Segment transcript cleanly into timed subtitle cues
      let cues: Array<{ startSec: number; endSec: number; text: string }> = [];
      if (transcript) {
        const segText = await generateWithFallback(
          ai,
          `Divide esta transcripción en bloques cortos de subtítulos (máximo 10 palabras por bloque) distribuidos entre 0 y ${totalDur.toFixed(1)} segundos de forma proporcional.\n\nTranscripción:\n"""\n${transcript}\n"""`,
          {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startSec: { type: Type.NUMBER },
                endSec: { type: Type.NUMBER },
                text: { type: Type.STRING },
              },
              required: ['startSec', 'endSec', 'text'],
            },
          },
          12000
        );
        cues = JSON.parse(segText || '[]');
      }

      res.json({ transcript, durationSec: totalDur, cues });
    } catch (error) {
      res.status(500).json({ error: formatAiError(error, 'Error al transcribir el archivo.') });
    } finally {
      await safeUnlink(uploadedPath);
      await safeUnlink(tempAudioPath);
    }
  });

  // 5. Image to Video Animator (1 image or 2-image crossfade transition) via FFmpeg
  app.post(
    '/api/media/image-to-video',
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'endImage', maxCount: 1 },
    ]),
    async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const startFile = files?.image?.[0];
      const endFile = files?.endImage?.[0];
      const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'img2vid-'));

      try {
        if (!startFile) {
          res.status(400).json({ error: 'Debes enviar al menos una imagen.' });
          return;
        }

        const aspectRatio = String(req.body.aspectRatio || '16:9');
        const resolution = String(req.body.resolution || '720p');
        const durationSec = Math.max(2, Math.min(30, Number(req.body.durationSec) || 6));
        const motion = String(req.body.motion || 'ken_burns');
        const colorGrade = String(req.body.colorGrade || 'none');
        const overlayCaption = String(req.body.overlayCaption || '').trim();

        const { width, height } = getResolutionDims(aspectRatio, resolution);
        const gradeFilter = buildColorGradeFilter(colorGrade);
        const outPath = path.join(workDir, 'output.mp4');

        if (endFile) {
          // 2-frame smooth motion bridge
          const halfDur = Math.max(1.5, durationSec / 2 + 0.5);
          const xfadeDur = Math.min(1.0, halfDur * 0.4);
          const offset = Math.max(0.5, halfDur - xfadeDur);
          const seg1 = path.join(workDir, 'seg1.mp4');
          const seg2 = path.join(workDir, 'seg2.mp4');

          const f1 = [buildZoompanFilter(motion, width, height, halfDur), gradeFilter, 'format=yuv420p']
            .filter(Boolean)
            .join(',');
          const f2 = [buildZoompanFilter(motion === 'zoom_in' ? 'zoom_out' : 'zoom_in', width, height, halfDur), gradeFilter, 'format=yuv420p']
            .filter(Boolean)
            .join(',');

          await runCommand('ffmpeg', ['-y', '-i', startFile.path, '-vf', f1, '-t', String(halfDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', seg1]);
          await runCommand('ffmpeg', ['-y', '-i', endFile.path, '-vf', f2, '-t', String(halfDur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', seg2]);

          const captionFilter = overlayCaption
            ? `,drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(overlayCaption)}':fontcolor=white:fontsize=${Math.round(height * 0.04)}:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=h-text_h-48`
            : '';

          await runCommand('ffmpeg', [
            '-y',
            '-i',
            seg1,
            '-i',
            seg2,
            '-filter_complex',
            `[0:v][1:v]xfade=transition=fade:duration=${xfadeDur.toFixed(2)}:offset=${offset.toFixed(2)}${captionFilter},format=yuv420p[v]`,
            '-map',
            '[v]',
            '-c:v',
            'libx264',
            '-profile:v',
            'high',
            '-level:v',
            '4.1',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            'fast',
            '-crf',
            '20',
            '-movflags',
            '+faststart',
            outPath,
          ]);
        } else {
          const filters = [buildZoompanFilter(motion, width, height, durationSec), gradeFilter];
          if (overlayCaption) {
            filters.push(
              `drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(overlayCaption)}':fontcolor=white:fontsize=${Math.round(height * 0.04)}:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=h-text_h-48`
            );
          }
          filters.push('format=yuv420p');

          const inputArgs =
            motion === 'static'
              ? ['-loop', '1', '-t', String(durationSec), '-i', startFile.path]
              : ['-i', startFile.path];

          await runCommand('ffmpeg', [
            '-y',
            ...inputArgs,
            '-vf',
            filters.filter(Boolean).join(','),
            '-t',
            String(durationSec),
            '-c:v',
            'libx264',
            '-profile:v',
            'high',
            '-level:v',
            '4.1',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            'fast',
            '-crf',
            '20',
            '-r',
            '30',
            '-movflags',
            '+faststart',
            outPath,
          ]);
        }

        const videoBuf = await fsp.readFile(outPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(videoBuf);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error al animar la imagen.';
        res.status(500).json({ error: message });
      } finally {
        await safeUnlink(startFile?.path);
        await safeUnlink(endFile?.path);
        await safeRmDir(workDir);
      }
    }
  );

  // 6. Video Processor / Stylizer / Trimmer (Video-to-Video local adaptation)
  app.post('/api/media/process-video', upload.single('video'), async (req, res) => {
    const uploadedPath = req.file?.path;
    const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'vidproc-'));

    try {
      if (!req.file || !uploadedPath) {
        res.status(400).json({ error: 'Sube un archivo de video.' });
        return;
      }

      const aspectRatio = String(req.body.aspectRatio || '16:9');
      const resolution = String(req.body.resolution || '720p');
      const colorGrade = String(req.body.colorGrade || 'none');
      const speed = Math.max(0.5, Math.min(2.0, Number(req.body.speed) || 1));
      const trimStart = Math.max(0, Number(req.body.trimStart) || 0);
      const trimEnd = Number(req.body.trimEnd) || 0;
      const muteOriginal = req.body.muteOriginal === 'true';
      const overlayCaption = String(req.body.overlayCaption || '').trim();

      const { width, height } = getResolutionDims(aspectRatio, resolution);
      const probed = await probeMedia(uploadedPath);
      const outPath = path.join(workDir, 'processed.mp4');

      const vFilters: string[] = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
      ];
      if (speed !== 1) {
        vFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
      }
      const gradeFilter = buildColorGradeFilter(colorGrade);
      if (gradeFilter) vFilters.push(gradeFilter);
      if (overlayCaption) {
        vFilters.push(
          `drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(overlayCaption)}':fontcolor=white:fontsize=${Math.round(height * 0.038)}:box=1:boxcolor=black@0.58:boxborderw=14:x=48:y=h-text_h-48`
        );
      }
      vFilters.push('fps=30,format=yuv420p');

      const args: string[] = ['-y'];
      if (trimStart > 0) {
        args.push('-ss', String(trimStart));
      }
      args.push('-i', uploadedPath);
      if (trimEnd > trimStart) {
        args.push('-t', String(trimEnd - trimStart));
      }

      args.push('-vf', vFilters.join(','));

      if (muteOriginal || !probed.hasAudio) {
        args.push('-an');
      } else {
        if (speed !== 1) {
          args.push('-af', `atempo=${speed.toFixed(2)}`);
        }
        args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
      }

      args.push('-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '21', '-movflags', '+faststart', outPath);

      await runCommand('ffmpeg', args);
      const outBuf = await fsp.readFile(outPath);
      const outProbe = await probeMedia(outPath);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-Video-Duration', String(outProbe.duration || 0));
      res.send(outBuf);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al procesar el video.';
      res.status(500).json({ error: message });
    } finally {
      await safeUnlink(uploadedPath);
      await safeRmDir(workDir);
    }
  });

  // Helper shared by synchronous /api/export/mp4 and async chunked export jobs
  interface ExportSceneInput {
    id: string;
    title: string;
    durationSec: number;
    cameraMotion: string;
    colorGrade: string;
    subtitleText?: string;
    narration?: string;
    overlayCaption?: string;
    originalVideoMuted?: boolean;
  }

  interface ExportManifest {
    title?: string;
    aspectRatio?: string;
    resolution?: string;
    transitionType?: string;
    transitionDurationSec?: number;
    clipAudioVolume?: number;
    voiceVolume?: number;
    musicVolume?: number;
    burnSubtitles?: boolean;
    subtitles?: Array<{ startSec: number; endSec: number; text: string }>;
    scenes?: ExportSceneInput[];
  }

  interface ExportJobState {
    id: string;
    workDir: string;
    manifest: ExportManifest;
    assets: Map<string, string>;
    status: 'uploading' | 'rendering' | 'done' | 'error';
    progress: string;
    outputPath?: string;
    error?: string;
  }

  const exportJobs = new Map<string, ExportJobState>();

  async function renderExportPipeline(
    workDir: string,
    manifest: ExportManifest,
    assetPathMap: Map<string, string>,
    onProgress?: (msg: string) => void
  ): Promise<{ finalOutPath: string; safeTitle: string }> {
    const scenes = manifest.scenes || [];
    if (scenes.length === 0) {
      throw new Error('Agrega al menos una escena antes de exportar.');
    }

    const aspectRatio = String(manifest.aspectRatio || '16:9');
    const resolution = String(manifest.resolution || '720p');
    const { width, height } = getResolutionDims(aspectRatio, resolution);
    const transitionType = String(manifest.transitionType || 'none');
    const rawTransDur = Number(manifest.transitionDurationSec) || 0.6;
    const clipAudioVolume = Math.max(0, Math.min(1.5, Number(manifest.clipAudioVolume ?? 0.6)));
    const voiceVolume = Math.max(0, Math.min(2.0, Number(manifest.voiceVolume ?? 1.0)));
    const musicVolume = Math.max(0, Math.min(1.5, Number(manifest.musicVolume ?? 0.25)));
    const burnSubtitles = Boolean(manifest.burnSubtitles);

    const normalizedSegments: Array<{ path: string; duration: number; sceneId: string }> = [];

    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      onProgress?.(`Renderizando escena ${i + 1} de ${scenes.length}...`);
      const segOut = path.join(workDir, `seg_${i}.mp4`);
      const clipPath = assetPathMap.get(`clip_${sc.id}`);
      const imgPath = assetPathMap.get(`image_${sc.id}`);
      const gradeFilter = buildColorGradeFilter(sc.colorGrade);

      if (clipPath) {
        const probe = await probeMedia(clipPath);
        const vFilters = [
          `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
          gradeFilter,
          sc.overlayCaption
            ? `drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(sc.overlayCaption)}':fontcolor=white:fontsize=${Math.round(height * 0.038)}:box=1:boxcolor=black@0.58:boxborderw=14:x=48:y=h-text_h-48`
            : null,
          'fps=30,format=yuv420p',
        ]
          .filter(Boolean)
          .join(',');

        if (probe.hasAudio && !sc.originalVideoMuted && clipAudioVolume > 0) {
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            clipPath,
            '-vf',
            vFilters,
            '-af',
            `volume=${clipAudioVolume.toFixed(2)},aresample=48000,aformat=channel_layouts=stereo`,
            '-c:v',
            'libx264',
            '-profile:v',
            'high',
            '-level:v',
            '4.1',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            'fast',
            '-crf',
            '21',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-shortest',
            segOut,
          ]);
        } else {
          await runCommand('ffmpeg', [
            '-y',
            '-i',
            clipPath,
            '-f',
            'lavfi',
            '-i',
            'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-vf',
            vFilters,
            '-map',
            '0:v',
            '-map',
            '1:a',
            '-c:v',
            'libx264',
            '-profile:v',
            'high',
            '-level:v',
            '4.1',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            'fast',
            '-crf',
            '21',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-shortest',
            segOut,
          ]);
        }
      } else if (imgPath) {
        const dur = Math.max(2, Number(sc.durationSec) || 6);
        const vFilters = [
          buildZoompanFilter(sc.cameraMotion, width, height, dur),
          gradeFilter,
          sc.overlayCaption
            ? `drawtext=fontfile=${FONT_PATH}:text='${escapeDrawtext(sc.overlayCaption)}':fontcolor=white:fontsize=${Math.round(height * 0.038)}:box=1:boxcolor=black@0.58:boxborderw=14:x=48:y=h-text_h-48`
            : null,
          'format=yuv420p',
        ]
          .filter(Boolean)
          .join(',');

        const inputArgs =
          sc.cameraMotion === 'static'
            ? ['-loop', '1', '-t', String(dur), '-i', imgPath]
            : ['-i', imgPath];

        await runCommand('ffmpeg', [
          '-y',
          ...inputArgs,
          '-f',
          'lavfi',
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-vf',
          vFilters,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-t',
          String(dur),
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-level:v',
          '4.1',
          '-pix_fmt',
          'yuv420p',
          '-preset',
          'fast',
          '-crf',
          '21',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '48000',
          '-ac',
          '2',
          segOut,
        ]);
      } else {
        const dur = Math.max(2, Number(sc.durationSec) || 5);
        const cardText = escapeDrawtext(sc.title || `Escena ${i + 1}`);
        const subText = escapeDrawtext((sc.overlayCaption || sc.subtitleText || '').slice(0, 72));
        const drawSub = subText
          ? `,drawtext=fontfile=${FONT_PATH}:text='${subText}':fontcolor=#9CA3AF:fontsize=${Math.round(height * 0.028)}:x=(w-text_w)/2:y=(h/2)+34`
          : '';

        await runCommand('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `color=c=0x13161D:s=${width}x${height}:r=30:d=${dur}`,
          '-f',
          'lavfi',
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-vf',
          `drawtext=fontfile=${FONT_PATH}:text='${cardText}':fontcolor=#F1F3F6:fontsize=${Math.round(height * 0.048)}:x=(w-text_w)/2:y=(h/2)-24${drawSub},format=yuv420p`,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-t',
          String(dur),
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-level:v',
          '4.1',
          '-pix_fmt',
          'yuv420p',
          '-preset',
          'fast',
          '-crf',
          '21',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '48000',
          '-ac',
          '2',
          segOut,
        ]);
      }

      const segProbe = await probeMedia(segOut);
      normalizedSegments.push({
        path: segOut,
        duration: Math.max(1, segProbe.duration || sc.durationSec || 5),
        sceneId: sc.id,
      });
    }

    onProgress?.('Uniendo escenas y transiciones...');
    const minDur = Math.min(...normalizedSegments.map((s) => s.duration));
    const useFade = transitionType === 'fade' && normalizedSegments.length > 1;
    const transDur = useFade ? Math.min(rawTransDur, Math.max(0.2, minDur * 0.35)) : 0;

    const sceneStartTimes: number[] = [];
    let cursor = 0;
    for (let i = 0; i < normalizedSegments.length; i++) {
      sceneStartTimes.push(cursor);
      cursor += normalizedSegments[i].duration - (i < normalizedSegments.length - 1 ? transDur : 0);
    }
    const totalVideoDuration = Math.max(1, cursor);

    const concatVideoPath = path.join(workDir, 'concat.mp4');
    if (normalizedSegments.length === 1) {
      await fsp.copyFile(normalizedSegments[0].path, concatVideoPath);
    } else if (!useFade) {
      const listPath = path.join(workDir, 'concat_list.txt');
      const listBody = normalizedSegments.map((s) => `file '${s.path.replace(/'/g, "'\\''")}'`).join('\n');
      await fsp.writeFile(listPath, listBody, 'utf8');
      await runCommand('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatVideoPath]);
    } else {
      const inputs: string[] = [];
      for (const seg of normalizedSegments) {
        inputs.push('-i', seg.path);
      }
      const filterParts: string[] = [];
      let prevV = '[0:v]';
      let prevA = '[0:a]';
      let runningOffset = normalizedSegments[0].duration - transDur;

      for (let i = 1; i < normalizedSegments.length; i++) {
        const isLast = i === normalizedSegments.length - 1;
        const outV = isLast ? '[vout]' : `[vx${i}]`;
        const outA = isLast ? '[aout]' : `[ax${i}]`;
        const fmtSuffix = isLast ? ',format=yuv420p' : '';
        filterParts.push(
          `${prevV}[${i}:v]xfade=transition=fade:duration=${transDur.toFixed(3)}:offset=${Math.max(0.1, runningOffset).toFixed(3)}${fmtSuffix}${outV}`
        );
        filterParts.push(`${prevA}[${i}:a]acrossfade=d=${transDur.toFixed(3)}:c1=tri:c2=tri${outA}`);
        prevV = outV;
        prevA = outA;
        runningOffset += normalizedSegments[i].duration - transDur;
      }

      await runCommand('ffmpeg', [
        '-y',
        ...inputs,
        '-filter_complex',
        filterParts.join(';'),
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'fast',
        '-crf',
        '21',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        concatVideoPath,
      ]);
    }

    onProgress?.('Mezclando voces, música y subtítulos...');
    const finalOutPath = path.join(workDir, 'final_export.mp4');
    const voiceFiles: Array<{ path: string; startSec: number }> = [];
    for (let i = 0; i < normalizedSegments.length; i++) {
      const audioPath = assetPathMap.get(`audio_${normalizedSegments[i].sceneId}`);
      if (audioPath) {
        voiceFiles.push({ path: audioPath, startSec: sceneStartTimes[i] });
      }
    }
    const musicPath = assetPathMap.get('music_track');

    let srtPath: string | null = null;
    if (burnSubtitles) {
      const manualCues = Array.isArray(manifest.subtitles) ? manifest.subtitles : [];
      const cuesToWrite =
        manualCues.length > 0
          ? manualCues
          : scenes
              .map((sc, idx) => ({
                startSec: sceneStartTimes[idx],
                endSec: sceneStartTimes[idx] + normalizedSegments[idx].duration - 0.15,
                text: (sc.subtitleText || sc.narration || '').trim(),
              }))
              .filter((c) => c.text.length > 0);

      if (cuesToWrite.length > 0) {
        srtPath = path.join(workDir, 'subtitles.srt');
        const srtBody = cuesToWrite
          .map((c, idx) => `${idx + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text}\n`)
          .join('\n');
        await fsp.writeFile(srtPath, srtBody, 'utf8');
      }
    }

    const needsAudioMix = voiceFiles.length > 0 || Boolean(musicPath);
    const needsSubBurn = Boolean(srtPath);

    if (!needsAudioMix && !needsSubBurn) {
      await runCommand('ffmpeg', ['-y', '-i', concatVideoPath, '-c', 'copy', '-movflags', '+faststart', finalOutPath]);
    } else {
      const mixArgs: string[] = ['-y', '-i', concatVideoPath];
      const filterLines: string[] = [];
      const voiceLabels: string[] = [];
      let nextIdx = 1;

      for (const vf of voiceFiles) {
        mixArgs.push('-i', vf.path);
        const delayMs = Math.max(0, Math.round(vf.startSec * 1000));
        const lbl = `[va${nextIdx}]`;
        filterLines.push(
          `[${nextIdx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${voiceVolume.toFixed(2)},adelay=${delayMs}|${delayMs}${lbl}`
        );
        voiceLabels.push(lbl);
        nextIdx++;
      }

      let musicLabel: string | null = null;
      if (musicPath) {
        mixArgs.push('-stream_loop', '-1', '-i', musicPath);
        const rawMusicLbl = `[ma_raw${nextIdx}]`;
        const fadeOutStart = Math.max(0, totalVideoDuration - 2.0);
        filterLines.push(
          `[${nextIdx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${totalVideoDuration.toFixed(2)},asetpts=PTS-STARTPTS,volume=${musicVolume.toFixed(2)},afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=2.0${rawMusicLbl}`
        );
        musicLabel = rawMusicLbl;
        nextIdx++;
      }

      const finalMixInputs: string[] = ['[0:a]'];
      if (voiceLabels.length > 0 && musicLabel) {
        if (voiceLabels.length === 1) {
          filterLines.push(`${voiceLabels[0]}asplit=2[vbus_mix][vbus_rawsc]`);
        } else {
          filterLines.push(
            `${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0,asplit=2[vbus_mix][vbus_rawsc]`
          );
        }
        filterLines.push(
          `[vbus_rawsc]apad=whole_dur=${totalVideoDuration.toFixed(2)},atrim=0:${totalVideoDuration.toFixed(2)}[vbus_sc]`
        );
        filterLines.push(
          `${musicLabel}[vbus_sc]sidechaincompress=threshold=0.015:ratio=5:attack=120:release=420[ma_ducked]`
        );
        finalMixInputs.push('[vbus_mix]', '[ma_ducked]');
      } else {
        if (voiceLabels.length > 0) finalMixInputs.push(...voiceLabels);
        if (musicLabel) finalMixInputs.push(musicLabel);
      }

      if (finalMixInputs.length > 1) {
        filterLines.push(
          `${finalMixInputs.join('')}amix=inputs=${finalMixInputs.length}:duration=first:dropout_transition=2:normalize=0[amixed]`
        );
      }

      if (srtPath) {
        const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
        filterLines.push(
          `[0:v]subtitles='${escapedSrt}':force_style='FontName=Noto Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=3,Outline=1,MarginV=32',format=yuv420p[vsub]`
        );
      }

      if (filterLines.length > 0) {
        mixArgs.push('-filter_complex', filterLines.join(';'));
      }

      mixArgs.push('-map', srtPath ? '[vsub]' : '0:v');
      mixArgs.push('-map', finalMixInputs.length > 1 ? '[amixed]' : '0:a');
      if (srtPath) {
        mixArgs.push('-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20');
      } else {
        mixArgs.push('-c:v', 'copy');
      }
      mixArgs.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', finalOutPath);

      await runCommand('ffmpeg', mixArgs);
    }

    const safeTitle =
      String(manifest.title || 'cinecraft-video')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-|-$/g, '') || 'cinecraft-video';

    return { finalOutPath, safeTitle };
  }

  // 7A. Chunked Export Job Endpoints (prevents HTTP timeouts & 32MB proxy payload limits)
  app.post('/api/export/start', async (req, res) => {
    try {
      const manifest = req.body?.manifest as ExportManifest | undefined;
      if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
        res.status(400).json({ error: 'Manifiesto de exportación inválido.' });
        return;
      }
      const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'job-'));
      const jobId = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      exportJobs.set(jobId, {
        id: jobId,
        workDir,
        manifest,
        assets: new Map<string, string>(),
        status: 'uploading',
        progress: 'Subiendo archivos...',
      });
      res.json({ jobId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Error iniciando exportación.' });
    }
  });

  app.post('/api/export/:jobId/asset', upload.single('file'), async (req, res) => {
    const job = exportJobs.get(req.params.jobId);
    const key = String(req.body?.key || '');
    if (!job || !req.file || !key) {
      await safeUnlink(req.file?.path);
      res.status(400).json({ error: 'Trabajo o archivo inválido.' });
      return;
    }
    const dest = path.join(job.workDir, `asset_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    await fsp.rename(req.file.path, dest);
    job.assets.set(key, dest);
    res.json({ ok: true });
  });

  app.post('/api/export/:jobId/render', (req, res) => {
    const job = exportJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Trabajo de exportación no encontrado.' });
      return;
    }
    job.status = 'rendering';
    job.progress = 'Iniciando renderizado FFmpeg...';

    renderExportPipeline(job.workDir, job.manifest, job.assets, (msg) => {
      job.progress = msg;
    })
      .then(({ finalOutPath }) => {
        job.outputPath = finalOutPath;
        job.status = 'done';
        job.progress = 'Video listo para descargar';
      })
      .catch((err) => {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : 'Error al renderizar MP4.';
      });

    res.json({ status: 'rendering' });
  });

  app.get('/api/export/:jobId/status', (req, res) => {
    const job = exportJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Trabajo no encontrado.' });
      return;
    }
    res.json({
      status: job.status,
      progress: job.progress,
      error: job.error,
    });
  });

  app.get('/api/export/:jobId/download', async (req, res) => {
    const job = exportJobs.get(req.params.jobId);
    if (!job || job.status !== 'done' || !job.outputPath) {
      res.status(404).json({ error: 'El video aún no está listo.' });
      return;
    }
    const safeTitle =
      String(job.manifest.title || 'cinecraft-video')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-|-$/g, '') || 'cinecraft-video';

    res.download(job.outputPath, `${safeTitle}.mp4`, async () => {
      exportJobs.delete(job.id);
      await safeRmDir(job.workDir);
    });
  });

  // 7B. Legacy single-request /api/export/mp4 (delegates to renderExportPipeline)
  app.post('/api/export/mp4', upload.any(), async (req, res) => {
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'export-'));

    try {
      const manifestRaw = req.body?.manifest;
      if (!manifestRaw) {
        res.status(400).json({ error: 'Manifiesto de exportación requerido.' });
        return;
      }
      const manifest = JSON.parse(manifestRaw) as ExportManifest;
      const assetMap = new Map<string, string>();
      for (const f of uploadedFiles) {
        assetMap.set(f.fieldname, f.path);
      }

      const { finalOutPath, safeTitle } = await renderExportPipeline(workDir, manifest, assetMap);
      const finalBuffer = await fsp.readFile(finalOutPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
      res.send(finalBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al exportar el archivo MP4.';
      res.status(500).json({ error: message });
    } finally {
      for (const f of uploadedFiles) {
        await safeUnlink(f.path);
      }
      await safeRmDir(workDir);
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CineCraft Studio server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
