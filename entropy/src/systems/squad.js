'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AI SQUAD COMPANIONS  —  they learn *your* tactics over time
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  No model weights, no inference service, no external API. What makes these
 *  companions "AI" in a way that is auditable and cheap is a small online
 *  learner per (player, companion) pair:
 *
 *      state  = tacticWeights : tactic → EWMA score in [-1, 1]
 *               bond          : 0..100 relationship scalar
 *               matches       : sample count (drives confidence)
 *               quirks        : discrete behaviours that emerge at thresholds
 *               history       : ring buffer of (weights snapshot, outcome)
 *
 *  Update rule after every match:
 *
 *      sample(tactic) = outcomeSignal · affinity(companion, tactic)
 *      outcomeSignal  = +1 win · +0.25 draw · −0.45 loss
 *      affinity       = companion's inborn preference for that tactic (0.2..1)
 *      weight'        = ewma(weight, sample, α)        α = 0.22 (fast enough
 *                                                        to feel responsive,
 *                                                        slow enough to be
 *                                                        stable)
 *
 *  Then:
 *      preferredTactic = argmax(weight)
 *      confidence      = clamp(matches / 20, 0, 1)     ← shown in the HUD so a
 *                                                        player can tell a
 *                                                        *guess* from a
 *                                                        *learned behaviour*
 *      bond            = clamp(bond + 3.5·win + 0.6·draw − 1.1·loss − idle, 0, 100)
 *
 *  Quirks are the part players actually notice. They are emitted when the
 *  learned distribution gets *peaky* — e.g. `flank-first` appears when the top
 *  tactic beats the runner-up by > 0.25 after ≥ 5 matches. Deterministic
 *  thresholds mean two players with the same history get the same companion
 *  personality, which makes the system explainable ("why does she always
 *  flank?" → "because you won 8 of your last 10 with flank-left").
 *
 *  Companions also *speak*: banter is generated from mined reality voices plus
 *  the learned tactic table, so dialogue references what the pair actually did.
 */

const {
  deriveAddress,
  createRng,
  hashHex,
  nowIso,
  clamp,
  round,
  ewma,
} = require('../core/entropy-core');
const { conversationFrom } = require('../core/reality-gen');
const { toBadRequest, toNotFound } = require('../core/http');

const DOMAIN = 'squad';

/** Match result → counter name ('loss' + 's' is not 'losses'). */
const RESULT_BUCKETS = Object.freeze({ win: 'wins', loss: 'losses', draw: 'draws' });

/* ── tactic vocabulary (shared with Entropy Memory's skill mapping) ───────── */

const TACTICS = Object.freeze([
  { id: 'flank-left', label: 'Flank Left', family: 'offense', note: 'lateral pressure from the weak side' },
  { id: 'hold-gate', label: 'Hold Gate', family: 'defense', note: 'anchor the objective, absorb the push' },
  { id: 'overwatch', label: 'Overwatch', family: 'support', note: 'high sightlines, calling targets' },
  { id: 'burst-scan', label: 'Burst Scan', family: 'perception', note: 'short aggressive sensor pulses' },
  { id: 'shield-front', label: 'Shield Front', family: 'defense', note: 'body the lane for the squad' },
  { id: 'kite-back', label: 'Kite Back', family: 'mobility', note: 'trade space for reload time' },
  { id: 'focus-fire', label: 'Focus Fire', family: 'offense', note: 'collapse one target at a time' },
  { id: 'revive-first', label: 'Revive First', family: 'support', note: 'keep the squad count up' },
  { id: 'high-ground', label: 'High Ground', family: 'mobility', note: 'take the ridge before the fight' },
  { id: 'split-push', label: 'Split Push', family: 'offense', note: 'two-pressure, force a choice' },
]);

const TACTIC_IDS = TACTICS.map((t) => t.id);

const ROLES = Object.freeze([
  { id: 'vanguard', label: 'Vanguard', glyph: '⟁', bias: ['shield-front', 'hold-gate', 'focus-fire'] },
  { id: 'marksman', label: 'Marksman', glyph: '⌁', bias: ['overwatch', 'focus-fire', 'high-ground'] },
  { id: 'medic', label: 'Mender', glyph: '⚭', bias: ['revive-first', 'kite-back', 'hold-gate'] },
  { id: 'scout', label: 'Scout', glyph: '◈', bias: ['burst-scan', 'flank-left', 'high-ground'] },
  { id: 'weaver', label: 'Weaver', glyph: '⊛', bias: ['focus-fire', 'split-push', 'overwatch'] },
  { id: 'sentinel', label: 'Sentinel', glyph: '⛨', bias: ['hold-gate', 'overwatch', 'shield-front'] },
]);

const TRAITS = Object.freeze(['steady', 'curious', 'dry', 'fierce', 'gentle', 'wry', 'patient', 'restless', 'loyal', 'precise']);

const VOICES = Object.freeze(['low and level', 'bright and quick', 'warm and unhurried', 'clipped, tactical', 'playful, slightly static', 'hushed, resonant']);

/** Drawn without replacement so no two companions on a network share a name. */
const NAME_POOL = Object.freeze([
  'Evolynn', 'SkyyBleu', 'Tru', 'Phiya', 'Tom', 'Vela', 'Irid', 'Nyx', 'Halcyon',
  'Sable', 'Rook', 'Lumen', 'Aster', 'Cove', 'Mireille', 'Kestrel', 'Ondine', 'Pax',
]);

const QUIRK_RULES = Object.freeze([
  { id: 'flank-first', label: 'Flank First', condition: (m) => m.top === 'flank-left' || m.top === 'split-push', note: 'opens every fight from the weak side' },
  { id: 'gate-keeper', label: 'Gate Keeper', condition: (m) => m.top === 'hold-gate' || m.top === 'shield-front', note: 'refuses to leave the objective' },
  { id: 'eye-in-the-sky', label: 'Eye in the Sky', condition: (m) => m.top === 'overwatch' || m.top === 'high-ground', note: 'always takes the ridge' },
  { id: 'sensor-hound', label: 'Sensor Hound', condition: (m) => m.top === 'burst-scan', note: 'scans before it speaks' },
  { id: 'never-left-behind', label: 'Never Left Behind', condition: (m) => m.top === 'revive-first', note: 'prioritises the downed over the kill' },
  { id: 'mirror', label: 'Mirror', condition: (m) => m.gap < 0.12 && m.matches >= 8, note: 'copies whatever you did last' },
  { id: 'streak-bonded', label: 'Streak Bonded', condition: (m) => m.winStreak >= 4, note: 'gets bolder during win streaks' },
  { id: 'cautious-after-loss', label: 'Cautious After Loss', condition: (m) => m.lossStreak >= 3, note: 'switches to defense after losses' },
  { id: 'deep-scan-habit', label: 'Deep Scan Habit', condition: (m) => m.deepScans >= 5, note: 'asks for deep scans on its own' },
]);

const LEARNING = Object.freeze({
  alpha: 0.22,
  outcomeSignal: { win: 1, draw: 0.25, loss: -0.45 },
  bondDelta: { win: 3.5, draw: 0.6, loss: -1.1 },
  idleDecayPerDay: 0.35,
  confidenceSampleTarget: 20,
  quirkMinMatches: 5,
  quirkGapThreshold: 0.25,
  historyLimit: 40,
});

class SquadCompanions {
  /**
   * @param {object} deps
   * @param {import('../core/vault').Vault} deps.vault
   * @param {import('../core/keyring').Keyring} deps.keyring
   * @param {import('../core/http').EventBus} deps.bus
   * @param {string} deps.seed
   */
  constructor({ vault, keyring, bus, seed }) {
    this.vault = vault;
    this.keyring = keyring;
    this.bus = bus;
    this.seed = seed;
    this.peers = {};
  }

  attach(peers) {
    this.peers = { ...this.peers, ...peers };
    return this;
  }

  _state() {
    return this.vault.read(DOMAIN, { roster: {}, instances: {}, byProfile: {}, stats: { recruited: 0, matches: 0, drills: 0, quirks: 0 } });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'squad', ...meta });
  }

  /* ─────────────────────────────── roster ─────────────────────────────── */

  /**
   * The roster is generated from the network seed: same seed ⇒ same companions
   * on every node. Count scales with the seed so networks feel distinct.
   */
  ensureRoster(state = this._state()) {
    if (Object.keys(state.roster).length) return 0;
    const rng = createRng(`squad-roster|${this.seed}`);
    const count = Math.min(NAME_POOL.length, rng.range(9, 14));
    const names = rng.shuffle([...NAME_POOL]).slice(0, count); // unique per network
    let added = 0;
    for (let i = 0; i < count; i += 1) {
      const role = ROLES[i % ROLES.length];
      const companionId = `cmp-${hashHex('companion', this.seed, i).slice(0, 10)}`;
      const traits = rng.shuffle(TRAITS).slice(0, 3);
      // Inborn affinity: role bias gets 0.75..1, everything else 0.2..0.55.
      const affinity = {};
      for (const tactic of TACTIC_IDS) {
        affinity[tactic] = role.bias.includes(tactic) ? round(rng.float(0.75, 1), 3) : round(rng.float(0.2, 0.55), 3);
      }
      const name = names[i] || `${rng.pick(NAME_POOL)}-${i}`;
      state.roster[companionId] = {
        companionId,
        name,
        callsign: `${rng.pick(['Ω', 'Δ', 'Σ', 'Ž', 'Λ'])}-${rng.range(10, 99)}`,
        role: role.id,
        roleLabel: role.label,
        glyph: role.glyph,
        traits,
        voice: rng.pick(VOICES),
        affinity,
        address: deriveAddress({ domain: 'SQD', seed: this.seed, label: companionId, sublabel: role.id }).address,
        evmAddress: deriveAddress({ domain: 'SQD', seed: this.seed, label: companionId, sublabel: role.id }).evm,
        origin: 'seeded',
        note: `${role.label} · ${traits.join(', ')}`,
        createdAt: nowIso(),
      };
      added += 1;
    }
    this._save(state, { actor: 'system', kind: 'squad.roster.seed', reason: `${added} companions` });
    return added;
  }

  roster() {
    const state = this._state();
    this.ensureRoster(state);
    return {
      roles: ROLES,
      tactics: TACTICS,
      learning: LEARNING,
      count: Object.keys(state.roster).length,
      companions: Object.values(state.roster).map((c) => ({ ...c, topAffinities: topN(c.affinity, 3) })),
    };
  }

  /* ───────────────────────────── instances ────────────────────────────── */

  /** Recruit (or re-fetch) a companion instance bound to a profile. */
  recruit(profileId, companionId, { actor = null } = {}) {
    const state = this._state();
    this.ensureRoster(state);
    const archetype = state.roster[companionId];
    if (!archetype) throw toNotFound(`unknown companion: ${companionId}`);

    const instanceKey = `${profileId}:${companionId}`;
    if (state.instances[instanceKey]) return { status: 'existing', instance: this._view(state.instances[instanceKey], archetype) };

    const weights = {};
    for (const tactic of TACTIC_IDS) weights[tactic] = round(archetype.affinity[tactic] * 0.2, 3); // start from inborn bias, dampened

    const instance = {
      instanceKey,
      instanceId: hashHex('squad-instance', this.seed, instanceKey).slice(0, 16),
      address: deriveAddress({ domain: 'SQD', seed: this.seed, label: instanceKey, sublabel: 'instance' }).address,
      profileId,
      companionId,
      name: archetype.name,
      role: archetype.role,
      tacticWeights: weights,
      preferredTactic: topN(weights, 1)[0]?.id || TACTIC_IDS[0],
      bond: 8,
      matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winStreak: 0,
      lossStreak: 0,
      deepScans: 0,
      quirks: [],
      history: [],
      confidence: 0,
      recruitedAt: nowIso(),
      lastSeenAt: nowIso(),
      taughtBy: actor || profileId,
    };
    state.instances[instanceKey] = instance;
    state.byProfile[profileId] = [...new Set([...(state.byProfile[profileId] || []), companionId])];
    state.stats.recruited += 1;
    this._save(state, { actor: actor || profileId, kind: 'squad.recruit', reason: companionId });
    this.bus.emit('squad.recruited', { profileId, companionId, name: archetype.name, address: instance.address });
    this.peers.missions?.observe({ profileId, event: 'squad.recruit', amount: 1, meta: { companionId } });

    if (this.peers.memory) {
      this.peers.memory.remember(profileId, {
        kind: 'companion',
        text: `Recruited ${archetype.name} (${archetype.roleLabel}, ${archetype.traits.join('/')}).`,
        tags: ['squad', archetype.role, companionId],
        resonance: 1.8,
        decayDays: 400,
        source: 'squad',
        ref: { companionId, address: instance.address },
      }, { actor: actor || profileId });
    }
    return { status: 'recruited', instance: this._view(instance, archetype) };
  }

  _instance(state, profileId, companionId) {
    const key = `${profileId}:${companionId}`;
    const instance = state.instances[key];
    if (!instance) throw toNotFound(`companion not recruited: ${companionId}`, { hint: `POST /v1/squad/${profileId}/recruit { companionId }` });
    return instance;
  }

  /** Public view: normalised weights, confidence, quirks, next-quirk hints. */
  _view(instance, archetype = null) {
    const weights = instance.tacticWeights;
    const sorted = topN(weights, TACTIC_IDS.length);
    const gap = sorted.length > 1 ? round(sorted[0].value - sorted[1].value, 3) : 1;
    return {
      ...instance,
      archetype: archetype ? { name: archetype.name, callsign: archetype.callsign, role: archetype.roleLabel, glyph: archetype.glyph, traits: archetype.traits, voice: archetype.voice } : undefined,
      bondLabel: instance.bond >= 80 ? 'sworn' : instance.bond >= 55 ? 'trusted' : instance.bond >= 30 ? 'warming' : 'new',
      confidence: round(clamp(instance.matches / LEARNING.confidenceSampleTarget, 0, 1), 3),
      weights: sorted.map((s) => ({ ...s, tactic: TACTICS.find((t) => t.id === s.id)?.label || s.id, family: TACTICS.find((t) => t.id === s.id)?.family || null, normalised: round((s.value + 1) / 2, 3) })),
      learnedGap: gap,
      winRate: instance.matches ? round(instance.wins / instance.matches, 3) : 0,
      nextQuirks: QUIRK_RULES.filter((q) => !instance.quirks.some((x) => x.id === q.id))
        .slice(0, 3)
        .map((q) => ({ id: q.id, label: q.label, note: q.note })),
    };
  }

  /* ────────────────────────────── learning ────────────────────────────── */

  /**
   * The learner. Called by Entropy Memory after every match.
   *
   * @param {object} input {profileId, companionId, result, tactics[], mode, deepScan}
   * @returns {object} updated weights + emergent quirks
   */
  learnFromMatch(input = {}) {
    const state = this._state();
    this.ensureRoster(state);
    const { profileId, companionId, result = 'draw', tactics = [], mode = 'skirmish', deepScan = false } = input;
    if (!profileId || !companionId) throw toBadRequest('learnFromMatch needs profileId and companionId');

    // Auto-recruit on first sight so a player never loses companion data.
    if (!state.instances[`${profileId}:${companionId}`]) {
      this.recruit(profileId, companionId, { actor: profileId });
    }
    const instance = state.instances[`${profileId}:${companionId}`];
    const archetype = state.roster[companionId];
    const signal = LEARNING.outcomeSignal[result] ?? 0.25;

    const used = (tactics.length ? tactics : [instance.preferredTactic]).filter((t) => TACTIC_IDS.includes(t));
    const updated = [];
    for (const tactic of TACTIC_IDS) {
      const affinity = archetype?.affinity?.[tactic] ?? 0.4;
      if (used.includes(tactic)) {
        // Tactic actually used: learn strongly from the outcome.
        const prev = instance.tacticWeights[tactic] ?? 0;
        const sample = clamp(signal * (0.55 + affinity * 0.6), -1, 1);
        instance.tacticWeights[tactic] = round(ewma(prev, sample, LEARNING.alpha), 4);
        updated.push({ tactic, from: prev, to: instance.tacticWeights[tactic], used: true });
      } else {
        // Unused tactics drift slowly toward their inborn affinity, so a
        // companion keeps a personality instead of collapsing to one tactic.
        const prev = instance.tacticWeights[tactic] ?? 0;
        instance.tacticWeights[tactic] = round(ewma(prev, affinity * 0.15, LEARNING.alpha * 0.25), 4);
        updated.push({ tactic, from: prev, to: instance.tacticWeights[tactic], used: false });
      }
    }

    instance.matches += 1;
    instance[RESULT_BUCKETS[result] || 'draws'] += 1;
    instance.winStreak = result === 'win' ? instance.winStreak + 1 : 0;
    instance.lossStreak = result === 'loss' ? instance.lossStreak + 1 : 0;
    if (deepScan) instance.deepScans += 1;
    instance.bond = round(clamp(instance.bond + (LEARNING.bondDelta[result] ?? 0) + (mode === 'raid' ? 1.2 : 0), 0, 100), 2);
    instance.lastSeenAt = nowIso();
    instance.preferredTactic = topN(instance.tacticWeights, 1)[0]?.id || instance.preferredTactic;

    // Quirk emergence
    const sorted = topN(instance.tacticWeights, TACTIC_IDS.length);
    const metrics = {
      top: sorted[0]?.id,
      gap: sorted.length > 1 ? sorted[0].value - sorted[1].value : 1,
      matches: instance.matches,
      winStreak: instance.winStreak,
      lossStreak: instance.lossStreak,
      deepScans: instance.deepScans,
      bond: instance.bond,
      mode,
    };
    const emerged = [];
    if (instance.matches >= LEARNING.quirkMinMatches) {
      for (const rule of QUIRK_RULES) {
        if (instance.quirks.some((q) => q.id === rule.id)) continue;
        let hit = false;
        try {
          hit = rule.condition(metrics);
        } catch {
          hit = false;
        }
        if (hit) {
          const quirk = { id: rule.id, label: rule.label, note: rule.note, emergedAt: nowIso(), evidence: { ...metrics, gap: round(metrics.gap, 3) } };
          instance.quirks.push(quirk);
          emerged.push(quirk);
          state.stats.quirks += 1;
        }
      }
    }

    // Learning history ring buffer — this is what powers the HUD curve and the
    // "why does it do that?" explainer.
    instance.history = [
      {
        at: nowIso(),
        result,
        mode,
        tacticsUsed: used,
        preferred: instance.preferredTactic,
        bond: instance.bond,
        topWeights: sorted.slice(0, 3).map((s) => ({ id: s.id, value: s.value })),
        emerged: emerged.map((q) => q.id),
      },
      ...instance.history,
    ].slice(0, LEARNING.historyLimit);

    state.stats.matches += 1;
    this._save(state, { actor: profileId, kind: 'squad.learn', reason: `${companionId}:${result}:${mode}` });
    if (emerged.length) {
      this.bus.emit('squad.quirk', { profileId, companionId, name: instance.name, quirks: emerged.map((q) => q.label) });
      this.peers.missions?.observe({ profileId, event: 'squad.quirk', amount: emerged.length, meta: { companionId, quirks: emerged.map((q) => q.id) } });
    }

    const view = this._view(instance, archetype);
    return {
      companionId,
      name: instance.name,
      address: instance.address,
      profileId,
      result,
      mode,
      tacticWeights: instance.tacticWeights,
      preferredTactic: instance.preferredTactic,
      bond: instance.bond,
      confidence: view.confidence,
      quirks: instance.quirks.map((q) => q.id),
      emerged: emerged.map((q) => ({ id: q.id, label: q.label, note: q.note })),
      updates: updated.filter((u) => u.used),
      learningCurve: instance.history.slice(0, 12).map((h) => ({ at: h.at, result: h.result, preferred: h.preferred, bond: h.bond })),
    };
  }

  /**
   * Explicit teaching: a player drills a tactic, shifting weights faster than
   * match play. Costs a small bond amount if you drill against the companion's
   * inborn affinity (it resents being used wrong) — a real trade-off.
   */
  drill(profileId, companionId, tactic, { intensity = 1, actor = null } = {}) {
    const state = this._state();
    this.ensureRoster(state);
    const instance = this._instance(state, profileId, companionId);
    const archetype = state.roster[companionId];
    if (!TACTIC_IDS.includes(tactic)) throw toBadRequest(`unknown tactic: ${tactic}`, { valid: TACTIC_IDS });
    const power = clamp(Number(intensity) || 1, 0.25, 3);
    const affinity = archetype?.affinity?.[tactic] ?? 0.4;
    const prev = instance.tacticWeights[tactic] ?? 0;
    instance.tacticWeights[tactic] = round(clamp(ewma(prev, 0.9 * (affinity >= 0.6 ? 1 : 0.75), LEARNING.alpha * power), -1, 1), 4);
    instance.bond = round(clamp(instance.bond + (affinity >= 0.6 ? 1.4 : -0.8) * power, 0, 100), 2);
    instance.preferredTactic = topN(instance.tacticWeights, 1)[0]?.id;
    instance.lastSeenAt = nowIso();
    instance.history = [{ at: nowIso(), result: 'drill', mode: 'drill', tacticsUsed: [tactic], preferred: instance.preferredTactic, bond: instance.bond, topWeights: topN(instance.tacticWeights, 3), emerged: [] }, ...instance.history].slice(0, LEARNING.historyLimit);
    state.stats.drills += 1;
    this.peers.missions?.observe({ profileId, event: 'squad.drill', amount: 1, meta: { companionId, tactic } });
    this._save(state, { actor: actor || profileId, kind: 'squad.drill', reason: `${companionId}:${tactic}×${power}` });
    if (this.peers.memory) this.peers.memory.recordSkillUse(profileId, 'squad-bond', { outcome: 'teach', actor: actor || profileId });
    return this._view(instance, archetype);
  }

  /** Idle decay: companions cool off when you stop playing with them. */
  decayIdle({ now = Date.now() } = {}) {
    const state = this._state();
    let touched = 0;
    for (const instance of Object.values(state.instances)) {
      const idleDays = (now - Date.parse(instance.lastSeenAt)) / 86_400_000;
      if (idleDays < 2) continue;
      const decay = LEARNING.idleDecayPerDay * idleDays;
      instance.bond = round(clamp(instance.bond - decay, 0, 100), 2);
      for (const tactic of TACTIC_IDS) {
        const affinity = state.roster[instance.companionId]?.affinity?.[tactic] ?? 0.4;
        instance.tacticWeights[tactic] = round(ewma(instance.tacticWeights[tactic], affinity * 0.15, 0.06), 4);
      }
      instance.decayedAt = nowIso();
      touched += 1;
    }
    if (touched) this._save(state, { actor: 'system', kind: 'squad.decay', reason: `${touched} idle companions` });
    return { touched };
  }

  /* ──────────────────────── recommendations / squad ───────────────────── */

  /** What companions does this profile currently field (for AR + lobbies)? */
  activeCompanions(profileId, { limit = 4 } = {}) {
    if (!profileId) return [];
    const state = this._state();
    this.ensureRoster(state);
    return (state.byProfile[profileId] || [])
      .map((id) => state.instances[`${profileId}:${id}`])
      .filter(Boolean)
      .sort((a, b) => b.bond - a.bond)
      .slice(0, clamp(limit, 1, 8))
      .map((instance) => this._view(instance, state.roster[instance.companionId]));
  }

  /**
   * Recommend a squad composition for a mode.
   *
   * Score = 0.45·roleCoverage + 0.35·learnedAlignment + 0.20·bond
   *  • roleCoverage   — does the set cover the roles the mode needs?
   *  • learnedAlignment — do the companions' *learned* preferred tactics match
   *                     what this player actually wins with?
   *  • bond           — trust beats raw stats; a sworn companion is worth more.
   */
  recommendSquad(profileId, { mode = 'skirmish', size = 3 } = {}) {
    const state = this._state();
    this.ensureRoster(state);
    const wanted = clamp(Number(size) || 3, 1, 5);
    const instances = (state.byProfile[profileId] || []).map((id) => state.instances[`${profileId}:${id}`]).filter(Boolean);
    if (!instances.length) {
      return { profileId, mode, size: wanted, recommended: [], note: 'no companions recruited yet — POST /v1/squad/:profileId/recruit', requiredRoles: MODE_NEEDS[mode] || MODE_NEEDS.skirmish };
    }

    const needs = MODE_NEEDS[mode] || MODE_NEEDS.skirmish;
    const playerBias = this.peers.memory ? this.peers.memory.getProfile(profileId)?.preferences?.tacticBias || {} : {};
    const biasTotal = Object.values(playerBias).reduce((s, v) => s + v, 0) || 1;

    const scored = instances.map((instance) => {
      const view = this._view(instance, state.roster[instance.companionId]);
      const roleFit = needs.roles.includes(instance.role) ? 1 : 0.35;
      const alignment = Object.entries(playerBias).reduce((sum, [tactic, weight]) => {
        const w = instance.tacticWeights[tactic];
        return typeof w === 'number' ? sum + (w + 1) / 2 * (weight / biasTotal) : sum;
      }, 0);
      const score = round(0.45 * roleFit + 0.35 * clamp(alignment, 0, 1) + 0.2 * (instance.bond / 100), 4);
      return { companionId: instance.companionId, name: instance.name, role: instance.role, roleLabel: view.archetype?.roleLabel || instance.role, preferredTactic: instance.preferredTactic, bond: instance.bond, confidence: view.confidence, quirks: instance.quirks.map((q) => q.id), score, address: instance.address, reason: `role fit ${roleFit}, learned alignment ${round(alignment, 2)}, bond ${instance.bond}` };
    });

    // Greedy with role diversity: prefer covering distinct roles first.
    const chosen = [];
    const rolesTaken = new Set();
    for (const candidate of scored.sort((a, b) => b.score - a.score)) {
      if (chosen.length >= wanted) break;
      if (rolesTaken.has(candidate.role) && scored.filter((c) => !rolesTaken.has(c.role)).length > 0) continue;
      chosen.push(candidate);
      rolesTaken.add(candidate.role);
    }
    while (chosen.length < wanted) {
      const next = scored.find((c) => !chosen.includes(c));
      if (!next) break;
      chosen.push(next);
    }

    const coverage = needs.roles.filter((r) => chosen.some((c) => c.role === r));
    return {
      profileId,
      mode,
      modeNeeds: needs,
      size: chosen.length,
      recommended: chosen,
      roleCoverage: round(coverage.length / needs.roles.length, 2),
      missingRoles: needs.roles.filter((r) => !coverage.includes(r)),
      averageBond: round(chosen.reduce((s, c) => s + c.bond, 0) / Math.max(1, chosen.length), 2),
      averageConfidence: round(chosen.reduce((s, c) => s + c.confidence, 0) / Math.max(1, chosen.length), 3),
      generatedAt: nowIso(),
    };
  }

  /**
   * Plain-language briefing: what the squad has learned about this player.
   * This is the "explainable AI" surface — no black boxes.
   */
  briefing(profileId) {
    const state = this._state();
    this.ensureRoster(state);
    const instances = (state.byProfile[profileId] || []).map((id) => state.instances[`${profileId}:${id}`]).filter(Boolean);
    if (!instances.length) return { profileId, lines: ['No companions recruited yet. The squad learns nothing about an empty bench.'], companions: [] };

    const playerBias = this.peers.memory ? this.peers.memory.getProfile(profileId)?.preferences?.tacticBias || {} : {};
    const topBias = topN(playerBias, 3);
    const aggregate = {};
    for (const tactic of TACTIC_IDS) {
      aggregate[tactic] = round(instances.reduce((s, i) => s + (i.tacticWeights[tactic] || 0), 0) / instances.length, 3);
    }
    const squadTop = topN(aggregate, 3);
    const lines = [
      `Squad of ${instances.length}: ${instances.map((i) => `${i.name} (${i.role})`).join(', ')}.`,
      squadTop[0]
        ? `Across the bench the strongest learned preference is ${TACTICS.find((t) => t.id === squadTop[0].id)?.label || squadTop[0].id} at ${squadTop[0].value} — ${squadTop[0].value > 0.45 ? 'a settled habit' : 'still forming'}.`
        : 'No settled preference yet; keep playing.',
      topBias[0]
        ? `You win most with ${TACTICS.find((t) => t.id === topBias[0].id)?.label || topBias[0].id}; ${instances.filter((i) => (i.tacticWeights[topBias[0].id] || 0) > 0.2).map((i) => i.name).join(', ') || 'no companion'} has converged on it.`
        : 'No tactic bias recorded for you yet.',
      ...instances.filter((i) => i.quirks.length).map((i) => `${i.name} → ${i.quirks.map((q) => q.label).join(', ')} (${i.matches} matches, confidence ${round(clamp(i.matches / LEARNING.confidenceSampleTarget, 0, 1), 2)}).`),
      instances.filter((i) => i.bond >= 80).length
        ? `Sworn: ${instances.filter((i) => i.bond >= 80).map((i) => `${i.name} (bond ${i.bond})`).join(', ')}.`
        : 'No sworn companions yet — bond ≥ 80.',
    ];
    return {
      profileId,
      lines,
      squadAggregate: squadTop.map((s) => ({ tactic: s.id, label: TACTICS.find((t) => t.id === s.id)?.label, value: s.value })),
      playerBias: topBias.map((s) => ({ tactic: s.id, label: TACTICS.find((t) => t.id === s.id)?.label, weight: s.value })),
      companions: instances.map((i) => ({ companionId: i.companionId, name: i.name, role: i.role, bond: i.bond, matches: i.matches, preferredTactic: i.preferredTactic, quirks: i.quirks.map((q) => q.label), address: i.address })),
      generatedAt: nowIso(),
    };
  }

  /** Full learning model for one companion (weights, history, quirks). */
  model(profileId, companionId) {
    const state = this._state();
    this.ensureRoster(state);
    const instance = this._instance(state, profileId, companionId);
    const archetype = state.roster[companionId];
    return {
      ...this._view(instance, archetype),
      archetypeFull: archetype,
      learning: LEARNING,
      history: instance.history,
      aggregateCurve: instance.history
        .slice(0, 20)
        .reverse()
        .map((h, i) => ({ step: i + 1, at: h.at, result: h.result, preferred: h.preferred, bond: h.bond })),
    };
  }

  /** Dismiss a companion (keeps the learning record for audit, clears bond). */
  dismiss(profileId, companionId, { actor = null } = {}) {
    const state = this._state();
    const key = `${profileId}:${companionId}`;
    if (!state.instances[key]) throw toNotFound(`companion not recruited: ${companionId}`);
    state.instances[key].status = 'dismissed';
    state.instances[key].dismissedAt = nowIso();
    state.byProfile[profileId] = (state.byProfile[profileId] || []).filter((id) => id !== companionId);
    this._save(state, { actor: actor || profileId, kind: 'squad.dismiss', reason: companionId });
    return { companionId, status: 'dismissed' };
  }

  /* ───────────────────────────── conversation ─────────────────────────── */

  /**
   * Companion banter. Pulls from mined `voice` fragments when available so the
   * squad literally speaks the reality the miners produced, then injects the
   * learned tactic context.
   */
  /**
   * Reverse index: resolve an EX-SQD-… address to a roster archetype or to a
   * specific player's companion instance.
   * @returns {{type:'companion'|'instance', record:object}|null}
   */
  findByAddress(address) {
    if (!address) return null;
    const state = this._state();
    this.ensureRoster(state);
    const archetype = Object.values(state.roster).find((c) => c.address === address);
    if (archetype) return { type: 'companion', record: archetype };
    const instance = Object.values(state.instances).find((i) => i.address === address);
    if (instance) return { type: 'instance', record: this._view(instance, state.roster[instance.companionId]) };
    return null;
  }

  banter({ profileId, companionId = null, context = 'lobby', turns = 4 } = {}) {
    const state = this._state();
    this.ensureRoster(state);
    const instance = companionId ? state.instances[`${profileId}:${companionId}`] : null;
    const archetype = instance ? state.roster[instance.companionId] : null;
    const speakers = [];
    if (instance) speakers.push(`${instance.name}`);
    const minedVoices = this.peers.miners ? this.peers.miners.fragmentsByKind('voice', { limit: 6 }) : [];
    for (const fragment of minedVoices.slice(0, 2)) if (fragment.speaker && !speakers.includes(fragment.speaker)) speakers.push(fragment.speaker);
    if (!speakers.length) speakers.push('the Watchtower');

    const seed = `${this.seed}|banter|${profileId || 'anon'}|${companionId || 'squad'}|${context}|${Math.floor(Date.now() / 300000)}`;
    const conversation = conversationFrom({ seed, speakers, turns, context });

    // Weave learned behaviour into the dialogue so it is personal, not generic.
    if (instance) {
      const preferred = TACTICS.find((t) => t.id === instance.preferredTactic);
      const quirk = instance.quirks[instance.quirks.length - 1];
      const injected = conversation.lines.map((line, i) => {
        if (i === 0 && preferred) return { ...line, text: `${preferred.label} on my mark — that is what wins for us.`, tactic: preferred.id };
        if (i === 1 && quirk) return { ...line, text: `${quirk.label}: ${quirk.note}.`, tactic: instance.preferredTactic };
        if (i === 2) return { ...line, text: `Bond ${instance.bond}, ${instance.matches} matches logged. I remember the last ${Math.min(3, instance.history.length)} exactly.` };
        return line;
      });
      conversation.lines = injected;
      conversation.companion = { companionId: instance.companionId, name: instance.name, address: instance.address, preferredTactic: instance.preferredTactic, bond: instance.bond, quirks: instance.quirks.map((q) => q.id) };
    }
    conversation.voice = archetype?.voice || 'low and level';
    conversation.context = context;
    return conversation;
  }

  stats() {
    const state = this._state();
    this.ensureRoster(state);
    const instances = Object.values(state.instances);
    return {
      ...state.stats,
      roster: Object.keys(state.roster).length,
      instances: instances.length,
      averageBond: instances.length ? round(instances.reduce((s, i) => s + i.bond, 0) / instances.length, 2) : 0,
      sworn: instances.filter((i) => i.bond >= 80).length,
      withQuirks: instances.filter((i) => i.quirks.length).length,
      tactics: TACTICS.length,
      roles: ROLES.length,
      quirkRules: QUIRK_RULES.length,
    };
  }
}

/** Mode → what a good squad covers. */
const MODE_NEEDS = Object.freeze({
  skirmish: { roles: ['scout', 'vanguard', 'marksman'], size: 3, note: 'fast, flexible' },
  raid: { roles: ['vanguard', 'medic', 'sentinel', 'marksman', 'weaver'], size: 5, note: 'full coverage, revive discipline matters' },
  scan: { roles: ['scout', 'weaver'], size: 2, note: 'perception heavy' },
  defense: { roles: ['sentinel', 'vanguard', 'medic'], size: 3, note: 'hold the gate' },
  escort: { roles: ['scout', 'medic', 'marksman'], size: 3, note: 'mobility + sustain' },
});

/** Sort a {id: value} map into [{id, value}] descending. */
function topN(map, n) {
  return Object.entries(map || {})
    .map(([id, value]) => ({ id, value: round(Number(value) || 0, 4) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

module.exports = { SquadCompanions, NAME_POOL, TACTICS, TACTIC_IDS, ROLES, TRAITS, QUIRK_RULES, LEARNING, MODE_NEEDS, topN };
