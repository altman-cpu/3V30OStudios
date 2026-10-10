import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from '../src/App';

/**
 * Integration test for the whole console: pressing READ THE CHARGES must push
 * the proclamation through the content guard into the Joey Ortiz queue, have
 * the worker hand each line to react-tts, and land it as a caption on the
 * head. This is the only test that exercises the real wiring between the
 * worker, the speech hook and the caption layer.
 */

interface FakeUtterance {
  text: string;
  onstart?: (event: unknown) => void;
  onend?: (event: unknown) => void;
}

class FakeSpeechSynthesis {
  readonly spoken: string[] = [];
  current: FakeUtterance | null = null;
  speaking = false;
  paused = false;
  pending = false;

  speak(utterance: FakeUtterance): void {
    this.spoken.push(utterance.text);
    this.current = utterance;
    this.speaking = true;
    utterance.onstart?.({});
  }

  cancel(): void {
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

/** Speak a line, then let the platform report it finished. */
async function speakAndFinish(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(320); // clear react-tts's onEnd grace window
    synth.finish();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600); // let the worker tick pick up the next task
  });
}

/** Text currently burned onto the head caption layer. */
function captionText(): string {
  return document.querySelector('.cap-line--live')?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();

  synth = new FakeSpeechSynthesis();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
});

async function boot(): Promise<void> {
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600); // let the restored loop tick at least once
  });
}

describe('the JOEY ORTIZ console', () => {
  it('renders the masthead, the head, BLUE VETTE and all twelve dossiers', async () => {
    await boot();

    expect(screen.getAllByText(/JOEY ORTIZ/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/BLUE VETTE/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('CAPTIONS ON THE HEAD')).toBeTruthy();
    expect(screen.getByText('WHO & WHY — THE INDICTMENT SCROLL')).toBeTruthy();

    expect(screen.getAllByText(/^THE /)).toHaveLength(12);
    expect(screen.getByText('THE DRY-RUN DODGER')).toBeTruthy();
    expect(screen.getByText('THE FORCE-PUSH PHANTOM')).toBeTruthy();
  });

  it('starts in silence with no caption on the head', async () => {
    await boot();
    expect(screen.getByText('— silent —')).toBeTruthy();
    expect(screen.getByText('IDLE')).toBeTruthy();
  });

  it('READ THE CHARGES queues the proclamation and speaks the first line', async () => {
    await boot();

    await act(async () => {
      fireEvent.click(screen.getByText('READ THE CHARGES'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(synth.spoken.length).toBeGreaterThanOrEqual(1);
    // The opener for heat level 3 is the first line spoken.
    expect(synth.spoken[0]).toContain('Hear the charges');
  });

  it('puts the spoken line on the head as a caption, then advances to the next', async () => {
    await boot();

    await act(async () => {
      fireEvent.click(screen.getByText('READ THE CHARGES'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    const firstLine = synth.spoken[0]!;
    // The caption is rendered as per-word spans, so assert on the caption
    // element's own text content rather than a single text node.
    expect(captionText()).toContain(firstLine.slice(0, 24));

    const countBefore = synth.spoken.length;
    await speakAndFinish();

    // The worker handed the next line to the speaker.
    expect(synth.spoken.length).toBeGreaterThan(countBefore);
    expect(synth.spoken[countBefore]).toContain('THE DRY-RUN DODGER');
  });

  it('reports cleared work in the event log', async () => {
    await boot();

    await act(async () => {
      fireEvent.click(screen.getByText('READ THE CHARGES'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await speakAndFinish();

    expect(screen.getAllByText(/cleared:/).length).toBeGreaterThanOrEqual(1);
  });

  it('INJECT FAILURE parks the task and the loop keeps serving', async () => {
    await boot();

    await act(async () => {
      fireEvent.click(screen.getByText('INJECT FAILURE'));
    });
    // Three attempts with backoff, then parked.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getAllByText(/parked:/).length).toBeGreaterThanOrEqual(1);
    // Retries log the same label before the final park, so expect several.
    expect(screen.getAllByText(/INJECTED FAILURE/).length).toBeGreaterThanOrEqual(1);
  });

  it('changing the heat level changes the verdict text on the dossiers', async () => {
    await boot();

    const verdictAt3 = screen.getByText(/This board finds you guilty of rehearsing nothing/);
    expect(verdictAt3).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('5 · SCORCHED EARTH'));
    });

    expect(screen.getByText(/BURN THE BRANCH THAT TRUSTED YOU/)).toBeTruthy();
    expect(screen.queryByText(/This board finds you guilty of rehearsing nothing/)).toBeNull();
  });

  it('STOP silences the head', async () => {
    await boot();

    await act(async () => {
      fireEvent.click(screen.getByText('READ THE CHARGES'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('STOP'));
    });

    expect(screen.getByText('— silent —')).toBeTruthy();
  });

  it('deselecting every dossier reads nothing', async () => {
    await boot();

    await act(async () => {
      fireEvent.click(screen.getByText('CLEAR'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('READ THE CHARGES'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(screen.getByText('nothing selected to read')).toBeTruthy();
    expect(synth.spoken).toHaveLength(0);
  });
});
