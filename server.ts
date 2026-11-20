import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

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

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no está configurada en el servidor.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
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

  // 0A. Autonomous Director Planner (decides format, duration, style, cast, scenes & search queries from 1 idea)
  app.post('/api/ai/auto-plan', async (req, res) => {
    try {
      const { idea, language = 'es-ES', userMedia = [] } = req.body ?? {};
      if (!idea || typeof idea !== 'string' || !idea.trim()) {
        res.status(400).json({ error: 'Escribe una idea para iniciar el Piloto Automático.' });
        return;
      }

      const ai = getAiClient();
      const langName = language.startsWith('en') ? 'Inglés' : language.startsWith('pt') ? 'Portugués' : 'Español';
      const mediaContext =
        Array.isArray(userMedia) && userMedia.length > 0
          ? `El usuario subió ${userMedia.length} archivos propios (úsalos donde mejor encajen asignando matchedMediaIndex de 0 a ${userMedia.length - 1}, o -1 si la escena debe buscar un visual automático):\n` +
            userMedia
              .map(
                (m: { index: number; mediaType: string; description: string; durationSec?: number }) =>
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

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
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
          },
        },
      });

      res.json(JSON.parse((response.text ?? '{}').trim()));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error en la planificación autónoma.';
      res.status(500).json({ error: message });
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

  // 1. AI Storyboard & Script Generator (gemini-4-hydrogen)
  app.post('/api/ai/storyboard', async (req, res) => {
    try {
      const {
        topicOrScript,
        mode = 'story',
        targetDurationSec = 60,
        aspectRatio = '16:9',
        visualStyle = 'Cinematográfico realista',
        characters = [],
        language = 'es-ES',
      } = req.body ?? {};

      if (!topicOrScript || typeof topicOrScript !== 'string' || !topicOrScript.trim()) {
        res.status(400).json({ error: 'Escribe una idea o guion para generar el storyboard.' });
        return;
      }

      const ai = getAiClient();
      const approxScenes = Math.max(3, Math.min(18, Math.round(Number(targetDurationSec) / 10)));
      const charList = Array.isArray(characters) && characters.length > 0
        ? characters.map((c: { name: string; role: string; visualDescription: string; voice: string }) =>
            `- ${c.name} (${c.role}): ${c.visualDescription}. Voz sugerida: ${c.voice}`
          ).join('\n')
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

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
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
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al generar el storyboard.';
      res.status(500).json({ error: message });
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

        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
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
          },
        });
        res.json(JSON.parse((response.text ?? '{}').trim()));
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

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
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
        },
      });
      res.json({ scene: JSON.parse((response.text ?? '{}').trim()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al refinar la escena.';
      res.status(500).json({ error: message });
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

      const ai = getAiClient();

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

        const interaction = await ai.interactions.create({
          model: 'gemini-3.8-flash-tts',
          input: inputBlocks,
          response_format: { type: 'audio' },
          generation_config: {
            speech_config: {
              speakers,
            },
          },
        });

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

      const interaction = await ai.interactions.create({
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
      });

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
      const message = error instanceof Error ? error.message : 'Error al generar voz con IA.';
      res.status(500).json({ error: message });
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
      const isVideo = req.file.mimetype.startsWith('video/') || (probed.hasVideo && !req.file.mimetype.startsWith('audio/'));

      let audioPath = uploadedPath;
      let mimeType = req.file.mimetype || 'audio/mp3';

      if (isVideo) {
        if (!probed.hasAudio) {
          res.status(400).json({ error: 'El video subido no contiene pista de audio para transcribir.' });
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

      const ai = getAiClient();
      const interaction = await ai.interactions.create({
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
      });

      const transcript = (interaction.output_text || '').trim();
      const totalDur = Math.max(2, probed.duration || 10);

      // Segment transcript cleanly into timed subtitle cues
      let cues: Array<{ startSec: number; endSec: number; text: string }> = [];
      if (transcript) {
        const segResp = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Divide esta transcripción en bloques cortos de subtítulos (máximo 10 palabras por bloque) distribuidos entre 0 y ${totalDur.toFixed(1)} segundos de forma proporcional.\n\nTranscripción:\n"""\n${transcript}\n"""`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
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
          },
        });
        cues = JSON.parse((segResp.text ?? '[]').trim());
      }

      res.json({ transcript, durationSec: totalDur, cues });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al transcribir el archivo.';
      res.status(500).json({ error: message });
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

      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-movflags', '+faststart', outPath);

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

  // 7. Full Long-Video Multi-Scene + Voice + Music + Subtitles MP4 Exporter
  app.post('/api/export/mp4', upload.any(), async (req, res) => {
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'export-'));

    try {
      const manifestRaw = req.body?.manifest;
      if (!manifestRaw) {
        res.status(400).json({ error: 'Manifiesto de exportación requerido.' });
        return;
      }
      const manifest = JSON.parse(manifestRaw);
      const scenes: Array<{
        id: string;
        title: string;
        durationSec: number;
        cameraMotion: string;
        colorGrade: string;
        subtitleText?: string;
        narration?: string;
        overlayCaption?: string;
        originalVideoMuted?: boolean;
      }> = manifest.scenes || [];

      if (scenes.length === 0) {
        res.status(400).json({ error: 'Agrega al menos una escena antes de exportar.' });
        return;
      }

      const fileMap = new Map<string, Express.Multer.File>();
      for (const f of uploadedFiles) {
        fileMap.set(f.fieldname, f);
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

      // Normalize every scene into a uniform 30fps, WxH, yuv420p, aac 48kHz stereo MP4
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const segOut = path.join(workDir, `seg_${i}.mp4`);
        const clipFile = fileMap.get(`clip_${sc.id}`);
        const imgFile = fileMap.get(`image_${sc.id}`);
        const gradeFilter = buildColorGradeFilter(sc.colorGrade);

        if (clipFile) {
          const probe = await probeMedia(clipFile.path);
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
              clipFile.path,
              '-vf',
              vFilters,
              '-af',
              `volume=${clipAudioVolume.toFixed(2)},aresample=48000,aformat=channel_layouts=stereo`,
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '21',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-shortest',
              segOut,
            ]);
          } else {
            await runCommand('ffmpeg', [
              '-y',
              '-i',
              clipFile.path,
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
              '-preset',
              'fast',
              '-crf',
              '21',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-shortest',
              segOut,
            ]);
          }
        } else if (imgFile) {
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
              ? ['-loop', '1', '-t', String(dur), '-i', imgFile.path]
              : ['-i', imgFile.path];

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
            '-preset',
            'fast',
            '-crf',
            '21',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            segOut,
          ]);
        } else {
          // Clean dark editorial title slate when scene has no visual media yet
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
            '-preset',
            'fast',
            '-crf',
            '21',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
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

      // Compute start offsets of each scene (accounting for transitions)
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

      // Step 2: Concatenate video segments
      const concatVideoPath = path.join(workDir, 'concat.mp4');
      if (normalizedSegments.length === 1) {
        await fsp.copyFile(normalizedSegments[0].path, concatVideoPath);
      } else if (!useFade) {
        const listPath = path.join(workDir, 'concat_list.txt');
        const listBody = normalizedSegments.map((s) => `file '${s.path.replace(/'/g, "'\\''")}'`).join('\n');
        await fsp.writeFile(listPath, listBody, 'utf8');
        await runCommand('ffmpeg', [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c',
          'copy',
          concatVideoPath,
        ]);
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
          const outV = i === normalizedSegments.length - 1 ? '[vout]' : `[vx${i}]`;
          const outA = i === normalizedSegments.length - 1 ? '[aout]' : `[ax${i}]`;
          filterParts.push(
            `${prevV}[${i}:v]xfade=transition=fade:duration=${transDur.toFixed(3)}:offset=${Math.max(0.1, runningOffset).toFixed(3)}${outV}`
          );
          filterParts.push(
            `${prevA}[${i}:a]acrossfade=d=${transDur.toFixed(3)}:c1=tri:c2=tri${outA}`
          );
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
          '-preset',
          'fast',
          '-crf',
          '21',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          concatVideoPath,
        ]);
      }

      // Step 3: Mix voiceover tracks + background music + optional burned-in subtitles
      const finalOutPath = path.join(workDir, 'final_export.mp4');
      const voiceFiles: Array<{ path: string; startSec: number }> = [];
      for (let i = 0; i < normalizedSegments.length; i++) {
        const audioFile = fileMap.get(`audio_${normalizedSegments[i].sceneId}`);
        if (audioFile) {
          voiceFiles.push({ path: audioFile.path, startSec: sceneStartTimes[i] });
        }
      }
      const musicFile = fileMap.get('music_track');

      let srtPath: string | null = null;
      if (burnSubtitles) {
        const manualCues: Array<{ startSec: number; endSec: number; text: string }> = Array.isArray(manifest.subtitles)
          ? manifest.subtitles
          : [];
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

      const needsAudioMix = voiceFiles.length > 0 || Boolean(musicFile);
      const needsSubBurn = Boolean(srtPath);

      if (!needsAudioMix && !needsSubBurn) {
        await fsp.copyFile(concatVideoPath, finalOutPath);
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
        if (musicFile) {
          mixArgs.push('-stream_loop', '-1', '-i', musicFile.path);
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
          // Combine voice bus and apply automatic ducking to background music
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
          if (voiceLabels.length > 0) {
            finalMixInputs.push(...voiceLabels);
          }
          if (musicLabel) {
            finalMixInputs.push(musicLabel);
          }
        }

        if (finalMixInputs.length > 1) {
          filterLines.push(
            `${finalMixInputs.join('')}amix=inputs=${finalMixInputs.length}:duration=first:dropout_transition=2:normalize=0[amixed]`
          );
        }

        if (srtPath) {
          const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
          filterLines.push(
            `[0:v]subtitles='${escapedSrt}':force_style='FontName=Noto Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=3,Outline=1,MarginV=32'[vsub]`
          );
        }

        if (filterLines.length > 0) {
          mixArgs.push('-filter_complex', filterLines.join(';'));
        }

        mixArgs.push('-map', srtPath ? '[vsub]' : '0:v');
        mixArgs.push('-map', finalMixInputs.length > 1 ? '[amixed]' : '0:a');

        if (srtPath) {
          mixArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20');
        } else {
          mixArgs.push('-c:v', 'copy');
        }
        mixArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', finalOutPath);

        await runCommand('ffmpeg', mixArgs);
      }

      const finalBuffer = await fsp.readFile(finalOutPath);
      const safeTitle = String(manifest.title || 'cinecraft-video')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-|-$/g, '') || 'cinecraft-video';

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
