import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TtsBase } from 'react-tts';
import { BlueVette } from './components/BlueVette';
import { HeadCanvas } from './components/HeadCanvas';
import type { CaptionAnchor } from './lib/captions';
import { wordIndexAt } from './lib/captions';
import { guard } from './lib/contentGuard';
import { ALL_IDS, buildProclamation, HEAT_LEVELS, INDICTED, type HeatLevel } from './lib/indictment';
import { useCaptionedSpeech } from './lib/speech/useCaptionedSpeech';
import { localStorageStore } from './lib/storage';
import { formatUptime, JoeyOrtizCore, WORKER_VERSION, type WorkerEvent, type WorkerStatus } from './lib/worker/core';

const STALL_MARK = '__stall__';
const FAIL_MARK = '__fail__';
const ANCHORS: CaptionAnchor[] = ['crown', 'eyes', 'mouth', 'chin'];

const HEAT_ACCENT: Record<HeatLevel, string> = {
  1: '#7fd0ff',
  2: '#6fe3c4',
  3: '#ffd166',
  4: '#ff8a4c',
  5: '#ff4d6d',
};

/** Resolves a worker task once its spoken line has finished. */
class Gate {
  private readonly resolvers = new Map<string, () => void>();

  wait(id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolvers.set(id, resolve);
    });
  }

  release(id: string): void {
    const resolve = this.resolvers.get(id);
    if (!resolve) return;
    this.resolvers.delete(id);
    resolve();
  }

  releaseAll(): void {
    for (const resolve of this.resolvers.values()) resolve();
    this.resolvers.clear();
  }
}

interface LogRow {
  id: number;
  at: number;
  level: string;
  message: string;
}

export default function App(): React.ReactElement {
  const gate = useMemo(() => new Gate(), []);

  const [heat, setHeat] = useState<HeatLevel>(3);
  const [anchor, setAnchor] = useState<CaptionAnchor>('mouth');
  const [selected, setSelected] = useState<readonly string[]>([...ALL_IDS]);
  const [rate, setRate] = useState(0.95);
  const [pitch, setPitch] = useState(0.85);

  const [activeTask, setActiveTask] = useState<{ id: string; line: string } | null>(null);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [logRows, setLogRows] = useState<LogRow[]>([]);
  const [recovering, setRecovering] = useState(false);

  const coreRef = useRef<JoeyOrtizCore | null>(null);
  const speakingTaskRef = useRef<string | null>(null);
  const startedForRef = useRef<string | null>(null);
  const logIdRef = useRef(0);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushLog = useCallback((level: string, message: string): void => {
    logIdRef.current += 1;
    const row: LogRow = { id: logIdRef.current, at: Date.now(), level, message };
    setLogRows((rows) => [row, ...rows].slice(0, 60));
  }, []);

  // ------------------------------------------------------------- the worker

  const core = useMemo(() => {
    if (coreRef.current) return coreRef.current;

    const runner = async (task: { id: string; payload: string }): Promise<void> => {
      if (task.payload.startsWith(STALL_MARK)) {
        // Deliberately hangs and never calls beat(): this is what the watchdog
        // exists for.
        pushLog('warn', `STALL SIMULATION: ${task.payload.slice(STALL_MARK.length)}`);
        await new Promise<void>(() => undefined);
        return;
      }
      if (task.payload.startsWith(FAIL_MARK)) {
        throw new Error(task.payload.slice(FAIL_MARK.length) || 'injected failure');
      }

      // Runtime guard: nothing reaches the speaker without passing.
      const check = guard(task.payload);
      if (!check.ok) {
        throw new Error(`content guard rejected this line (${check.violations[0]?.kind ?? 'unknown'})`);
      }

      setActiveTask({ id: task.id, line: task.payload });
      const finished = gate.wait(task.id);

      // Speech takes seconds, longer than the watchdog threshold. Beat so the
      // loop can tell "slow" from "hung".
      beatRef.current = setInterval(() => coreRef.current?.beat(), 400);
      try {
        await finished;
      } finally {
        if (beatRef.current !== null) {
          clearInterval(beatRef.current);
          beatRef.current = null;
        }
      }
    };

    const instance = new JoeyOrtizCore({
      store: localStorageStore,
      runner,
      heartbeatMs: 500,
      stallAfterMs: 8_000,
      maxAttempts: 3,
      onEvent: (event: WorkerEvent) => {
        switch (event.type) {
          case 'stall':
            pushLog('error', `WATCHDOG: heartbeat stale ${event.sinceMs}ms`);
            break;
          case 'recover':
            pushLog('warn', `RECOVERED (${event.reason})`);
            setRecovering(true);
            setTimeout(() => setRecovering(false), 1_200);
            break;
          case 'task:done':
            pushLog('info', `cleared: ${truncate(event.task.label)}`);
            break;
          case 'task:failed':
            pushLog('error', `parked: ${truncate(event.task.label)} — ${event.error}`);
            break;
          case 'task:retry':
            pushLog('warn', `retry: ${truncate(event.task.label)} — ${event.error}`);
            break;
          case 'persist-failed':
            pushLog('warn', 'snapshot write failed; loop continuing');
            break;
          default:
            break;
        }
      },
    });

    coreRef.current = instance;
    return instance;
  }, [gate, pushLog]);

  // Rehydrate any work that was mid-flight when the tab last closed.
  useEffect(() => {
    const requeued = core.restore();
    if (requeued > 0) pushLog('warn', `restored session: ${requeued} task(s) re-queued`);
    core.start();
    return () => {
      core.stop();
      gate.releaseAll();
    };
  }, [core, gate, pushLog]);

  // Mirror worker status into React on a light poll.
  useEffect(() => {
    const id = setInterval(() => setStatus(core.status()), 250);
    setStatus(core.status());
    return () => clearInterval(id);
  }, [core]);

  // ---------------------------------------------------------------- speech

  const speechLines = useMemo(() => (activeTask ? [activeTask.line] : []), [activeTask]);
  const speech = useCaptionedSpeech(speechLines, { rate, pitch });

  // Start speaking whenever a new task's line becomes active.
  useEffect(() => {
    if (!activeTask) return;
    if (startedForRef.current === activeTask.id) return;
    startedForRef.current = activeTask.id;
    speakingTaskRef.current = activeTask.id;
    speech.start();
  }, [activeTask, speech]);

  // When the line finishes, release the worker task so the loop moves on.
  useEffect(() => {
    const id = speakingTaskRef.current;
    if (!id) return;
    if (speech.playing || speech.finishedCount < 1) return;
    speakingTaskRef.current = null;
    setActiveTask(null);
    gate.release(id);
  }, [gate, speech.finishedCount, speech.playing]);

  // -------------------------------------------------------------- controls

  const toggleId = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const readCharges = (): void => {
    gate.releaseAll();
    speakingTaskRef.current = null;
    startedForRef.current = null;
    setActiveTask(null);

    // With nobody charged there is nothing to indict — do not read an empty
    // scroll's opening and closing remarks as if they were content.
    if (selected.length === 0) {
      pushLog('warn', 'nothing selected to read');
      return;
    }

    const proclamation = buildProclamation([...selected], heat);
    if (proclamation.violations.length > 0) {
      pushLog('error', `content guard dropped ${proclamation.violations.length} line(s)`);
    }
    if (proclamation.lines.length === 0) {
      pushLog('warn', 'nothing selected to read');
      return;
    }
    for (const line of proclamation.lines) core.enqueue(line, line);
    pushLog('info', `queued ${proclamation.lines.length} caption line(s) at ${proclamation.heatName}`);
  };

  const stopAll = (): void => {
    speech.cancel();
    gate.releaseAll();
    speakingTaskRef.current = null;
    startedForRef.current = null;
    setActiveTask(null);
  };

  const injectFailure = (): void => {
    core.enqueue('INJECTED FAILURE', `${FAIL_MARK}simulated crash in migration step`);
    pushLog('warn', 'injected a task that throws');
  };

  const simulateStall = (): void => {
    core.enqueue('STALL SIMULATION', `${STALL_MARK}runner hangs without a heartbeat`);
    pushLog('warn', 'injected a task that hangs');
  };

  const forceRecover = (): void => {
    core.recover('operator');
  };

  // ---------------------------------------------------------------- render

  const track = speech.track;
  const currentIndex = speech.index;
  const caption = speech.currentLine?.text ?? null;
  const activeWordIndex = speech.currentLine ? wordIndexAt(speech.currentLine, speech.currentLine.startAt + speech.progress * (speech.currentLine.endAt - speech.currentLine.startAt)) : -1;

  const load = speech.playing ? 0.55 + speech.progress * 0.45 : status && status.queueDepth > 0 ? 0.3 : 0.08;
  const rpm = 900 + load * 6200;
  const accent = HEAT_ACCENT[heat];
  const heatName = HEAT_LEVELS.find((level) => level.level === heat)?.name ?? 'COLD READ';

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>
            JOEY ORTIZ <span className="masthead__ver">v{WORKER_VERSION}</span>
          </h1>
          <p className="masthead__tag">
            The worker that keeps working. Co-driver: BLUE VETTE v{WORKER_VERSION}. Voice: react-tts.
          </p>
        </div>
        <div className="masthead__lights">
          <span className="light" data-on={status?.running ? 'true' : 'false'} title="loop running" />
          <span className="light light--warn" data-on={recovering ? 'true' : 'false'} title="recovering" />
          <span className="light light--bad" data-on={status?.stalled ? 'true' : 'false'} title="stalled" />
        </div>
      </header>

      {!speech.supported && (
        <p className="notice">
          This browser exposes no SpeechSynthesis, so captions run silently on the estimated track. Everything else is
          unaffected.
        </p>
      )}

      <main className="grid">
        <section className="panel panel--head">
          <h2>CAPTIONS ON THE HEAD</h2>
          <HeadCanvas
            caption={caption}
            prevCaption={currentIndex > 0 ? track[currentIndex - 1]?.text : undefined}
            nextCaption={currentIndex >= 0 ? track[currentIndex + 1]?.text : undefined}
            anchor={anchor}
            speaking={speech.playing && !speech.paused}
            progress={speech.progress}
            activeWordIndex={activeWordIndex}
            accent={accent}
            heatName={heatName}
          />
          <div className="control-row">
            <label className="control">
              <span>Caption anchor</span>
              <select value={anchor} onChange={(event) => setAnchor(event.target.value as CaptionAnchor)}>
                {ANCHORS.map((option) => (
                  <option key={option} value={option}>
                    {option.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span>Rate {rate.toFixed(2)}</span>
              <input type="range" min={0.6} max={1.4} step={0.05} value={rate} onChange={(event) => setRate(Number(event.target.value))} />
            </label>
            <label className="control">
              <span>Pitch {pitch.toFixed(2)}</span>
              <input type="range" min={0.4} max={1.4} step={0.05} value={pitch} onChange={(event) => setPitch(Number(event.target.value))} />
            </label>
          </div>
        </section>

        <div className="stack">
          <BlueVette
            load={load}
            running={Boolean(status?.running)}
            stalled={Boolean(status?.stalled)}
            recovering={recovering}
            uptime={formatUptime(status?.uptimeMs ?? 0)}
            version={WORKER_VERSION}
            rpm={rpm}
            ticks={status?.ticks ?? 0}
            recovers={status?.recovers ?? 0}
          />

          <section className="panel">
            <h2>VITALS</h2>
            <dl className="vitals">
              <div>
                <dt>LOOP</dt>
                <dd data-tone={status?.running ? 'good' : 'bad'}>{status?.running ? 'RUNNING' : 'STOPPED'}</dd>
              </div>
              <div>
                <dt>HEARTBEAT</dt>
                <dd>{status ? `${status.heartbeatAgeMs}ms` : '—'}</dd>
              </div>
              <div>
                <dt>QUEUE</dt>
                <dd>{status?.queueDepth ?? 0}</dd>
              </div>
              <div>
                <dt>CLEARED</dt>
                <dd>{status?.doneCount ?? 0}</dd>
              </div>
              <div>
                <dt>PARKED</dt>
                <dd data-tone={(status?.failedCount ?? 0) > 0 ? 'warn' : undefined}>{status?.failedCount ?? 0}</dd>
              </div>
              <div>
                <dt>STALLS</dt>
                <dd data-tone={(status?.stalls ?? 0) > 0 ? 'warn' : undefined}>{status?.stalls ?? 0}</dd>
              </div>
            </dl>
            <div className="actions">
              <button type="button" className="btn btn--primary" onClick={readCharges}>
                READ THE CHARGES
              </button>
              <button type="button" className="btn" onClick={() => (speech.paused ? speech.resume() : speech.pause())} disabled={!speech.playing}>
                {speech.paused ? 'RESUME' : 'PAUSE'}
              </button>
              <button type="button" className="btn" onClick={stopAll}>
                STOP
              </button>
              <button type="button" className="btn btn--warn" onClick={injectFailure}>
                INJECT FAILURE
              </button>
              <button type="button" className="btn btn--warn" onClick={simulateStall}>
                SIMULATE STALL
              </button>
              <button type="button" className="btn" onClick={forceRecover}>
                FORCE RECOVER
              </button>
            </div>
          </section>
        </div>

        <section className="panel panel--board">
          <div className="board-head">
            <h2>WHO &amp; WHY — THE INDICTMENT SCROLL</h2>
            <div className="heat">
              <span className="heat__label">HEAT</span>
              {HEAT_LEVELS.map((level) => (
                <button
                  key={level.level}
                  type="button"
                  className="heat__btn"
                  data-active={heat === level.level ? 'true' : 'false'}
                  data-level={level.level}
                  onClick={() => setHeat(level.level)}
                  title={level.blurb}
                >
                  {level.level} · {level.name}
                </button>
              ))}
            </div>
          </div>
          <p className="board-note">{HEAT_LEVELS.find((level) => level.level === heat)?.blurb}</p>

          <div className="board-tools">
            <button type="button" className="btn btn--small" onClick={() => setSelected([...ALL_IDS])}>
              SELECT ALL
            </button>
            <button type="button" className="btn btn--small" onClick={() => setSelected([])}>
              CLEAR
            </button>
            <span className="board-count">
              {selected.length} / {INDICTED.length} charged
            </span>
          </div>

          <div className="board">
            {INDICTED.map((entry) => (
              <article key={entry.id} className="dossier" data-selected={selected.includes(entry.id) ? 'true' : 'false'}>
                <label className="dossier__pick">
                  <input type="checkbox" checked={selected.includes(entry.id)} onChange={() => toggleId(entry.id)} />
                  <span className="dossier__handle">{entry.handle}</span>
                </label>
                <h3 className="dossier__title">{entry.title}</h3>
                <p className="dossier__row">
                  <strong>WHO</strong> {entry.who}
                </p>
                <p className="dossier__row">
                  <strong>WHY</strong> {entry.why}
                </p>
                <ul className="dossier__charges">
                  {entry.charges.map((charge) => (
                    <li key={charge}>{charge}</li>
                  ))}
                </ul>
                <p className="dossier__verdict">{entry.verdicts[heat]}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>EVENT LOG</h2>
          <ol className="eventlog">
            {logRows.length === 0 && <li className="eventlog__empty">no events yet — press READ THE CHARGES</li>}
            {logRows.map((row) => (
              <li key={row.id} data-level={row.level}>
                <time>{new Date(row.at).toLocaleTimeString()}</time>
                <span>{row.message}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="footnote">
        The heat on this board is aimed at the code, the commit and the process — never at a named human being. Every
        spoken line is filtered through the content guard before it reaches react-tts.
      </footer>

      {/* The react-tts engine. Rendered headless: it speaks whatever caption line
          the worker has made active, and the caption layer mirrors it. */}
      <div className="sr-engine" aria-hidden="true">
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
    </div>
  );
}

function truncate(text: string, max = 52): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
