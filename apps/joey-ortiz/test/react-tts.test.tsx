import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { TtsBase } from 'react-tts';

/**
 * react-tts@1.0.2 was written for React 17/18 and leans on
 * `TtsBase.defaultProps` for `synth`, `text`, and friends. React 19 removed
 * defaultProps support for function components, so these tests pin down what
 * actually still works: the component must mount, honour an explicit `text`
 * prop, and fire onEnd. Everything in the app depends on that.
 */

interface FakeUtterance {
  text: string;
  lang?: string;
  pitch?: number;
  rate?: number;
  volume?: number;
  onstart?: (event: unknown) => void;
  onend?: (event: unknown) => void;
  onerror?: (event: unknown) => void;
}

class FakeSpeechSynthesis {
  readonly utterances: FakeUtterance[] = [];
  speaking = false;
  paused = false;
  pending = false;

  speak(utterance: FakeUtterance): void {
    this.utterances.push(utterance);
    this.speaking = true;
    utterance.onstart?.({});
  }

  cancel(): void {
    this.utterances.length = 0;
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

function installFakes(): FakeSpeechSynthesis {
  const synth = new FakeSpeechSynthesis();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtteranceImpl);
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  return synth;
}

interface Handle {
  speak(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
}

describe('react-tts under React 19', () => {
  it('mounts TtsBase without throwing despite removed defaultProps', () => {
    const synth = installFakes();
    const ref = createRef<Handle>();

    expect(() => render(<TtsBase ref={ref} text="probe" />)).not.toThrow();
    expect(synth.utterances).toHaveLength(0); // nothing spoken until speak() is called
  });

  it('speaks the explicit text prop through the imperative handle', () => {
    const synth = installFakes();
    const ref = createRef<Handle>();
    render(<TtsBase ref={ref} text="who and why" rate={0.9} pitch={0.8} volume={1} />);

    act(() => {
      ref.current?.speak();
    });

    expect(synth.utterances).toHaveLength(1);
    const utterance = synth.utterances[0];
    expect(utterance?.text).toBe('who and why');
    expect(utterance?.rate).toBe(0.9);
    expect(utterance?.pitch).toBe(0.8);
  });

  it('re-reads the text prop on each render, so line-by-line speech tracks the caption', () => {
    const synth = installFakes();
    const ref = createRef<Handle>();
    const { rerender } = render(<TtsBase ref={ref} text="line one" />);

    act(() => {
      ref.current?.speak();
    });
    rerender(<TtsBase ref={ref} text="line two" />);
    act(() => {
      ref.current?.speak();
    });

    // Note the behaviour this pins down: react-tts speak() calls cancel()
    // first, so a new line replaces the pending utterance rather than queuing.
    expect(synth.utterances.map((u) => u.text)).toEqual(['line two']);
  });

  it('DOCUMENTS THE QUIRK: speak() fires a spurious onEnd before speaking', () => {
    const synth = installFakes();
    const ref = createRef<Handle>();
    const onEnd = vi.fn();
    render(<TtsBase ref={ref} text="advance me" onEnd={onEnd} />);

    act(() => {
      ref.current?.speak();
    });

    // TtsBase implements speak() as `cancel(); ...speak(utterance)`, and
    // cancel() as `handle(ttsCancel, onEnd)`. So onEnd has already run once
    // before a single word is uttered. This is why useCaptionedSpeech gates
    // onEnd behind onStart plus a grace window.
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenLastCalledWith();

    const utterance = synth.utterances[0];
    act(() => {
      utterance?.onend?.({});
    });

    // ...and again on genuine completion: two calls per line in total.
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it('fires onStart, used to stamp the caption clock', () => {
    installFakes();
    const ref = createRef<Handle>();
    const onStart = vi.fn();
    render(<TtsBase ref={ref} text="stamp me" onStart={onStart} />);

    act(() => {
      ref.current?.speak();
    });

    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
