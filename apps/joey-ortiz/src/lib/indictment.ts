/**
 * THE INDICTMENT SCROLL — "WHO and WHY."
 *
 * Twelve archetypes of the bitcoin-migration engineer, each with a WHO (who
 * they are), a WHY (what they did and what it cost), a set of charges, and a
 * verdict line for each of five heat levels.
 *
 * Every archetype is a *pattern of behaviour*, not a person. The handles are
 * invented. Nothing here identifies a real engineer, and `contentGuard` will
 * reject any attempt to make it do so. See test/contentGuard.test.ts.
 */

import type { Violation } from './contentGuard';
import { guard } from './contentGuard';

export type HeatLevel = 1 | 2 | 3 | 4 | 5;

export const HEAT_LEVELS: ReadonlyArray<{
  level: HeatLevel;
  name: string;
  blurb: string;
}> = [
  { level: 1, name: 'COLD READ', blurb: 'Forensic. No adjectives, no mercy needed.' },
  { level: 2, name: 'COURTROOM', blurb: 'Under oath, on the record, unflattering.' },
  { level: 3, name: 'INDICTMENT', blurb: 'Charges read aloud. The room goes quiet.' },
  { level: 4, name: 'PYRE', blurb: 'Theatre. Sparks. Deliberately loud.' },
  { level: 5, name: 'SCORCHED EARTH', blurb: 'Maximum heat, still aimed at the code.' },
];

export interface Indicted {
  id: string;
  handle: string;
  title: string;
  who: string;
  why: string;
  charges: string[];
  verdicts: Record<HeatLevel, string>;
}

export const INDICTED: readonly Indicted[] = [
  {
    id: 'dryrun-dodger',
    handle: '@dryrun_dodger',
    title: 'THE DRY-RUN DODGER',
    who: 'The engineer who shipped a balance migration with the dry-run flag commented out, "just this once."',
    why: 'They mistook confidence for verification. Every satoshi that moved, moved blind, and the only rollback plan was a screenshot of their own optimism.',
    charges: ['commented out the dry run', 'migrated on a Friday', 'called it "basically a no-op"'],
    verdicts: {
      1: 'The flag existed for a reason, and that reason was you.',
      2: 'You had the safety switch in your hand and decided it was optional.',
      3: 'This board finds you guilty of rehearsing nothing and premiering everything.',
      4: 'You did not skip a step. You skipped the parachute and called it a light packing strategy.',
      5: 'BURN THE BRANCH THAT TRUSTED YOU. You turned a rehearsal stage into a live grenade range and walked away whistling.',
    },
  },
  {
    id: 'idempotency-impostor',
    handle: '@idempotency_impostor',
    title: 'THE IDEMPOTENCY IMPOSTOR',
    who: 'The author of a migration that could be run exactly once, in one exact order, by one exact person who no longer works here.',
    why: 'They wrote a procedure and called it a program. Retry it and it double-spends. Resume it and it skips. Ask it why and it fails in a language nobody left behind.',
    charges: ['no replay protection', 'no resume marker', 'bus factor of one and the bus has left'],
    verdicts: {
      1: 'A script that cannot be safely re-run is a script that cannot be safely run.',
      2: 'You labelled it idempotent. The ledger disagrees, loudly, in duplicate.',
      3: 'This board finds you built a one-shot device and filed it under "reusable tooling."',
      4: 'You wrote a bomb with a manual and then lost the manual and then lost the bomb.',
      5: 'YOUR MIGRATION HAS ONE GEAR AND IT IS STUCK ON DETONATE. Every retry is a fresh crater and you are still calling it progress.',
    },
  },
  {
    id: 'rollback-refugee',
    handle: '@rollback_refugee',
    title: 'THE ROLLBACK REFUGEE-MAKER',
    who: 'Whoever wrote the forward migration and quietly forgot to write the way home.',
    why: 'Half the table is migrated, half is not, and the join between them is a work of fiction. That is not a migration. That is a partition with feelings.',
    charges: ['down-migration absent', 'half-committed schema', 'recovery plan is "we will see"'],
    verdicts: {
      1: 'You built a door and no hallway.',
      2: 'Forward-only is a choice you made on behalf of everyone who came after you.',
      3: 'This board finds you left the system in a state it cannot describe about itself.',
      4: 'You did not ship a migration, you shipped a one-way ticket and kept the return half.',
      5: 'EVERY ROW YOU TOUCHED IS NOW A REFUGEE IN ITS OWN DATABASE. No passport, no route home, no owner brave enough to claim it.',
    },
  },
  {
    id: 'testnet-tourist',
    handle: '@testnet_tourist',
    title: 'THE TESTNET TOURIST',
    who: 'The dev who tested thoroughly — on a chain where the coins are free and the consequences are imaginary.',
    why: 'Testnet has no fee spikes, no mempool pressure, no orphaned blocks and no angry treasury. Passing there proves your code compiles, not that it survives.',
    charges: ['"it worked on testnet"', 'no reorg coverage', 'no fee-stress case'],
    verdicts: {
      1: 'Testnet is a rehearsal hall, not a load-bearing floor.',
      2: 'You tested the happy path in a building with no weather.',
      3: 'This board finds you proved the code runs and confused that with proving it holds.',
      4: 'You took a life raft out in the bathtub, declared it seaworthy, and boarded it in the open ocean.',
      5: 'YOUR ENTIRE ASSURANCE CAME FROM A SANDBOX WITH NO TIDE. The first real wave did not negotiate, and you had not even learned to swim.',
    },
  },
  {
    id: 'satoshi-shifter',
    handle: '@decimal_shruggie',
    title: 'THE SATOSHI SHIFTER',
    who: 'Whoever moved a decimal point in a value field and let it propagate through four services before anybody noticed.',
    why: 'Satoshis in, dollars out, apology nowhere. Integer arithmetic is not a style preference — it is the entire reason the ledger closes at the end of the day.',
    charges: ['floats in a money path', 'silent unit coercion', 'no invariant on total supply'],
    verdicts: {
      1: 'Money is an integer or it is a rumour.',
      2: 'You let a floating point value decide how much someone owned.',
      3: 'This board finds you treated precision as a rounding opinion.',
      4: 'You did the accounting with a ruler made of jelly and were surprised the building leaned.',
      5: 'A SINGLE DECIMAL, MOVED BY ONE FINGER, REWROTE WHO WAS RICH. That is not a bug you shipped, that is a theft you automated.',
    },
  },
  {
    id: 'key-janitor-absent',
    handle: '@key_janitor_absent',
    title: 'THE ABSENT KEY JANITOR',
    who: 'The one who wrote the signing key into a config file, in plaintext, in version control, with a comment that said "temporary."',
    why: 'Temporary is a promise made to a repository that keeps promises forever. History is append-only, and so is your exposure.',
    charges: ['secret in version control', 'no rotation plan', '"temporary" comment, permanent consequences'],
    verdicts: {
      1: 'A committed secret is a published secret.',
      2: 'You stored the crown jewels in the guest book.',
      3: 'This board finds you handed out the master key and filed it under documentation.',
      4: 'You did not misplace the key, you engraved it on the front gate and laminated it.',
      5: 'EVERY CLONE OF THAT REPO IS A COPY OF YOUR MASTER KEY. You did not leak a credential, you minted an heirloom of your own carelessness.',
    },
  },
  {
    id: 'mainnet-gambler',
    handle: '@mainnet_gambler',
    title: 'THE MAINNET GAMBLER',
    who: 'Whoever treated a live consensus rule change as a feature flag with a canary.',
    why: 'You cannot A/B test a fork. Half the network agreed with you and the other half simply became a different currency while you were watching the dashboard.',
    charges: ['consensus change behind a flag', 'no signalling window', 'canary deployed at full blast'],
    verdicts: {
      1: 'Consensus is not a rollout percentage.',
      2: 'You ran an experiment on a system that has no undo button.',
      3: 'This board finds you tested a rule change on the only network that exists.',
      4: 'You flipped a coin, called it a deployment strategy, and let the whole world be the losing side.',
      5: 'YOU DID NOT SHIP A FEATURE, YOU SHIP-DECLARED A SCHISM. Two chains now carry your name as a cautionary footnote.',
    },
  },
  {
    id: 'checksum-cosplayer',
    handle: '@checksum_cosplayer',
    title: 'THE CHECKSUM COSPLAYER',
    who: 'The dev who computed the checksum, compared it, ignored the result, and shipped anyway.',
    why: 'Verification you do not act on is decoration. The hash told the truth, and the truth got outvoted in a stand-up.',
    charges: ['mismatch logged, not raised', 'alert downgraded to info', 'shipped on a hunch'],
    verdicts: {
      1: 'A check that cannot fail is not a check.',
      2: 'You installed a smoke detector with the battery removed.',
      3: 'This board finds you verified, learned, and proceeded regardless.',
      4: 'You asked the hash a direct question, heard the answer, and decided you knew better than mathematics.',
      5: 'THE HASH WAS SCREAMING AND YOU TURNED DOWN THE VOLUME. That is not optimism, that is a signed confession with a green build badge.',
    },
  },
  {
    id: 'replay-window',
    handle: '@replay_open',
    title: 'THE REPLAY WINDOW OPENER',
    who: 'Whoever migrated signed transactions without invalidating the old replay surface.',
    why: 'Every unexpired signature is still a live grenade with a timer nobody reset. The window you left open has a doormat and a welcome mat.',
    charges: ['no nonce invalidation', 'stale signatures accepted', 'no chain-id separation'],
    verdicts: {
      1: 'An accepted signature needs an expiry and an audience.',
      2: 'You left the old door unlocked while installing a new one.',
      3: 'This board finds you made replay attacks a configuration detail.',
      4: 'You built a vault, left the old combination valid, and hung the note on the handle.',
      5: 'EVERY STALE SIGNATURE YOU LEFT ALIVE IS A STANDING INVITATION. Attackers did not break in — you held the door and waved.',
    },
  },
  {
    id: 'utxo-butcher',
    handle: '@utxo_butcher',
    title: 'THE UTXO BUTCHER',
    who: 'The one who flattened unspent outputs into a single mutable balance column because "it was easier to query."',
    why: 'They did not simplify the model, they deleted the proof. What remains is a number with excellent indexing and no witnesses.',
    charges: ['provenance discarded', 'history collapsed to a scalar', 'audit reduced to trust'],
    verdicts: {
      1: 'A balance without its inputs is an assertion, not a record.',
      2: 'You traded verifiability for a shorter SQL statement.',
      3: 'This board finds you removed the evidence to make the courtroom tidier.',
      4: 'You burned the receipts to make the shoebox lighter and called it minimalism.',
      5: 'YOU DELETED THE WITNESSES AND KEPT THE VERDICT. That number on screen is now a rumour with a primary key and nothing to defend it.',
    },
  },
  {
    id: 'silent-migrator',
    handle: '@migrator_silent',
    title: 'THE SILENT MIGRATOR',
    who: 'Whoever ran a state migration with no log line, no metric, no alert, and no announcement.',
    why: 'A migration nobody can observe is indistinguishable from an outage nobody has noticed yet. Silence is not stability, it is just latency.',
    charges: ['zero observability', 'no before/after counts', 'announced to nobody'],
    verdicts: {
      1: 'Unlogged is unowned.',
      2: 'You moved the data and told no one where it went.',
      3: 'This board finds you operated in the dark by choice.',
      4: 'You performed surgery with the lights off and declined to keep notes.',
      5: 'YOU DID NOT MIGRATE IN SECRET, YOU DISAPPEARED THE AUDIT TRAIL WHILE STANDING IN IT. If it goes wrong, nobody will even know which day to blame.',
    },
  },
  {
    id: 'force-push-phantom',
    handle: '@force_push_phantom',
    title: 'THE FORCE-PUSH PHANTOM',
    who: 'The one who rewrote history on the shared branch that carried the migration code.',
    why: 'Now the audit trail is a campfire story. Provenance is not a nicety — it is the difference between "we know what ran" and "we believe what ran."',
    charges: ['history rewritten', 'no signed tag', 'no record of what actually deployed'],
    verdicts: {
      1: 'Rewritten history is unverifiable history.',
      2: 'You edited the transcript after the verdict.',
      3: 'This board finds you destroyed the evidence to tidy the timeline.',
      4: 'You burned the flight recorder to make the hangar look cleaner.',
      5: 'THE RECORD OF WHAT RAN IS ASH BECAUSE YOU WANTED A PRETTY GRAPH. From here on, every claim about that deploy is folklore.',
    },
  },
];

const OPENERS: Record<HeatLevel, string> = {
  1: 'Reading the record. Twelve files, twelve fingerprints, no adjectives.',
  2: 'This board is now in session. The record is open and it is not flattering.',
  3: 'Hear the charges. Every one of them was signed by someone who thought nobody would check.',
  4: 'Strike the gavel and light the lamps. What follows is not a review, it is a reckoning.',
  5: 'Open the doors and let the smoke out. This is the part where the code gets read its rights.',
};

const CLOSERS: Record<HeatLevel, string> = {
  1: 'Record closed. The lesson is free: dry-run, roll back, and log everything.',
  2: 'Court adjourned. Fix the down-migration before you fix your reputation.',
  3: 'The verdict is unanimous and it is not personal. It is procedural, which is worse.',
  4: 'Let the pyre burn down to embers. Every one of these is survivable if you write the rollback first.',
  5: 'SCORCHED. And still standing: the ledger survived you, which is the only compliment on offer.',
};

/** The disclaimer spoken at heat 4-5 so the target is never ambiguous. */
const SCOPE_NOTE =
  'For the record: this heat is aimed at the code, the commit, and the process. Never at a named human being.';

export interface Proclamation {
  heat: HeatLevel;
  heatName: string;
  lines: string[];
  violations: Violation[];
}

/**
 * Build the spoken / captioned script for a set of indicted archetypes.
 *
 * Every line passes through `guard()` before it enters the script. A line that
 * fails is dropped and its violation reported, so a tampered corpus cannot
 * smuggle a real name or a slur into the audio track.
 */
export function buildProclamation(ids: string[], heat: HeatLevel): Proclamation {
  const selected = INDICTED.filter((entry) => ids.includes(entry.id));
  const violations: Violation[] = [];
  const lines: string[] = [];

  const push = (candidate: string): void => {
    const result = guard(candidate);
    if (!result.ok) {
      violations.push(...result.violations);
      return;
    }
    lines.push(candidate);
  };

  push(OPENERS[heat]);
  if (heat >= 4) push(SCOPE_NOTE);

  for (const entry of selected) {
    push(`Who. ${entry.title}, filing as ${entry.handle}. ${entry.who}`);
    push(`Why. ${entry.why}`);
    push(`The verdict. ${entry.verdicts[heat]}`);
  }

  push(CLOSERS[heat]);

  return {
    heat,
    heatName: HEAT_LEVELS.find((level) => level.level === heat)?.name ?? 'COLD READ',
    lines,
    violations,
  };
}

/** All archetype ids, for the "select everything" control. */
export const ALL_IDS: readonly string[] = INDICTED.map((entry) => entry.id);
