export type AspectRatio = '16:9' | '9:16';
export type Resolution = '720p' | '1080p';
export type CreationMode =
  | 'story'
  | 'documentary'
  | 'commercial'
  | 'music_video'
  | 'image_sequence';

export type CameraMotion =
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'ken_burns'
  | 'static';

export type ColorGrade =
  | 'none'
  | 'cinema_warm'
  | 'noir'
  | 'cool_film'
  | 'vibrant';

export type VoiceName = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';
export type TransitionType = 'none' | 'fade';

export interface Character {
  id: string;
  name: string;
  role: string;
  visualDescription: string;
  voice: VoiceName;
  voiceStyle: string;
  avatarBlobId?: string;
}

export interface DialogueLine {
  id: string;
  speaker: string;
  text: string;
  voice: VoiceName;
  style: string;
}

export interface Scene {
  id: string;
  title: string;
  visualDirection: string;
  narration: string;
  isDialogue: boolean;
  dialogueLines: DialogueLine[];
  speakerName: string;
  voice: VoiceName;
  voiceStyle: string;
  durationSec: number;
  cameraMotion: CameraMotion;
  colorGrade: ColorGrade;
  imageBlobId?: string;
  endImageBlobId?: string;
  videoClipBlobId?: string;
  audioBlobId?: string;
  audioDurationSec?: number;
  subtitleText: string;
  overlayCaption?: string;
  originalVideoMuted?: boolean;
  trimStart?: number;
  trimEnd?: number;
  speed?: number;
}

export interface SubtitleCue {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  mode: CreationMode;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  visualStyle: string;
  targetDurationSec: number;
  transitionType: TransitionType;
  transitionDurationSec: number;
  musicBlobId?: string;
  musicFileName?: string;
  musicVolume: number;
  voiceVolume: number;
  clipAudioVolume: number;
  burnSubtitles: boolean;
  language: string;
  characters: Character[];
  scenes: Scene[];
  subtitles: SubtitleCue[];
  updatedAt: number;
}
