import { describe, expect, it } from 'vitest';
import {
  ANCHOR_Y,
  buildCaptionTrack,
  estimateSpeechMs,
  lineIndexAt,
  lineProgress,
  splitIntoLines,
  wordIndexAt,
  wordTokens,
} from '../src/lib/captions';

describe('splitIntoLines', () => {
  it('never splits a word across lines', () => {
    const lines = splitIntoLines('the quick brown fox jumps over the lazy dog', 15);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(15);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('hard-splits a word longer than the limit rather than overflowing', () => {
    const long = 'a'.repeat(50);
    const lines = splitIntoLines(long, 20);
    expect(lines).toHaveLength(3);
    expect(lines.join('')).toBe(long);
  });

  it('handles empty and whitespace-only input', () => {
    expect(splitIntoLines('')).toEqual([]);
    expect(splitIntoLines('   \n  ')).toEqual([]);
  });

  it('collapses runs of whitespace', () => {
    expect(splitIntoLines('a    b\t\tc', 40)).toEqual(['a b c']);
  });

  it('rejects a nonsensical width', () => {
    expect(() => splitIntoLines('x', 0)).toThrow(RangeError);
  });
});

describe('estimateSpeechMs', () => {
  it('scales with text length', () => {
    expect(estimateSpeechMs('short')).toBeLessThan(estimateSpeechMs('a considerably longer line of text'));
  });

  it('is always positive for non-empty text', () => {
    expect(estimateSpeechMs('x')).toBeGreaterThan(0);
  });

  it('falls back to the default rate when given a bad one', () => {
    expect(estimateSpeechMs('hello there', 0)).toBe(estimateSpeechMs('hello there'));
  });
});

describe('buildCaptionTrack', () => {
  it('produces contiguous, monotonically increasing windows', () => {
    const track = buildCaptionTrack(['one two three', 'four five', 'six seven eight nine']);
    expect(track).toHaveLength(3);
    expect(track[0]?.startAt).toBe(0);
    for (let i = 1; i < track.length; i += 1) {
      expect(track[i]?.startAt).toBe(track[i - 1]?.endAt);
      expect((track[i]?.endAt ?? 0) - (track[i]?.startAt ?? 0)).toBeGreaterThan(0);
    }
  });

  it('gives every line a stable id', () => {
    const track = buildCaptionTrack(['a', 'b']);
    expect(track.map((line) => line.id)).toEqual(['cap-0', 'cap-1']);
  });
});

describe('lineIndexAt', () => {
  const track = buildCaptionTrack(['aaa bbb', 'ccc ddd', 'eee fff']);

  it('returns -1 before the track starts', () => {
    expect(lineIndexAt(track, -1)).toBe(-1);
  });

  it('advances through the track as time passes', () => {
    expect(lineIndexAt(track, 0)).toBe(0);
    expect(lineIndexAt(track, track[0]!.endAt)).toBe(1);
    expect(lineIndexAt(track, track[1]!.endAt)).toBe(2);
  });

  it('stays on the final line past the end of the track', () => {
    expect(lineIndexAt(track, track[2]!.endAt + 10_000)).toBe(2);
  });
});

describe('wordTokens', () => {
  it('records offsets and lengths', () => {
    expect(wordTokens('who and why')).toEqual([
      { word: 'who', offset: 0, length: 3 },
      { word: 'and', offset: 4, length: 3 },
      { word: 'why', offset: 8, length: 3 },
    ]);
  });

  it('returns nothing for an empty line', () => {
    expect(wordTokens('')).toEqual([]);
  });
});

describe('wordIndexAt / lineProgress', () => {
  const [line] = buildCaptionTrack(['one two three four']);

  it('walks the words as the line progresses', () => {
    const start = line!.startAt;
    const span = line!.endAt - line!.startAt;
    expect(wordIndexAt(line!, start)).toBe(0);
    expect(wordIndexAt(line!, start + span * 0.5)).toBe(2);
    expect(wordIndexAt(line!, start + span)).toBe(3); // clamped to the last word
  });

  it('clamps progress to 0..1', () => {
    expect(lineProgress(line!, line!.startAt - 100)).toBe(0);
    expect(lineProgress(line!, line!.endAt + 100)).toBe(1);
  });
});

describe('ANCHOR_Y', () => {
  it('orders the caption anchors top to bottom on the head', () => {
    expect(ANCHOR_Y.crown).toBeLessThan(ANCHOR_Y.eyes);
    expect(ANCHOR_Y.eyes).toBeLessThan(ANCHOR_Y.mouth);
    expect(ANCHOR_Y.mouth).toBeLessThan(ANCHOR_Y.chin);
    expect(ANCHOR_Y.chin).toBeLessThanOrEqual(1);
  });
});
