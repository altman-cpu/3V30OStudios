import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TtsBase } from 'react-tts';
import { useCaptionedSpeech, type CaptionedSpeech } from '../src/lib/speech/useCaptionedSpeech';

/**
 * End-to-end test of the caption/speech path against the real react-tts
 * component and a fake SpeechSynthesis that behaves like the platform:
 * speak() is preceded by cancel(), onStart fires on speak, onend fires when
 * the utterance completes.
 *
 * The headline assertion is `index` staying at 0 after start(): react-tts
 * emits a spurious onEnd from inside speak(), and without the arming gate the
 * track would have already advanced to line 1 before a single word was said.
 */

interface FakeUtterance {
  text: string;
  onstart?: (event: unknown) => void;
  onend?: (event: unknown) => void;
  onerror?: (event: unknown) => void;
}

class FakeSpeechSynthesis {
  /** Every text handed to speak(), in order. cancel() does not clear this. */
  readonly spoken: string[] = [];
  current: FakeUtterance | null = null;
  speaking = false;
  paused = false;
  pending = false;
  cancelCount = 0;

  speak(utterance: FakeUtterance): void {
    this.spoken.push(utterance.text);
    this.current = utterance;
    this.speaking = true;
    utterance.onstart?.({});
  }

  cancel(): void {
    this.cancelCount += 1;
    this.current = null;
    this.speaking = false;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  getVoices(): unknown[] {
    return [];
  }

  /** Simulate the platform finishing the active utterance. */
  finish(): void {
    this.current?.onend?.({});
  }
}

class FakeUtteranceImpl {
  text: string;
  lang = '';
  pitch = 1;
  rate = 1;
  volume = 1;
  onstart: ((event: unknown) => void) | null = null;
  onend: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

let synth: FakeSpeechSynthesis;
let latest: CaptionedSpeech | null = null;

function Harness({ lines }: { lines: readonly string[] }): React.ReactElement {
  const speech = useCaptionedSpeech(lines);
  latest = speech;
  return (
    <div>
      <span data-testid="index">{speech.index}</span>
      <span data-testid="caption">{speech.currentLine?.text ?? ''}</span>
      <span data-testid="spoken">{speech.spokenCount}</span>
      <span data-testid="finished">{speech.finishedCount}</span>
      <span data-testid="fallback">{String(speech.fallbackUsed)}</span>
      <span data-testid="rejected">{speech.rejectedEnds}</span>
      <TtsBase
        ref={speech.engineRef}
        text={speech.engineProps.text}
        rate={speech.engineProps.rate}
        pitch={speech.engineProps.pitch}
        volume={speech.engineProps.volume}
        onStart={speech.engineProps.onStart}
        onEnd={speech.engineProps.onEnd}
        onError={speech.engineProps.onError}
      />
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // Keep the animation-frame clock inert so the test controls all time.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);

  synth = new FakeSpeechSynthesis();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  latest = null;
});

const LINES = ['who and why', 'the dry-run dodger', 'the verdict is procedural'] as const;

describe('useCaptionedSpeech with real react-tts', () => {
  it('does NOT advance on the spurious onEnd that react-tts emits inside speak()', () => {
    render(<Harness lines={LINES} />);

    act(() => {
      latest?.start();
    });

    // The bug this guards: a spurious onEnd would already have moved us to 1.
    expect(screen.getByTestId('index').textContent).toBe('0');
    expect(screen.getByTestId('caption').textContent).toBe('who and why');
    expect(screen.getByTestId('spoken').textContent).toBe('1');
    expect(synth.spoken).toEqual(['who and why']);
  });

  it('advances exactly one line per real onend, through to the end of the track', () => {
    render(<Harness lines={LINES} />);

    act(() => {
      latest?.start();
    });
    expect(screen.getByTestId('index').textContent).toBe('0');

    // Past the 250ms grace window, but well inside the line's estimated
    // duration, so the fallback cannot be what moves us.
    act(() => {
      vi.advanceTimersByTime(300);
      synth.finish();
    });
    expect(screen.getByTestId('index').textContent).toBe('1');
    expect(screen.getByTestId('caption').textContent).toBe('the dry-run dodger');

    act(() => {
      vi.advanceTimersByTime(300);
      synth.finish();
    });
    expect(screen.getByTestId('index').textContent).toBe('2');
    expect(screen.getByTestId('caption').textContent).toBe('the verdict is procedural');

    act(() => {
      vi.advanceTimersByTime(300);
      synth.finish();
    });
    // Past the last line the track closes rather than running off the end.
    expect(screen.getByTestId('index').textContent).toBe('-1');
    expect(latest?.playing).toBe(false);
    expect(screen.getByTestId('finished').textContent).toBe('3');
    expect(latest?.fallbackUsed).toBe(false);

    expect(synth.spoken).toEqual([...LINES]);
  });

  it('ignores a late onend from a cancelled utterance', () => {
    render(<Harness lines={LINES} />);

    act(() => {
      latest?.start();
    });
    const first = synth.current;
    act(() => {
      vi.advanceTimersByTime(300);
      synth.finish();
    });
    expect(screen.getByTestId('index').textContent).toBe('1');
    const rejectedBefore = Number(screen.getByTestId('rejected').textContent);

    // The cancelled first utterance reports late. Line 2 has already started,
    // so arming alone would not catch this — the grace window must.
    act(() => {
      first?.onend?.({});
    });
    expect(screen.getByTestId('index').textContent).toBe('1');
    expect(Number(screen.getByTestId('rejected').textContent)).toBe(rejectedBefore + 1);
  });

  it('keeps the caption moving on the fallback timer when onend never arrives', () => {
    render(<Harness lines={LINES} />);

    act(() => {
      latest?.start();
    });
    expect(screen.getByTestId('index').textContent).toBe('0');

    // Line 1 is ~871ms of estimated speech, so its fallback fires near 1394ms.
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByTestId('fallback').textContent).toBe('true');
    expect(screen.getByTestId('index').textContent).toBe('1');
  });

  it('cancel() stops the track and resets to no caption', () => {
    render(<Harness lines={LINES} />);

    act(() => {
      latest?.start();
    });
    act(() => {
      latest?.cancel();
    });

    expect(screen.getByTestId('index').textContent).toBe('-1');
    expect(screen.getByTestId('caption').textContent).toBe('');
    expect(latest?.playing).toBe(false);
  });

  it('passes the active line through to react-tts as the utterance text', () => {
    render(<Harness lines={LINES} />);

    act(() => {
      latest?.start();
    });
    act(() => {
      vi.advanceTimersByTime(300);
      synth.finish();
    });

    expect(synth.spoken[synth.spoken.length - 1]).toBe('the dry-run dodger');
  });
});
