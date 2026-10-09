'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  REALITY GENERATOR  —  what the miners actually mine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  The commander's directive: "complete a full crypto miners stack … but let it
 *  generate REALITY instead of cryptocurrency only."
 *
 *  So this stack keeps the *whole* proof-of-work machinery — headers, nonces,
 *  difficulty targets, retargeting, shares, stale/orphan handling, pool payout
 *  splits — and changes exactly one thing: the coinbase.
 *
 *      bitcoin-style chain :  block reward  →  coins (a number that goes up)
 *      entropy reality chain:  block reward  →  reality fragments (content that
 *                                               becomes playable world)
 *
 *  A mined block hash is a 256-bit seed. This module turns that seed into
 *  deterministic, checksummed *world content*:
 *
 *      scene      — a place you can now go to (feeds AR map layers)
 *      law        — a rule of the world (feeds seasons / governance)
 *      voice      — a line of dialogue (feeds companion conversation)
 *      terrain    — heightfield + biome parameters (feeds mission generation)
 *      artifact   — an item blueprint (feeds loadouts / Power Weaving)
 *      glyph      — a symbol with a resonance value (feeds HUD + seals)
 *      weather    — an atmospheric state (feeds world events)
 *      memory     — a recoverable trace (feeds Entropy Memory)
 *
 *  Because it is derived from the hash and not written by hand, the output is:
 *      • infinite (every block is new),
 *      • reproducible (any node can re-derive it from the hash alone),
 *      • verifiable (each fragment carries its own entropy address),
 *      • and free of any monetary claim — nothing here is a security, a token
 *        sale, or a currency. Units are *Reality Units (RLU)*: an internal
 *        accounting number for how much world content a miner contributed.
 *
 *  Conversation: `conversationFrom()` assembles multi-speaker exchanges from
 *  fragment seeds, which is how the mining stack "makes conversation" — squad
 *  companions literally speak mined reality.
 */

const { deriveAddress, createRng, hashHex, clamp, round } = require('./entropy-core');

/* ── lexicons ───────────────────────────────────────────────────────────────
 * Small, hand-written, evocative. The combinatorics (not the vocabulary) do
 * the heavy lifting: 12×14×12 ≈ 2k noun phrases per slot, and each fragment
 * draws 4–7 slots, so repeats across a normal chain are effectively nil.
 */

const LEX = Object.freeze({
  placePrefix: ['Mirror', 'Quiet', 'Solar', 'Hollow', 'Bright', 'Deep', 'Glass', 'Amber', 'Signal', 'Cinder', 'Velvet', 'Iron'],
  placeCore: ['Basin', 'Terrace', 'Archive', 'Reef', 'Spire', 'Causeway', 'Orchard', 'Foundry', 'Atrium', 'Lighthouse', 'Quarry', 'Garden', 'Observatory', 'Harbor'],
  placeSuffix: ['of the Ninth Tide', 'below the Long Antenna', 'of Unmask Light', 'where the Weave Thins', 'of the Quiet Choir', 'at the Edge of Scan', 'of Chromium Rain', 'beyond the Third Gate', 'of Held Breath', 'under the Pale Spiral', 'of the Second Sunrise', 'near the Lost Party'],
  biome: ['salt flat', 'cloud forest', 'glass desert', 'tidal shelf', 'moss cathedral', 'ice arcade', 'copper canyon', 'lantern marsh', 'ash steppe', 'coral terrace'],
  structure: ['arch', 'bridge', 'well', 'gate', 'kiln', 'beacon', 'stair', 'vault', 'loom', 'pier', 'spire', 'cistern'],
  material: ['chromium', 'salt glass', 'woven basalt', 'pale copper', 'resin amber', 'cold porcelain', 'iridium silk', 'fired clay', 'sunbleached oak'],
  lightCondition: ['low iridescent', 'hard noon', 'blue dusk', 'fog-diffused', 'strobe-scan', 'candle-warm', 'overcast pearl', 'prism-split'],
  lawSubject: ['The Watchtower', 'The Weave Council', 'The Quiet Accord', 'The Ninth Tide', 'The Unmask Court', 'The Lantern Guild', 'The Party Compact'],
  lawVerb: ['forbids', 'permits', 'requires', 'remembers', 'witnesses', 'rewards', 'shelters', 'measures'],
  lawObject: ['unsealed memory', 'borrowed light', 'a companion left behind', 'unscored kindness', 'a raid entered alone', 'any loadout shared in trust', 'the first word of a season', 'an expired seal'],
  lawClause: ['unless two witnesses co-sign', 'until the season turns', 'when the scan layer is open', 'inside a safe lobby only', 'after the retarget', 'if the smart value holds', 'without a plated overlay'],
  voiceSpeaker: ['Evolynn', 'SkyyBleu', 'Tru', 'Phiya', 'Tom', 'the Watchtower', 'a lagging companion', 'the pool foreman', 'an unmasked seal'],
  voiceMood: ['steady', 'amused', 'wary', 'tender', 'clipped', 'wondering', 'dry', 'urgent'],
  voiceOpener: ['Hold the scan open', 'I remember that loadout', 'Two more shares and we surface', 'You always flank left', 'The retarget is coming', 'Do not unmask that alone', 'This place was mined, not built', 'Say the phrase again'],
  voiceCloser: ['and I will hold the gate', 'so we walk it together', 'before the light changes', 'and the seal will keep', 'while the party is still warm', 'then we rest', 'and the world writes itself', 'so the squad learns it'],
  weatherNoun: ['chromium rain', 'static bloom', 'pearl fog', 'ember drift', 'signal snow', 'glass wind', 'lantern haze', 'quiet aurora'],
  weatherVerb: ['settles over', 'moves through', 'thickens above', 'clears from', 'sparks across'],
  glyphName: ['ŽEON', 'BLEU', 'UNMASK', 'TIDE', 'LOOM', 'HALO', 'PIER', 'SIGIL', 'CIRCUIT', 'TESSERA', 'AEGIS', 'VESSEL'],
  artifactFamily: ['gauntlet', 'visor', 'lantern', 'weave-loom', 'resonator', 'field kit', 'tether', 'aegis plate', 'scan rod', 'memory cradle'],
  artifactTrait: ['self-plating', 'harmonic', 'tide-locked', 'iridescent', 'quiet-damped', 'share-bonded', 'recall-etched', 'squad-tuned'],
  tactic: ['flank-left', 'hold-gate', 'overwatch', 'burst-scan', 'shield-front', 'kite-back', 'focus-fire', 'revive-first', 'high-ground', 'split-push'],
  memoryKind: ['first win', 'lost raid', 'loadout change', 'companion rescue', 'season turn', 'unmask ceremony', 'scan discovery', 'lobby truce'],
});

const FRAGMENT_KINDS = Object.freeze(['scene', 'law', 'voice', 'terrain', 'artifact', 'glyph', 'weather', 'memory']);

/* Rarity ladder: hash-derived, so the chain naturally produces a long tail. */
const RARITIES = Object.freeze([
  { id: 'common', weight: 52, multiplier: 1, label: 'Common' },
  { id: 'refined', weight: 26, multiplier: 1.8, label: 'Refined' },
  { id: 'iridescent', weight: 14, multiplier: 3.4, label: 'Iridescent' },
  { id: 'plated', weight: 6, multiplier: 6.5, label: 'Chromium-Plated' },
  { id: 'unmasked', weight: 2, multiplier: 14, label: 'Genesis Unmasked' },
]);

/* ─────────────────────────── fragment synthesis ─────────────────────────── */

function pickRarity(rng) {
  return rng.weighted(RARITIES.map((r) => [r, r.weight]));
}

function place(rng) {
  return `${rng.pick(LEX.placePrefix)} ${rng.pick(LEX.placeCore)} ${rng.pick(LEX.placeSuffix)}`;
}

/**
 * Turn any 64-hex hash into a signed reality fragment.
 *
 * @param {object} opts
 * @param {string} opts.hash        64-hex digest (block hash, seal hash, …)
 * @param {string} opts.seed        network genesis seed
 * @param {number} [opts.index]     fragment index inside the block
 * @param {string} [opts.kind]      force a kind (default: hash-derived)
 * @param {string} [opts.parent]    parent address (block address)
 * @returns {object} fragment
 */
function fragmentFromHash({ hash, seed, index = 0, kind = null, parent = null }) {
  if (!/^[0-9a-f]{64}$/i.test(String(hash || ''))) throw new Error('fragmentFromHash needs a 64-hex digest');
  const rng = createRng(`reality|${seed}|${hash.toLowerCase()}|${index}`);
  const chosen = kind && FRAGMENT_KINDS.includes(kind) ? kind : rng.pick(FRAGMENT_KINDS);
  const rarity = pickRarity(rng);
  const resonance = round(rng.float(0.2, 1) * rarity.multiplier, 3);
  const address = deriveAddress({ domain: 'RLT', seed, label: hash.toLowerCase(), sublabel: `${index}:${chosen}` });

  const base = {
    kind: chosen,
    rarity: rarity.id,
    rarityLabel: rarity.label,
    rarityMultiplier: rarity.multiplier,
    resonance,
    rlu: round(resonance * 12, 2), // Reality Units: content contribution accounting
    address: address.address,
    evmAddress: address.evm,
    sourceHash: hash.toLowerCase(),
    index,
    parent,
    codename: `${LEX.glyphName[rng.int(LEX.glyphName.length)]}-${rng.range(100, 999)}`,
    tags: [],
  };

  switch (chosen) {
    case 'scene': {
      base.title = place(rng);
      base.text = `${base.title}: a ${rng.pick(LEX.biome)} lit ${rng.pick(LEX.lightCondition)}, with a ${rng.pick(LEX.material)} ${rng.pick(LEX.structure)} at its centre.`;
      base.biome = rng.pick(LEX.biome);
      base.light = rng.pick(LEX.lightCondition);
      base.structure = rng.pick(LEX.structure);
      base.material = rng.pick(LEX.material);
      base.tags = ['ar:map', 'mission:venue'];
      break;
    }
    case 'law': {
      const subject = rng.pick(LEX.lawSubject);
      const verb = rng.pick(LEX.lawVerb);
      const object = rng.pick(LEX.lawObject);
      const clause = rng.pick(LEX.lawClause);
      base.title = `${subject} ${verb} ${object}`;
      base.text = `${base.title}, ${clause}.`;
      base.subject = subject;
      base.verb = verb;
      base.object = object;
      base.clause = clause;
      base.tags = ['season:law', 'governance'];
      break;
    }
    case 'voice': {
      const speaker = rng.pick(LEX.voiceSpeaker);
      const mood = rng.pick(LEX.voiceMood);
      base.title = `${speaker} (${mood})`;
      base.text = `${rng.pick(LEX.voiceOpener)}, ${rng.pick(LEX.voiceCloser)}.`;
      base.speaker = speaker;
      base.mood = mood;
      base.tags = ['squad:voice', 'conversation'];
      break;
    }
    case 'terrain': {
      const rows = 8;
      const cols = 8;
      const heightfield = [];
      let h = rng.float(0.2, 0.6);
      for (let r = 0; r < rows; r += 1) {
        const row = [];
        for (let c = 0; c < cols; c += 1) {
          h = clamp(h + rng.float(-0.16, 0.18), 0, 1);
          row.push(round(h, 3));
        }
        heightfield.push(row);
      }
      base.title = `${rng.pick(LEX.biome)} survey ${rng.range(1, 99)}`;
      base.text = `Survey of a ${rng.pick(LEX.biome)}: ${rows}×${cols} heightfield, ${base.title}.`;
      base.heightfield = heightfield;
      base.biome = rng.pick(LEX.biome);
      base.hazard = rng.range(1, 5);
      base.cover = rng.range(1, 5);
      base.tags = ['ar:map', 'raid:terrain'];
      break;
    }
    case 'artifact': {
      const family = rng.pick(LEX.artifactFamily);
      const trait = rng.pick(LEX.artifactTrait);
      base.title = `${trait} ${family}`;
      base.text = `Blueprint: a ${trait} ${family}, plated in ${rng.pick(LEX.material)}, tuned to ${rng.pick(LEX.tactic)}.`;
      base.family = family;
      base.trait = trait;
      base.stats = {
        power: rng.range(6, 40) + Math.round(rarity.multiplier * 6),
        stability: rng.range(20, 90),
        weaveAffinity: rng.range(1, 9),
        memorySlots: rng.range(1, 4),
      };
      base.addressDomain = 'ART';
      base.artifactAddress = deriveAddress({ domain: 'ART', seed, label: hash.toLowerCase(), sublabel: `${index}:artifact:${family}` }).address;
      base.tags = ['loadout', 'weave:component'];
      break;
    }
    case 'glyph': {
      const name = rng.pick(LEX.glyphName);
      base.title = `Glyph ${name}`;
      base.text = `Glyph ${name}-${rng.range(1, 99)}: resonance ${resonance}, read as "${rng.pick(LEX.voiceOpener).toLowerCase()}".`;
      base.glyph = name;
      base.resonanceBand = resonance > 6 ? 'high' : resonance > 2.5 ? 'mid' : 'low';
      base.tags = ['hud', 'seal'];
      break;
    }
    case 'weather': {
      const noun = rng.pick(LEX.weatherNoun);
      base.title = noun[0].toUpperCase() + noun.slice(1);
      base.text = `${base.title} ${rng.pick(LEX.weatherVerb)} ${place(rng)}.`;
      base.condition = noun;
      base.intensity = round(rng.float(0.1, 1), 2);
      base.durationMinutes = rng.range(5, 180);
      base.tags = ['world:event', 'ar:overlay'];
      break;
    }
    case 'memory':
    default: {
      const mk = rng.pick(LEX.memoryKind);
      base.title = `Trace: ${mk}`;
      base.text = `A recoverable trace of a ${mk} at ${place(rng)}, held in ${rng.pick(LEX.material)}.`;
      base.memoryKind = mk;
      base.recallCost = rng.range(1, 20);
      base.decayDays = rng.range(3, 90);
      base.tags = ['memory:trace'];
      break;
    }
  }

  return base;
}

/**
 * Derive the full reward set for one mined block.
 * @param {object} opts
 * @param {string} opts.blockHash
 * @param {string} opts.seed
 * @param {number} [opts.count]        forced count (default hash-derived 1..4)
 * @param {string} [opts.blockAddress]
 */
function realityFromBlock({ blockHash, seed, count = null, blockAddress = null }) {
  const head = createRng(`block-reward|${seed}|${blockHash.toLowerCase()}`);
  const n = count ?? head.range(1, 4);
  const fragments = [];
  for (let i = 0; i < n; i += 1) {
    // Each fragment gets its own sub-digest so a block never repeats a seed.
    const sub = hashHex('fragment', blockHash, i);
    fragments.push(fragmentFromHash({ hash: sub, seed, index: i, parent: blockAddress }));
  }
  const rlu = round(fragments.reduce((sum, f) => sum + f.rlu, 0), 2);
  const rarest = fragments.reduce((best, f) => (RARITIES.find((r) => r.id === f.rarity).multiplier > RARITIES.find((r) => r.id === best.rarity).multiplier ? f : best), fragments[0]);
  return { count: fragments.length, rlu, rarest: rarest?.rarityLabel || null, fragments };
}

/**
 * Build a short multi-speaker conversation from a seed.
 * This is the "let it make conversation" path: companions, lobby hosts and
 * mission briefers all speak from here, so the dialogue is world-consistent
 * and traceable to the entropy that produced it.
 *
 * @param {object} opts
 * @param {string} opts.seed
 * @param {string[]} [opts.speakers]
 * @param {number} [opts.turns]
 * @param {string} [opts.context]  'raid' | 'lobby' | 'scan' | 'weave' | 'recall'
 */
function conversationFrom({ seed, speakers = null, turns = 5, context = 'lobby' }) {
  const rng = createRng(`conversation|${seed}|${context}`);
  const cast = (speakers && speakers.length ? speakers : [rng.pick(LEX.voiceSpeaker), rng.pick(LEX.voiceSpeaker)]).slice(0, 4);
  const openers = {
    raid: ['Stack at the gate.', 'Terrain is mined, not built — watch the ridgeline.', 'Two phases, one revive budget.'],
    scan: ['Scan layer open.', 'Contacts are plated, so trust the markers.', 'Something is humming under the overlay.'],
    weave: ['That fusion is unstable.', 'Give it a harmonic trait and try again.', 'Resonance is climbing — hold it there.'],
    recall: ['I still have that trace.', 'Recall costs, but it teaches the squad.', 'Your first win is plated in memory.'],
    lobby: ['Party is warm.', 'Safe lobby, so speak freely.', 'Who is hosting the next raid?'],
  };
  const lines = [];
  const pool = openers[context] || openers.lobby;
  for (let i = 0; i < clamp(turns, 1, 12); i += 1) {
    const speaker = cast[i % cast.length];
    const mood = rng.pick(LEX.voiceMood);
    const text =
      i < pool.length
        ? pool[i]
        : `${rng.pick(LEX.voiceOpener)}${rng.chance(0.55) ? `, ${rng.pick(LEX.voiceCloser)}` : ''}.`;
    lines.push({
      index: i,
      speaker,
      mood,
      text,
      tactic: rng.chance(0.4) ? rng.pick(LEX.tactic) : null,
      address: deriveAddress({ domain: 'RLT', seed, label: `conv:${context}`, sublabel: `${i}:${speaker}` }).address,
    });
  }
  return { context, cast, lines, seedFingerprint: hashHex('conv', seed, context).slice(0, 16) };
}

/** Mission/AR briefing prose assembled from mined fragments. */
function briefFrom({ seed, fragments = [], title = null }) {
  const rng = createRng(`brief|${seed}`);
  const scenes = fragments.filter((f) => f.kind === 'scene');
  const laws = fragments.filter((f) => f.kind === 'law');
  const weather = fragments.filter((f) => f.kind === 'weather');
  const voices = fragments.filter((f) => f.kind === 'voice');
  const venue = scenes[0]?.title || place(rng);
  const parts = [
    `${title || `Operation ${rng.pick(LEX.glyphName)}`}: hold ${venue}.`,
    weather[0] ? `Conditions — ${weather[0].text}` : `Conditions — ${LEX.weatherNoun[rng.int(LEX.weatherNoun.length)]} expected.`,
    laws[0] ? `Standing law — ${laws[0].text}` : `Standing law — ${LEX.lawSubject[rng.int(LEX.lawSubject.length)]} ${LEX.lawVerb[rng.int(LEX.lawVerb.length)]} ${LEX.lawObject[rng.int(LEX.lawObject.length)]}.`,
    voices[0] ? `Companion voice — ${voices[0].speaker}: "${voices[0].text}"` : null,
  ].filter(Boolean);
  return { title: title || parts[0].split(':')[0], venue, text: parts.join(' ') };
}

module.exports = {
  LEX,
  FRAGMENT_KINDS,
  RARITIES,
  fragmentFromHash,
  realityFromBlock,
  conversationFrom,
  briefFrom,
  place,
};
