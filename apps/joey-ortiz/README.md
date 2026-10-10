# JOEY ORTIZ v0.0.1 — *keeps working*

Co-driver: **BLUE VETTE v0.0.1**. Voice: **react-tts**. Captions: **on the head**.

A single-page React console that reads out a **WHO & WHY** indictment scroll — twelve
archetypes of the bitcoin-migration engineer — through `react-tts`, with every spoken
line burned onto an animated head, driven by a work loop whose only real requirement is
that it survives everything.

```
npm install      # once
npm run dev      # http://localhost:5173
npm test         # 79 tests
npm run build    # typecheck + production bundle
```

From the repository root: `npm run joey:dev`, `npm run joey:test`, `npm run joey:build`.

---

## What is on screen

| Piece | What it does |
| --- | --- |
| **Captions on the head** | An SVG head whose mouth flaps and eyes blink while speaking. The active caption is burned over it, with the word being spoken highlighted. Four anchor points: crown, eyes, mouth, chin. |
| **WHO & WHY board** | Twelve dossiers. Each has a **WHO** (who they are), a **WHY** (what they did and what it cost), a charge list, and a verdict that rewrites itself at each heat level. |
| **Heat dial** | Five levels — COLD READ → COURTROOM → INDICTMENT → PYRE → SCORCHED EARTH. |
| **BLUE VETTE v0.0.1** | A blue mid-engine sports car whose tachometer, wheel speed and exhaust track the work loop. Revs while a line is spoken, idles when the queue is empty, flashes on a watchdog fire. Shows real uptime, ticks and recoveries. |
| **Vitals + event log** | Heartbeat age, queue depth, cleared/parked/stalls, and a running log of what the loop did. |

`INJECT FAILURE`, `SIMULATE STALL` and `FORCE RECOVER` are there so you can watch the
worker take a hit and get back up rather than take that claim on faith.

## "Keeps working" is a spec, not a slogan

`src/lib/worker/core.ts` handles three failure modes explicitly, and each one has a test:

1. **A task throws** — attempts increment, backoff is quadratic (0s, 1s, 4s, 9s…), and
   after `maxAttempts` the task is parked as `failed`. The loop continues.
2. **A task hangs** — the watchdog notices the heartbeat has gone stale, reclaims the
   slot, re-queues the task and resumes. A genuinely slow task calls `beat()` so the
   watchdog can tell *slow* from *hung*.
3. **The page dies** — every state change is snapshotted to `localStorage`; on boot
   `restore()` rehydrates and re-queues anything that was mid-flight.

Broken observers, storage quota failures and rejected ticks are all caught and counted,
never propagated. Time and storage are injected (`Clock`, `SnapshotStore`), which is what
makes the above testable without waiting on real milliseconds.

## Two react-tts quirks, found and worked around

`react-tts@1.0.2` predates React 19. Both behaviours below are pinned by tests in
`test/react-tts.test.tsx` so a future upgrade cannot silently reintroduce them:

- **`speak()` fires a spurious `onEnd` first.** `TtsBase` implements
  `speak()` as `cancel(); …` and `cancel` as `handle(ttsCancel, onEnd)`. Advancing
  captions on every `onEnd` therefore skips every other line.
- **A cancelled utterance can deliver a late `onend`**, *after* the next line's
  `onStart` — so gating on `onStart` alone is not enough.

`useCaptionedSpeech` gates `onEnd` behind both `onStart` **and** a 250 ms grace window,
and keeps an independent fallback timer per line so the head can never freeze mid-sentence
on a browser that never fires `onend`.

Captions advance **one line per utterance** rather than per script. That gives exact
sync without needing SpeechSynthesis word-boundary events, which react-tts does not
surface.

## On the provoking language

The heat is aimed at **the code, the commit and the process** — never at a person. All
twelve archetypes are invented behavioural patterns with invented handles; no real
engineer is named anywhere in the corpus.

`src/lib/contentGuard.ts` enforces this rather than trusting it. Every line passes the
guard before it can be spoken or captioned, and the guard hard-blocks:

- real, identifiable people in the Bitcoin/crypto/dev space
- emails, phone numbers, IP addresses, street addresses, wallet addresses, private keys,
  profile links
- slurs
- threats against a person, their home or their body

`test/indictment.test.ts` asserts the entire corpus — every WHO, WHY, charge and verdict,
at all five heat levels — passes that guard, and that a tampered corpus gets its offending
line dropped rather than spoken.

## Layout

```
src/lib/clock.ts                     injectable time (systemClock + FakeClock)
src/lib/storage.ts                   injectable persistence (localStorage + MemoryStore)
src/lib/worker/core.ts               JoeyOrtizCore: queue, heartbeat, watchdog, retry, restore
src/lib/captions.ts                  line splitting, timing estimates, word offsets, anchors
src/lib/indictment.ts                the WHO & WHY corpus and the five heat levels
src/lib/contentGuard.ts              the safety filter
src/lib/speech/useCaptionedSpeech.ts react-tts driver with the onEnd guards
src/components/HeadCanvas.tsx        the head + burned-in captions
src/components/BlueVette.tsx         the blue car + tachometer
src/App.tsx                          the console
```

## Tests

```
npm test
```

79 tests across 6 files. `test/app.test.tsx` is the integration path: it renders the real
`App`, clicks **READ THE CHARGES**, and asserts the proclamation reaches react-tts, lands
as a caption on the head, advances line by line, and shows up as cleared work in the log.
The speech tests run against the real `react-tts` component with a fake
`SpeechSynthesis` that behaves like the platform.
