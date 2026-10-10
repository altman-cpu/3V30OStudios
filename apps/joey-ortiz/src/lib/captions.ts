/**
 * CAPTION ENGINE — turns a proclamation into lines that can be burned onto the
 * head visualization, timed to the speech.
 *
 * Sync strategy: `react-tts` wraps SpeechSynthesisUtterance and exposes
 * onStart / onEnd but not word-level boundary events. So the runtime speaks one
 * caption line per utterance and advances on `onend` — that is exact sync with
 * no guessing. The estimated durations in `buildCaptionTrack` exist purely as a
 * watchdog: if a browser never fires `onend` (Safari does this on interrupted
 * utterances), the track still advances on its own so the head never freezes.
 */

export interface CaptionLine {
  id: string;
  text: string;
  /** Estimated start offset from the track start, in ms. */
  startAt: number;
  /** Estimated end offset from the track start, in ms. */
  endAt: number;
}

export type CaptionAnchor = 'crown' | 'eyes' | 'mouth' | 'chin';

/** Vertical position (as a fraction of head height) for each anchor point. */
export const ANCHOR_Y: Record<CaptionAnchor, number> = {
  crown: 0.06,
  eyes: 0.4,
  mouth: 0.74,
  chin: 0.96,
};

/** Rough English speech rate used for the fallback timing estimate. */
export const DEFAULT_CHARS_PER_SECOND = 14;

/** Break text into lines that fit `maxChars`, never splitting a word. */
export function splitIntoLines(text: string, maxChars = 42): string[] {
  if (maxChars < 1) throw new RangeError('maxChars must be >= 1');
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = '';
  };

  for (const word of words) {
    // A single word longer than the limit is hard-split rather than overflowed.
    if (word.length > maxChars) {
      flush();
      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars));
      }
      continue;
    }
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maxChars) {
      flush();
      current = word;
    } else {
      current = candidate;
    }
  }
  flush();

  return lines;
}

/** Estimated spoken duration of a line, in ms. */
export function estimateSpeechMs(text: string, charsPerSecond = DEFAULT_CHARS_PER_SECOND): number {
  const rate = charsPerSecond > 0 ? charsPerSecond : DEFAULT_CHARS_PER_SECOND;
  // ~0.6 chars of breathing room per word boundary keeps the estimate honest.
  const effective = text.trim().length + text.trim().split(/\s+/).filter(Boolean).length * 0.6;
  return Math.round((effective / rate) * 1000);
}

/** Assign cumulative start/end offsets to a list of caption lines. */
export function buildCaptionTrack(lines: readonly string[], charsPerSecond = DEFAULT_CHARS_PER_SECOND): CaptionLine[] {
  let cursor = 0;
  return lines.map((text, index) => {
    const duration = estimateSpeechMs(text, charsPerSecond);
    const line: CaptionLine = {
      id: `cap-${index}`,
      text,
      startAt: cursor,
      endAt: cursor + duration,
    };
    cursor += duration;
    return line;
  });
}

/** Which line index should be showing at a given elapsed time. -1 = none yet. */
export function lineIndexAt(track: readonly CaptionLine[], elapsedMs: number): number {
  for (let i = track.length - 1; i >= 0; i -= 1) {
    const line = track[i];
    if (line && elapsedMs >= line.startAt) return i;
  }
  return -1;
}

export interface WordToken {
  word: string;
  /** Character offset within the source line. */
  offset: number;
  length: number;
}

/** Tokenise a line into words with offsets, for per-word caption highlighting. */
export function wordTokens(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    tokens.push({ word: match[0], offset: match.index, length: match[0].length });
    match = pattern.exec(text);
  }
  return tokens;
}

/**
 * Which word index should be highlighted, given progress through the line.
 * `progress` is 0..1 across the line's estimated duration.
 */
export function wordIndexAt(line: CaptionLine, elapsedMs: number): number {
  const span = Math.max(1, line.endAt - line.startAt);
  const progress = Math.min(1, Math.max(0, (elapsedMs - line.startAt) / span));
  const tokens = wordTokens(line.text);
  if (tokens.length === 0) return -1;
  const index = Math.floor(progress * tokens.length);
  return Math.min(index, tokens.length - 1);
}

/** How far through a line we are, 0..1 — drives the mouth flap amplitude. */
export function lineProgress(line: CaptionLine, elapsedMs: number): number {
  const span = Math.max(1, line.endAt - line.startAt);
  return Math.min(1, Math.max(0, (elapsedMs - line.startAt) / span));
}
