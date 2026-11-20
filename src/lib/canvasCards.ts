import { AspectRatio } from '../types/studio';

export type SlatePalette = 'charcoal' | 'amber_dusk' | 'ocean_noir' | 'forest_mist';

const PALETTES: Record<SlatePalette, { bg1: string; bg2: string; accent: string; text: string; muted: string }> = {
  charcoal: {
    bg1: '#0F1218',
    bg2: '#1C2230',
    accent: '#E5A93B',
    text: '#F4F6FA',
    muted: '#9CA3B2',
  },
  amber_dusk: {
    bg1: '#1A130D',
    bg2: '#2E2016',
    accent: '#F0B44A',
    text: '#FBF7F2',
    muted: '#C7B6A2',
  },
  ocean_noir: {
    bg1: '#0B131E',
    bg2: '#14263C',
    accent: '#6BA4D9',
    text: '#F1F6FA',
    muted: '#97ADC2',
  },
  forest_mist: {
    bg1: '#0D1713',
    bg2: '#182C24',
    accent: '#6DBE96',
    text: '#F2F7F4',
    muted: '#9BB5A8',
  },
};

export async function generateEditorialSlateImage(
  title: string,
  subtitle: string,
  paletteKey: SlatePalette,
  aspectRatio: AspectRatio
): Promise<Blob> {
  const width = aspectRatio === '9:16' ? 720 : 1280;
  const height = aspectRatio === '9:16' ? 1280 : 720;
  const pal = PALETTES[paletteKey] || PALETTES.charcoal;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D no disponible.');
  }

  // Deep atmospheric radial + linear background
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, pal.bg1);
  grad.addColorStop(1, pal.bg2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.5, height * 0.42, 20, width * 0.5, height * 0.42, width * 0.65);
  glow.addColorStop(0, `${pal.accent}1E`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Subtle architectural framing border
  const margin = Math.round(Math.min(width, height) * 0.065);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);

  // Accent rule line
  const ruleWidth = Math.round(width * 0.08);
  ctx.fillStyle = pal.accent;
  ctx.fillRect((width - ruleWidth) / 2, height * 0.41, ruleWidth, 3);

  // Title typography with wrapping
  const titleSize = aspectRatio === '9:16' ? 46 : 54;
  ctx.fillStyle = pal.text;
  ctx.font = `700 ${titleSize}px "Plus Jakarta Sans", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxLineWidth = width - margin * 3.5;
  const words = (title || 'Escena').split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width > maxLineWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  const lineHeight = titleSize * 1.24;
  const startY = height * 0.50 - ((lines.length - 1) * lineHeight) / 2;
  lines.slice(0, 3).forEach((line, idx) => {
    ctx.fillText(line, width / 2, startY + idx * lineHeight);
  });

  // Subtitle
  if (subtitle.trim()) {
    const subSize = aspectRatio === '9:16' ? 24 : 26;
    ctx.fillStyle = pal.muted;
    ctx.font = `400 ${subSize}px "DM Sans", sans-serif`;
    const clipped = subtitle.trim().slice(0, 68);
    ctx.fillText(clipped, width / 2, startY + Math.min(lines.length, 3) * lineHeight + 28);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('No se pudo generar la imagen de tarjeta.'));
    }, 'image/png');
  });
}
