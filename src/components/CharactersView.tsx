import React, { useState } from 'react';
import { Plus, Trash2, Upload, User, Volume2 } from 'lucide-react';
import { Character, Project, VoiceName } from '../types/studio';
import { saveMediaBlob, uid } from '../lib/storage';
import { useBlobUrl } from '../hooks/useBlobUrl';

interface CharactersViewProps {
  project: Project;
  onUpdateProject: (updated: Project) => void;
}

const VOICES: Array<{ id: VoiceName; desc: string }> = [
  { id: 'Charon', desc: 'Grave y documental' },
  { id: 'Kore', desc: 'Clara y expresiva' },
  { id: 'Puck', desc: 'Dinámica y juvenil' },
  { id: 'Fenrir', desc: 'Intensa y dramática' },
  { id: 'Zephyr', desc: 'Suave y serena' },
];

const CharacterCard: React.FC<{
  char: Character;
  language: string;
  onChange: (updated: Character) => void;
  onDelete: () => void;
}> = ({ char, language, onChange, onDelete }) => {
  const { url: avatarUrl } = useBlobUrl(char.avatarBlobId);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const blobId = await saveMediaBlob(file);
    onChange({ ...char, avatarBlobId: blobId });
  };

  const handleTestVoice = async () => {
    try {
      setError(null);
      setTesting(true);
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Hola, soy ${char.name}. Así suena mi voz en este proyecto.`,
          voice: char.voice,
          voiceStyle: char.voiceStyle,
          language,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo probar la voz.');
      const audio = new Audio(`data:${data.mimeType};base64,${data.audioBase64}`);
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de audio.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="p-5 rounded-xl bg-[#13161D] border border-white/[0.08] space-y-4">
      <div className="flex items-start gap-4">
        <label className="relative w-16 h-16 rounded-lg bg-[#1A1E27] border border-white/[0.1] overflow-hidden flex items-center justify-center shrink-0 cursor-pointer group">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={char.name}
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          ) : (
            <User className="w-6 h-6 text-[#6B7280]" />
          )}
          <span className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
            <Upload className="w-4 h-4 text-white" />
          </span>
          <input type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
        </label>

        <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-[#8C94A4] mb-1">Nombre</label>
            <input
              type="text"
              value={char.name}
              onChange={(e) => onChange({ ...char, name: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-sm text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B]"
            />
          </div>
          <div>
            <label className="block text-[11px] text-[#8C94A4] mb-1">Rol</label>
            <input
              type="text"
              value={char.role}
              onChange={(e) => onChange({ ...char, role: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-sm text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B]"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={onDelete}
          title="Eliminar personaje"
          className="p-2 rounded-lg text-[#8C94A4] hover:text-red-300 hover:bg-white/[0.04] transition-colors cursor-pointer"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div>
        <label className="block text-[11px] text-[#8C94A4] mb-1">Descripción visual y narrativa</label>
        <textarea
          rows={2}
          value={char.visualDescription}
          onChange={(e) => onChange({ ...char, visualDescription: e.target.value })}
          className="w-full px-3 py-2 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B]"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
        <div className="sm:col-span-4">
          <label className="block text-[11px] text-[#8C94A4] mb-1">Voz IA</label>
          <select
            value={char.voice}
            onChange={(e) => onChange({ ...char, voice: e.target.value as VoiceName })}
            className="w-full h-[34px] px-2.5 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B]"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id} · {v.desc}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-5">
          <label className="block text-[11px] text-[#8C94A4] mb-1">Estilo de interpretación</label>
          <input
            type="text"
            value={char.voiceStyle}
            onChange={(e) => onChange({ ...char, voiceStyle: e.target.value })}
            placeholder="Ej. Entusiasta, cercano, pausado"
            className="w-full h-[34px] px-3 rounded-lg bg-[#0B0D11] border border-white/[0.08] text-xs text-[#F1F3F6] focus:outline-none focus:border-[#E5A93B]"
          />
        </div>

        <div className="sm:col-span-3">
          <button
            type="button"
            disabled={testing}
            onClick={handleTestVoice}
            className="w-full h-[34px] inline-flex items-center justify-center gap-1.5 px-3 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs font-medium text-[#F1F3F6] transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            <Volume2 className="w-3.5 h-3.5 text-[#E5A93B]" />
            {testing ? 'Probando...' : 'Probar voz'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
};

export const CharactersView: React.FC<CharactersViewProps> = ({ project, onUpdateProject }) => {
  const handleAddCharacter = () => {
    const newChar: Character = {
      id: uid('char'),
      name: `Personaje ${project.characters.length + 1}`,
      role: 'Secundario',
      visualDescription: '',
      voice: 'Puck',
      voiceStyle: 'Tono natural y expresivo',
    };
    onUpdateProject({
      ...project,
      characters: [...project.characters, newChar],
    });
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#F1F3F6]">
            Biblia de Personajes y Voces
          </h1>
          <p className="text-sm text-[#9CA3B2] mt-1">
            Define tus personajes, sus referencias visuales y su voz asignada para mantener consistencia en todo el video.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddCharacter}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[#E5A93B] text-[#0B0D11] hover:bg-[#F0B84F] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Añadir personaje
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {project.characters.map((char) => (
          <CharacterCard
            key={char.id}
            char={char}
            language={project.language}
            onChange={(updated) =>
              onUpdateProject({
                ...project,
                characters: project.characters.map((c) => (c.id === updated.id ? updated : c)),
              })
            }
            onDelete={() =>
              onUpdateProject({
                ...project,
                characters: project.characters.filter((c) => c.id !== char.id),
              })
            }
          />
        ))}
      </div>
    </div>
  );
};
