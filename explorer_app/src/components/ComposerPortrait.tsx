import React, { useMemo } from 'react';

const PERIOD_TONES: Record<string, { bg: string; ink: string; accent: string }> = {
  Renaissance: { bg: '#3f5247', ink: '#dfe7d6', accent: '#a7c59b' },
  Baroque: { bg: '#5a3b2e', ink: '#f1dec1', accent: '#d89b5f' },
  Classical: { bg: '#4d4a39', ink: '#f5e8b5', accent: '#d7bd5b' },
  Romantic: { bg: '#563444', ink: '#f4c7d7', accent: '#df6f9e' },
  Modern: { bg: '#334a52', ink: '#c8eef3', accent: '#69c7d8' },
  Unknown: { bg: '#3d4148', ink: '#e1e5ec', accent: '#9aa4b2' },
};

const hashText = (text: string) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const initialsFor = (name: string) => (
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('')
);

interface ComposerPortraitProps {
  composer: string;
  period?: string;
  size?: number;
}

const ComposerPortrait = ({ composer, period = 'Unknown', size = 76 }: ComposerPortraitProps) => {
  const portrait = useMemo(() => {
    const hash = hashText(composer);
    const tone = PERIOD_TONES[period] ?? PERIOD_TONES.Unknown;
    return {
      tone,
      initials: initialsFor(composer),
      hair: ['#171717', '#2b211c', '#6b6259', '#ded3c1'][hash % 4],
      coat: ['#181b24', '#2f2631', '#24313a', '#302d23'][(hash >> 3) % 4],
      face: ['#f0c9a2', '#d8a476', '#c78c62', '#ead3b4'][(hash >> 5) % 4],
      hairShape: hash % 3,
      collarShape: (hash >> 7) % 3,
      tilt: ((hash >> 9) % 7) - 3,
    };
  }, [composer, period]);

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-white/12 shadow-xl"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 50% 30%, ${portrait.tone.accent}55, transparent 46%), ${portrait.tone.bg}`,
      }}
      aria-label={`${composer} portrait illustration`}
    >
      <div className="absolute inset-x-2 top-3 h-px bg-white/16" />
      <div className="absolute inset-x-3 top-6 h-px bg-white/10" />
      <div className="absolute inset-x-4 top-9 h-px bg-white/8" />

      <div
        className="absolute left-1/2 top-[18%] h-[38%] w-[42%] -translate-x-1/2 rounded-t-full rounded-b-[42%]"
        style={{
          backgroundColor: portrait.hair,
          transform: `translateX(-50%) rotate(${portrait.tilt}deg)`,
          clipPath: portrait.hairShape === 0
            ? 'polygon(8% 28%, 24% 4%, 74% 3%, 94% 31%, 82% 100%, 16% 100%)'
            : portrait.hairShape === 1
              ? 'ellipse(48% 50% at 50% 52%)'
              : 'polygon(5% 19%, 48% 0%, 95% 22%, 88% 100%, 12% 100%)',
        }}
      />

      <div
        className="absolute left-1/2 top-[29%] h-[30%] w-[28%] -translate-x-1/2 rounded-[46%]"
        style={{ backgroundColor: portrait.face }}
      />

      <div
        className="absolute left-1/2 bottom-[8%] h-[34%] w-[58%] -translate-x-1/2 rounded-t-full"
        style={{
          backgroundColor: portrait.coat,
          clipPath: 'polygon(16% 100%, 25% 18%, 50% 0%, 75% 18%, 84% 100%)',
        }}
      />

      <div
        className="absolute left-1/2 bottom-[19%] h-[18%] w-[30%] -translate-x-1/2 bg-white/78"
        style={{
          clipPath: portrait.collarShape === 0
            ? 'polygon(0% 0%, 50% 56%, 100% 0%, 76% 100%, 24% 100%)'
            : portrait.collarShape === 1
              ? 'polygon(10% 0%, 50% 36%, 90% 0%, 100% 100%, 0% 100%)'
              : 'polygon(0% 18%, 50% 0%, 100% 18%, 78% 100%, 22% 100%)',
        }}
      />

      <div className="absolute inset-x-0 bottom-0 flex h-[24%] items-center justify-center bg-black/24">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: portrait.tone.ink }}>
          {portrait.initials}
        </span>
      </div>
    </div>
  );
};

export default ComposerPortrait;
