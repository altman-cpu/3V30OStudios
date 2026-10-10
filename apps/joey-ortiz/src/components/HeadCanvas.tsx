import type { CaptionAnchor } from '../lib/captions';
import { ANCHOR_Y } from '../lib/captions';

interface HeadCanvasProps {
  caption: string | null;
  prevCaption?: string;
  nextCaption?: string;
  anchor: CaptionAnchor;
  speaking: boolean;
  /** 0..1 progress through the current line — drives the mouth flap. */
  progress: number;
  /** Index of the word currently being spoken, for per-word highlighting. */
  activeWordIndex: number;
  accent: string;
  heatName: string;
}

const VIEW_W = 420;
const VIEW_H = 500;
const HEAD_TOP = 46;
const HEAD_HEIGHT = 300;

/** Absolute Y for a caption anchor, in viewBox units. */
function anchorY(anchor: CaptionAnchor): number {
  return HEAD_TOP + ANCHOR_Y[anchor] * HEAD_HEIGHT;
}

/**
 * Split a caption into words and mark the one currently being spoken.
 *
 * Words are separated by a real space text node rather than &nbsp; so long
 * captions wrap normally instead of overflowing the head.
 */
function CaptionWords({ text, activeWordIndex }: { text: string; activeWordIndex: number }): React.ReactElement {
  const words = text.split(' ');
  return (
    <>
      {words.map((word, index) => (
        <span key={`${index}-${word}`}>
          <span className={index === activeWordIndex ? 'cap-word cap-word--active' : 'cap-word'}>{word}</span>
          {index < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

export function HeadCanvas({
  caption,
  prevCaption,
  nextCaption,
  anchor,
  speaking,
  progress,
  activeWordIndex,
  accent,
  heatName,
}: HeadCanvasProps): React.ReactElement {
  // Mouth openness oscillates while speaking so the head visibly "talks".
  const flap = speaking ? 0.3 + 0.7 * Math.abs(Math.sin(progress * Math.PI * 7)) : 0.06;
  const mouthRx = 26;
  const mouthRy = 4 + flap * 16;

  // Eyes blink on a slow cycle driven by progress so it feels alive.
  const blink = speaking && Math.sin(progress * Math.PI * 3.1) > 0.97;
  const eyeRy = blink ? 1.2 : 9;

  const capY = anchorY(anchor);

  return (
    <div className="head-canvas">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={`Head with caption: ${caption ?? 'silent'}`}>
        <defs>
          <radialGradient id="headFill" cx="42%" cy="30%" r="78%">
            <stop offset="0%" stopColor="#2b3a63" />
            <stop offset="60%" stopColor="#16203c" />
            <stop offset="100%" stopColor="#0a0f20" />
          </radialGradient>
          <linearGradient id="capBar" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accent} stopOpacity="0" />
            <stop offset="18%" stopColor={accent} stopOpacity="0.9" />
            <stop offset="82%" stopColor={accent} stopOpacity="0.9" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
          <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* shoulders + neck */}
        <path d="M96 470 q114 -70 228 0 v30 h-228 z" fill="#0d1428" />
        <path d="M180 330 h60 v70 h-60 z" fill="#131c34" />

        {/* head */}
        <ellipse cx="210" cy="196" rx="108" ry="150" fill="url(#headFill)" stroke={accent} strokeOpacity="0.55" strokeWidth="2" />

        {/* circuitry etched into the skull */}
        <g stroke={accent} strokeOpacity="0.22" fill="none" strokeWidth="1">
          <path d="M120 130 h40 v-24 h34" />
          <path d="M300 130 h-40 v-24 h-34" />
          <path d="M132 250 h30 v22 h26" />
          <path d="M288 250 h-30 v22 h-26" />
          <circle cx="194" cy="106" r="3" fill={accent} fillOpacity="0.5" />
          <circle cx="226" cy="106" r="3" fill={accent} fillOpacity="0.5" />
        </g>

        {/* brows */}
        <path d="M150 152 q26 -16 52 -4" stroke={accent} strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.75" />
        <path d="M218 148 q26 -12 52 4" stroke={accent} strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.75" />

        {/* eyes */}
        <g filter="url(#softGlow)">
          <ellipse cx="170" cy="186" rx="17" ry={eyeRy} fill={accent} />
          <ellipse cx="250" cy="186" rx="17" ry={eyeRy} fill={accent} />
        </g>

        {/* nose */}
        <path d="M210 200 v34 l-14 12" stroke={accent} strokeOpacity="0.45" strokeWidth="3" fill="none" strokeLinecap="round" />

        {/* mouth — flaps while speaking */}
        <ellipse cx="210" cy="292" rx={mouthRx} ry={mouthRy} fill={accent} opacity={speaking ? 0.85 : 0.35} filter="url(#softGlow)" />

        {/* caption anchor marker */}
        <line x1="30" y1={capY} x2="390" y2={capY} stroke="url(#capBar)" strokeWidth="1" opacity="0.5" />

        {/* captions, burned onto the head */}
        <foreignObject x="16" y={capY - 62} width="388" height="124">
          <div className="cap-stack" data-speaking={speaking ? 'true' : 'false'}>
            {prevCaption ? <div className="cap-line cap-line--ghost">{prevCaption}</div> : <div className="cap-line cap-line--ghost">&nbsp;</div>}
            <div className="cap-line cap-line--live">
              {caption ? <CaptionWords text={caption} activeWordIndex={activeWordIndex} /> : <span className="cap-idle">— silent —</span>}
            </div>
            {nextCaption ? <div className="cap-line cap-line--ghost">{nextCaption}</div> : <div className="cap-line cap-line--ghost">&nbsp;</div>}
          </div>
        </foreignObject>
      </svg>

      <div className="head-readout">
        <span className="head-readout__dot" data-on={speaking ? 'true' : 'false'} />
        <span>{speaking ? 'VOCALISING' : 'IDLE'}</span>
        <span className="head-readout__sep">/</span>
        <span>CAPTION ANCHOR: {anchor.toUpperCase()}</span>
        <span className="head-readout__sep">/</span>
        <span>HEAT: {heatName}</span>
      </div>
    </div>
  );
}
