import { Project, Scene } from '../types/studio';

const DB_NAME = 'cinecraft_studio_db';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'mediaBlobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).getAll();
    req.onsuccess = () => {
      const list = (req.result as Project[]) || [];
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDb();
  const payload: Project = { ...project, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    tx.objectStore(STORE_PROJECTS).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveMediaBlob(blob: Blob, existingId?: string): Promise<string> {
  const db = await openDb();
  const id = existingId || uid('blob');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    tx.objectStore(STORE_BLOBS).put({ id, blob, updatedAt: Date.now() });
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMediaBlob(id: string | undefined): Promise<Blob | null> {
  if (!id) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const req = tx.objectStore(STORE_BLOBS).get(id);
    req.onsuccess = () => {
      const rec = req.result as { id: string; blob: Blob } | undefined;
      resolve(rec?.blob ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMediaBlob(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    tx.objectStore(STORE_BLOBS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function exportProjectBundle(project: Project): Promise<Blob> {
  const blobIds = new Set<string>();
  if (project.musicBlobId) blobIds.add(project.musicBlobId);
  for (const c of project.characters) {
    if (c.avatarBlobId) blobIds.add(c.avatarBlobId);
  }
  for (const s of project.scenes) {
    if (s.imageBlobId) blobIds.add(s.imageBlobId);
    if (s.endImageBlobId) blobIds.add(s.endImageBlobId);
    if (s.videoClipBlobId) blobIds.add(s.videoClipBlobId);
    if (s.audioBlobId) blobIds.add(s.audioBlobId);
  }

  const blobs: Record<string, string> = {};
  for (const id of blobIds) {
    const b = await getMediaBlob(id);
    if (b) {
      blobs[id] = await blobToDataUrl(b);
    }
  }

  const bundle = {
    version: 1,
    project,
    blobs,
  };
  return new Blob([JSON.stringify(bundle)], { type: 'application/json' });
}

export async function importProjectBundle(file: File): Promise<Project> {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!parsed?.project?.scenes) {
    throw new Error('Archivo de proyecto no válido.');
  }

  const idMap = new Map<string, string>();
  const blobs = parsed.blobs || {};
  for (const [oldId, dataUrl] of Object.entries(blobs)) {
    if (typeof dataUrl === 'string') {
      const b = await dataUrlToBlob(dataUrl);
      const newId = await saveMediaBlob(b);
      idMap.set(oldId, newId);
    }
  }

  const oldProj: Project = parsed.project;
  const remap = (oldId?: string) => (oldId ? idMap.get(oldId) : undefined);

  const newProject: Project = {
    ...oldProj,
    id: uid('proj'),
    title: `${oldProj.title} (Importado)`,
    musicBlobId: remap(oldProj.musicBlobId),
    characters: (oldProj.characters || []).map((c) => ({
      ...c,
      id: uid('char'),
      avatarBlobId: remap(c.avatarBlobId),
    })),
    scenes: (oldProj.scenes || []).map((s) => ({
      ...s,
      id: uid('scene'),
      imageBlobId: remap(s.imageBlobId),
      endImageBlobId: remap(s.endImageBlobId),
      videoClipBlobId: remap(s.videoClipBlobId),
      audioBlobId: remap(s.audioBlobId),
    })),
    updatedAt: Date.now(),
  };

  await saveProject(newProject);
  return newProject;
}

export function createEmptyScene(index: number): Scene {
  return {
    id: uid('scene'),
    title: `Escena ${index}`,
    visualDirection: 'Plano general cinematográfico con iluminación suave y movimiento lento.',
    narration: '',
    isDialogue: false,
    dialogueLines: [],
    speakerName: 'Narrador',
    voice: 'Kore',
    voiceStyle: 'Narrador claro y pausado',
    durationSec: 6,
    cameraMotion: 'ken_burns',
    colorGrade: 'cinema_warm',
    subtitleText: '',
    overlayCaption: '',
    originalVideoMuted: false,
    speed: 1,
  };
}

export function createDefaultProject(): Project {
  return {
    id: uid('proj'),
    title: 'Documental: El Arte del Tiempo',
    description: 'Proyecto inicial de demostración listo para guionizar, locutar, animar y exportar en MP4.',
    mode: 'documentary',
    aspectRatio: '16:9',
    resolution: '720p',
    visualStyle: 'Documental cinematográfico cálido, textura fílmica 35mm',
    targetDurationSec: 60,
    transitionType: 'fade',
    transitionDurationSec: 0.6,
    musicVolume: 0.22,
    voiceVolume: 1.0,
    clipAudioVolume: 0.65,
    burnSubtitles: true,
    language: 'es-ES',
    characters: [
      {
        id: uid('char'),
        name: 'Narrador',
        role: 'Voz principal',
        visualDescription: 'Tono sereno, documental y cercano.',
        voice: 'Charon',
        voiceStyle: 'Narrador documental sereno y profundo',
      },
      {
        id: uid('char'),
        name: 'Elena',
        role: 'Maestra relojera',
        visualDescription: 'Artesana concentrada en su taller de madera y latón con luz natural.',
        voice: 'Kore',
        voiceStyle: 'Voz cálida, apasionada y reflexiva',
      },
    ],
    scenes: [
      {
        id: uid('scene'),
        title: '01. El Despertar del Taller',
        visualDirection: 'Plano abierto del taller al amanecer, rayos de luz sobre engranajes dorados.',
        narration: 'Cada segundo que pasa deja una huella invisible, pero en este taller el tiempo se construye a mano.',
        isDialogue: false,
        dialogueLines: [],
        speakerName: 'Narrador',
        voice: 'Charon',
        voiceStyle: 'Narrador documental sereno y profundo',
        durationSec: 7,
        cameraMotion: 'zoom_in',
        colorGrade: 'cinema_warm',
        subtitleText: 'Cada segundo deja una huella, pero aquí el tiempo se construye a mano.',
        overlayCaption: 'Capítulo I · El Taller',
      },
      {
        id: uid('scene'),
        title: '02. Precisión Milimétrica',
        visualDirection: 'Primer plano de pinzas ajustando un resorte minúsculo bajo la lupa.',
        narration: 'Un solo milímetro de diferencia cambia el ritmo de toda una vida medida en latidos mecánicos.',
        isDialogue: false,
        dialogueLines: [],
        speakerName: 'Elena',
        voice: 'Kore',
        voiceStyle: 'Voz cálida, apasionada y reflexiva',
        durationSec: 7,
        cameraMotion: 'pan_right',
        colorGrade: 'cinema_warm',
        subtitleText: 'Un milímetro cambia el ritmo de toda una vida medida en latidos.',
        overlayCaption: '',
      },
      {
        id: uid('scene'),
        title: '03. La Sinfonía Final',
        visualDirection: 'Plano detalle del reloj completo funcionando mientras cae la tarde.',
        narration: 'Cuando todas las piezas encajan, el silencio del taller se convierte en una sinfonía perfecta.',
        isDialogue: false,
        dialogueLines: [],
        speakerName: 'Narrador',
        voice: 'Charon',
        voiceStyle: 'Narrador documental sereno y profundo',
        durationSec: 7,
        cameraMotion: 'zoom_out',
        colorGrade: 'cool_film',
        subtitleText: 'Cuando todas las piezas encajan, el silencio se vuelve sinfonía.',
        overlayCaption: '',
      },
    ],
    subtitles: [],
    updatedAt: Date.now(),
  };
}
