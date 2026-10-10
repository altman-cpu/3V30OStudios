import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCaptionTrack, type CaptionLine } from '../captions';

export interface TtsEngineHandle {
  speak(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export interface TtsEngineProps {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: unknown) => void;
}

export interface CaptionedSpeech {
  /** True when the browser exposes SpeechSynthesis at all. */
  supported: boolean;
  /** Index of the line currently being spoken, or -1. */
  index: number;
  playing: boolean;
  paused: boolean;
  /** Estimated track — used for fallback timing and word highlighting. */
  track: CaptionLine[];
  /** The line that should be on screen right now, or null. */
  currentLine: CaptionLine | null;
  /** 0..1 progress through the current line — drives the mouth flap. */
  progress: number;
  /** How many lines actually began speaking (react-tts onStart). */
  spokenCount: number;
  /** How many lines completed, by onEnd or by the fallback timer. */
  finishedCount: number;
  /** Set when a caption advanced on the fallback timer rather than onEnd. */
  fallbackUsed: boolean;
  /** How many spurious/late onEnd callbacks were rejected. */
  rejectedEnds: number;
  start(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  engineRef: React.RefObject<TtsEngineHandle | null>;
  engineProps: TtsEngineProps;
}

/** Safety factor on the estimated duration before the fallback advances. */
const FALLBACK_SLACK = 1.6;

/**
 * onEnd callbacks arriving within this window of a speak() call are rejected.
 *
 * Two react-tts behaviours make this necessary (both pinned by tests):
 *   1. `speak()` calls `cancel()`, and react-tts defines
 *      `cancel = () => handle(ttsCancel, onEnd)` — so EVERY speak() emits a
 *      spurious onEnd before saying a word.
 *   2. The cancelled utterance can also deliver a late onend, which arrives
 *      *after* the next line's onStart. Arming on onStart alone cannot tell it
 *      apart from a genuine completion, so a time window is required.
 *
 * Real utterances last far longer than this, so no genuine completion is lost.
 */
const ONEND_GRACE_MS = 250;

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
}

/**
 * Drives react-tts one caption line at a time so the caption on the head is
 * exactly the line being spoken.
 *
 * Advancement has two independent paths, either of which alone keeps the track
 * moving: `onEnd` (subject to the grace window above) and a fallback timer
 * derived from the estimated line duration. The fallback guarantees the head
 * visualization can never freeze mid-sentence on a browser that never fires
 * onend.
 */
export function useCaptionedSpeech(
  lines: readonly string[],
  options: { rate?: number; pitch?: number; volume?: number; now?: () => number } = {},
): CaptionedSpeech {
  const { rate = 0.95, pitch = 0.9, volume = 1, now = () => Date.now() } = options;

  const supported = useMemo(() => isSpeechSupported(), []);
  const track = useMemo(() => buildCaptionTrack([...lines]), [lines]);

  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [spokenCount, setSpokenCount] = useState(0);
  const [finishedCount, setFinishedCount] = useState(0);
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [rejectedEnds, setRejectedEnds] = useState(0);
  const [elapsedInLine, setElapsedInLine] = useState(0);

  const engineRef = useRef<TtsEngineHandle | null>(null);

  /** Bumped on every line change so stale callbacks can be identified. */
  const tokenRef = useRef(0);
  /** Timestamp of the speak() call for the active line. */
  const spokenAtRef = useRef(0);
  /** True once onStart has fired for the active line. */
  const armedRef = useRef(false);
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const lineStartRef = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  const clearTimers = useCallback((): void => {
    if (fallbackRef.current !== null) {
      clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** Advance to the next line, ignoring callbacks from a superseded line. */
  const advance = useCallback(
    (token: number, viaFallback: boolean): void => {
      if (tokenRef.current !== token) return;
      clearTimers();
      armedRef.current = false;
      if (viaFallback) setFallbackUsed(true);
      setFinishedCount((count) => count + 1);
      setIndex((current) => {
        if (current + 1 >= lines.length) {
          setPlaying(false);
          setPaused(false);
          return -1;
        }
        return current + 1;
      });
    },
    [clearTimers, lines.length],
  );

  const start = useCallback((): void => {
    if (lines.length === 0) return;
    clearTimers();
    tokenRef.current += 1;
    armedRef.current = false;
    try {
      engineRef.current?.cancel();
    } catch {
      /* engine not mounted yet */
    }
    setSpokenCount(0);
    setFinishedCount(0);
    setFallbackUsed(false);
    setRejectedEnds(0);
    setElapsedInLine(0);
    setPaused(false);
    setPlaying(true);
    setIndex(0);
  }, [clearTimers, lines.length]);

  const cancel = useCallback((): void => {
    clearTimers();
    tokenRef.current += 1;
    armedRef.current = false;
    try {
      engineRef.current?.cancel();
    } catch {
      /* ignore */
    }
    setPlaying(false);
    setPaused(false);
    setElapsedInLine(0);
    setIndex(-1);
  }, [clearTimers]);

  const pause = useCallback((): void => {
    if (!playing || paused) return;
    clearTimers();
    try {
      engineRef.current?.pause();
    } catch {
      /* ignore */
    }
    setPaused(true);
  }, [clearTimers, paused, playing]);

  const resume = useCallback((): void => {
    if (!playing || !paused) return;
    const token = tokenRef.current;
    try {
      engineRef.current?.resume();
    } catch {
      /* ignore */
    }
    setPaused(false);
    const line = index >= 0 ? track[index] : undefined;
    if (line) {
      lineStartRef.current = nowRef.current();
      fallbackRef.current = setTimeout(
        () => advance(token, true),
        (line.endAt - line.startAt) * FALLBACK_SLACK,
      );
    }
  }, [advance, index, paused, playing, track]);

  // Kick off speech whenever the active line changes.
  useEffect(() => {
    if (!playing || index < 0 || index >= lines.length) return;

    const token = ++tokenRef.current;
    armedRef.current = false;
    const line = track[index];
    const estimatedMs = line ? line.endAt - line.startAt : 1000;

    spokenAtRef.current = nowRef.current();
    lineStartRef.current = spokenAtRef.current;

    const step = (): void => {
      setElapsedInLine(nowRef.current() - lineStartRef.current);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    fallbackRef.current = setTimeout(() => advance(token, true), estimatedMs * FALLBACK_SLACK);

    try {
      // The ref handle is rebound on every render of <TtsBase>, so by the time
      // this effect runs it is already bound to the current `text` prop.
      engineRef.current?.speak();
    } catch {
      // No engine mounted (or an unsupported browser): silent captions still run.
    }

    return () => {
      clearTimers();
    };
  }, [advance, clearTimers, index, lines.length, playing, track]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const currentLine = index >= 0 && index < track.length ? track[index] ?? null : null;
  const lineDuration = currentLine ? Math.max(1, currentLine.endAt - currentLine.startAt) : 1;
  const progress = currentLine ? Math.min(1, Math.max(0, elapsedInLine / lineDuration)) : 0;

  const engineProps: TtsEngineProps = {
    text: currentLine?.text ?? '',
    rate,
    pitch,
    volume,
    onStart: () => {
      armedRef.current = true;
      lineStartRef.current = nowRef.current();
      setSpokenCount((count) => count + 1);
    },
    onEnd: () => {
      // Reject the spurious onEnd from inside speak(), and any late onend from
      // a cancelled utterance. Both land inside the grace window.
      if (!armedRef.current || nowRef.current() - spokenAtRef.current < ONEND_GRACE_MS) {
        setRejectedEnds((count) => count + 1);
        return;
      }
      advance(tokenRef.current, false);
    },
    onError: () => {
      // The already-armed fallback timer carries the track forward.
    },
  };

  return {
    supported,
    index,
    playing,
    paused,
    track,
    currentLine,
    progress,
    spokenCount,
    finishedCount,
    fallbackUsed,
    rejectedEnds,
    start,
    pause,
    resume,
    cancel,
    engineRef,
    engineProps,
  };
}
