/**
 * react-tts@1.0.2 ships no type declarations, so this module declares the
 * surface the app actually uses. Signatures were read from the published
 * dist/ sources (TtsBase.js, Tts.js, TtsButton.js, useTts.js).
 *
 * Caveat worth remembering: TtsBase sets its defaults via `defaultProps`,
 * which React 19 ignores for function components. Always pass `text`
 * explicitly — see test/react-tts.test.tsx, which pins that behaviour.
 */
declare module 'react-tts' {
  import type { ComponentType, ForwardRefExoticComponent, ReactNode, Ref, RefAttributes } from 'react';

  export interface TtsEngineHandle {
    speak(): void;
    pause(): void;
    resume(): void;
    cancel(): void;
  }

  export interface TtsBaseProps {
    Component?: ComponentType<Record<string, unknown>> | null;
    autoplay?: boolean;
    lang?: string;
    pitch?: number | null;
    rate?: number | null;
    text?: string;
    voice?: SpeechSynthesisVoice | null;
    volume?: number | null;
    onEnd?: (() => void) | null;
    onError?: ((error: unknown) => void) | null;
    onPause?: (() => void) | null;
    onResume?: (() => void) | null;
    onStart?: (() => void) | null;
    synth?: SpeechSynthesis;
    children?: ReactNode;
    [key: string]: unknown;
  }

  export const TtsBase: ForwardRefExoticComponent<TtsBaseProps & RefAttributes<TtsEngineHandle>>;

  export interface TtsProps extends TtsBaseProps {
    disableClick?: boolean;
    variant?: 'cancel' | 'speak' | 'pause' | 'resume';
  }

  export function Tts<P extends Record<string, unknown>>(
    Component: ComponentType<P>,
  ): ComponentType<P & TtsProps>;

  export const TtsButton: ComponentType<
    TtsProps & {
      cancel?: ComponentType<Record<string, unknown>>;
      pause?: ComponentType<Record<string, unknown>>;
      resume?: ComponentType<Record<string, unknown>>;
      speak?: ComponentType<Record<string, unknown>>;
    }
  >;

  export function useTts(synth?: SpeechSynthesis): {
    paused: boolean;
    pending: boolean;
    speaking: boolean;
    cancel(): void;
    getVoices(): SpeechSynthesisVoice[];
    pause(): void;
    resume(): void;
    speak(utterance: SpeechSynthesisUtterance): void;
  };

  const _default: {
    Tts: typeof Tts;
    TtsBase: typeof TtsBase;
    TtsButton: typeof TtsButton;
    useTts: typeof useTts;
  };
  export default _default;
}
