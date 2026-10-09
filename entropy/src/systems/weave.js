'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  POWER WEAVING  —  unlock abilities, then *combine* them into new ones
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Three layers, deliberately separated:
 *
 *   1. CATALOG   — the abilities that exist. A curated base set plus abilities
 *                  *generated from mined reality* (an `artifact` fragment
 *                  becomes a weaveable ability). So the catalog grows as the
 *                  mining stack produces world content. That is the loop:
 *                  mine → artifact → ability → weave → loadout → match.
 *
 *   2. UNLOCK    — a player-owned ledger of what they hold, what it cost
 *                  (Reality Units + skill level), and how often it is used.
 *
 *   3. WEAVE     — fusion of 2..4 unlocked abilities into a *new* ability with
 *                  its own entropy address, stats, name and stability roll.
 *                  Fusions are recorded as recipes so the community can see
 *                  which combinations are proven.
 *
 *  ── Fusion maths (the part worth understanding like a pro) ────────────────
 *
 *      synergy(a,b)  = SYNERGY_MATRIX[schoolA][schoolB]      ∈ [-0.35, +0.45]
 *      pairBoost     = Σ synergy over all component pairs
 *      rawPower      = Σ powerᵢ · (1 + 0.10·levelᵢ/10)
 *      power         = rawPower · (1 + pairBoost) · sizeFactor
 *      sizeFactor    = 1 + 0.18·(n − 2)                       (bigger = stronger)
 *      stability     = clamp( mean(stabilityᵢ)
 *                             − 11·(n − 2)                     (size penalty)
 *                             − 26·incompatiblePairs           (school clash)
 *                             + 0.35·weaveHandLevel            (skill helps)
 *                             + resonanceBonus, 4, 100 )
 *      resonance     = geometric mean of component resonance × harmony
 *
 *      stability ≥ 70  →  STABLE     (keeps 100% power, reusable)
 *      40 ≤ stab < 70  →  VOLATILE   (keeps 85%, decays 1 durability per use)
 *      stability < 40  →  FRACTURE   (collapses: yields residue, no ability)
 *
 *  Fractures are *not* a punishment-only path: they return residue, which is
 *  the cheapest way to re-roll a weave. High-risk fusion is a real strategy.
 *
 *  Every weave is a HIGH risk operation → it goes through the smart-value gate,
 *  so an under-authorised token parks the fusion in the Unmask Pool instead of
 *  silently mutating a player's power curve.
 */

const {
  deriveAddress,
  createRng,
  hashHex,
  contentAddress,
  nowIso,
  clamp,
  round,
  entropyPhrase,
} = require('../core/entropy-core');
const { toBadRequest, toNotFound } = require('../core/http');
const { fragmentFromHash } = require('../core/reality-gen');

const DOMAIN = 'weave';

/* ── schools + synergy matrix ─────────────────────────────────────────────── */

const SCHOOLS = Object.freeze({
  kinetic: { id: 'kinetic', label: 'Kinetic', glyph: '⟁', note: 'motion, impact, momentum' },
  tidal: { id: 'tidal', label: 'Tidal', glyph: '≈', note: 'flow, timing, pressure cycles' },
  chromatic: { id: 'chromatic', label: 'Chromatic', glyph: '◈', note: 'light, iridescence, scan' },
  aegis: { id: 'aegis', label: 'Aegis', glyph: '⛨', note: 'shields, gates, holding' },
  signal: { id: 'signal', label: 'Signal', glyph: '⌁', note: 'comms, marks, coordination' },
  memory: { id: 'memory', label: 'Memory', glyph: '⚭', note: 'recall, traces, learning' },
  thermal: { id: 'thermal', label: 'Thermal', glyph: '✷', note: 'heat, burn, kiln work' },
  void: { id: 'void', label: 'Void', glyph: '◯', note: 'absence, cloak, unmask' },
});

const SCHOOL_IDS = Object.keys(SCHOOLS);

/**
 * Symmetric synergy matrix. Positive = schools amplify each other, negative =
 * they fight. Read it as design intent, not arbitrary numbers:
 *   kinetic+tidal   → momentum and timing stack
 *   chromatic+signal→ scan and comms stack
 *   aegis+memory    → holding what you have learned
 *   void+thermal    → cloak and burn contradict
 *   void+memory     → forgetting what you cloaked (dangerous, powerful)
 */
const SYNERGY_MATRIX = Object.freeze({
  kinetic: { kinetic: -0.1, tidal: 0.34, chromatic: 0.08, aegis: -0.18, signal: 0.16, memory: 0.04, thermal: 0.26, void: 0.02 },
  tidal: { kinetic: 0.34, tidal: -0.06, chromatic: 0.18, aegis: 0.12, signal: 0.22, memory: 0.28, thermal: -0.22, void: 0.1 },
  chromatic: { kinetic: 0.08, tidal: 0.18, chromatic: 0.06, aegis: 0.1, signal: 0.42, memory: 0.24, thermal: 0.04, void: -0.14 },
  aegis: { kinetic: -0.18, tidal: 0.12, chromatic: 0.1, aegis: 0.02, signal: 0.2, memory: 0.36, thermal: 0.08, void: -0.26 },
  signal: { kinetic: 0.16, tidal: 0.22, chromatic: 0.42, aegis: 0.2, signal: -0.04, memory: 0.3, thermal: 0.02, void: 0.14 },
  memory: { kinetic: 0.04, tidal: 0.28, chromatic: 0.24, aegis: 0.36, signal: 0.3, memory: 0.12, thermal: -0.08, void: 0.4 },
  thermal: { kinetic: 0.26, tidal: -0.22, chromatic: 0.04, aegis: 0.08, signal: 0.02, memory: -0.08, thermal: -0.16, void: -0.34 },
  void: { kinetic: 0.02, tidal: 0.1, chromatic: -0.14, aegis: -0.26, signal: 0.14, memory: 0.4, thermal: -0.34, void: 0.18 },
});

/* ── base catalog ─────────────────────────────────────────────────────────── */

const BASE_ABILITIES = Object.freeze([
  { id: 'pulse-strike', name: 'Pulse Strike', school: 'kinetic', tier: 1, power: 22, stability: 78, resonance: 0.5, costRlu: 12, requires: { level: 1 } },
  { id: 'momentum-cascade', name: 'Momentum Cascade', school: 'kinetic', tier: 2, power: 38, stability: 66, resonance: 0.72, costRlu: 34, requires: { level: 3, abilities: ['pulse-strike'] } },
  { id: 'tidal-step', name: 'Tidal Step', school: 'tidal', tier: 1, power: 16, stability: 84, resonance: 0.55, costRlu: 14, requires: { level: 1 } },
  { id: 'pressure-cycle', name: 'Pressure Cycle', school: 'tidal', tier: 2, power: 34, stability: 70, resonance: 0.78, costRlu: 30, requires: { level: 4, abilities: ['tidal-step'] } },
  { id: 'prism-lash', name: 'Prism Lash', school: 'chromatic', tier: 1, power: 20, stability: 74, resonance: 0.62, costRlu: 16, requires: { level: 1 } },
  { id: 'iridescent-veil', name: 'Iridescent Veil', school: 'chromatic', tier: 2, power: 26, stability: 80, resonance: 0.88, costRlu: 38, requires: { level: 5 } },
  { id: 'gate-seal', name: 'Gate Seal', school: 'aegis', tier: 1, power: 14, stability: 92, resonance: 0.48, costRlu: 15, requires: { level: 1 } },
  { id: 'aegis-lattice', name: 'Aegis Lattice', school: 'aegis', tier: 3, power: 40, stability: 86, resonance: 0.8, costRlu: 62, requires: { level: 8, abilities: ['gate-seal'] } },
  { id: 'mark-relay', name: 'Mark Relay', school: 'signal', tier: 1, power: 12, stability: 88, resonance: 0.6, costRlu: 13, requires: { level: 1 } },
  { id: 'chorus-burst', name: 'Chorus Burst', school: 'signal', tier: 2, power: 30, stability: 72, resonance: 0.84, costRlu: 40, requires: { level: 6, abilities: ['mark-relay'] } },
  { id: 'trace-recall', name: 'Trace Recall', school: 'memory', tier: 1, power: 10, stability: 90, resonance: 0.66, costRlu: 12, requires: { level: 1 } },
  { id: 'memory-cradle', name: 'Memory Cradle', school: 'memory', tier: 3, power: 36, stability: 82, resonance: 0.94, costRlu: 66, requires: { level: 9, abilities: ['trace-recall'] } },
  { id: 'kiln-flash', name: 'Kiln Flash', school: 'thermal', tier: 1, power: 24, stability: 68, resonance: 0.58, costRlu: 18, requires: { level: 2 } },
  { id: 'ember-bloom', name: 'Ember Bloom', school: 'thermal', tier: 2, power: 42, stability: 58, resonance: 0.76, costRlu: 44, requires: { level: 7, abilities: ['kiln-flash'] } },
  { id: 'quiet-cloak', name: 'Quiet Cloak', school: 'void', tier: 2, power: 18, stability: 76, resonance: 0.9, costRlu: 36, requires: { level: 5 } },
  { id: 'unmask-rite', name: 'Unmask Rite', school: 'void', tier: 4, power: 56, stability: 52, resonance: 1.12, costRlu: 120, requires: { level: 12, abilities: ['quiet-cloak'] } },
]);

const WEAVE_PREFIX = ['Cascade', 'Chorus', 'Lattice', 'Meridian', 'Halo', 'Tessera', 'Circuit', 'Verge', 'Bastion', 'Bloom', 'Sigil', 'Drift'];
const WEAVE_SUFFIX = ['of the Ninth Tide', 'of Unmask Light', 'of Held Breath', 'of the Quiet Choir', 'of Chromium Rain', 'of the Pale Spiral', 'of the Second Sunrise', 'of Woven Basalt'];

const OUTCOMES = Object.freeze({
  STABLE: { id: 'stable', minStability: 70, powerFactor: 1, note: 'reusable, no decay' },
  VOLATILE: { id: 'volatile', minStability: 40, powerFactor: 0.85, note: 'decays 1 durability per use' },
  FRACTURE: { id: 'fracture', minStability: 0, powerFactor: 0, note: 'collapses into residue' },
});

class PowerWeaving {
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
    return this.vault.read(DOMAIN, {
      catalog: {},
      holdings: {}, // profileId → { abilityId: {level, uses, unlockedAt, costRlu} }
      fusions: {}, // fusionId → fusion
      byProfile: {}, // profileId → [fusionId]
      recipes: {}, // recipeKey → {count, bestStability, firstSeenAt, lastSeenAt, fusionIds[]}
      residue: {}, // profileId → number
      stats: { unlocks: 0, weaves: 0, fractures: 0, generated: 0 },
    });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'weave', ...meta });
  }

  /* ─────────────────────────────── catalog ────────────────────────────── */

  /** Seed the catalog with base abilities (idempotent). */
  ensureCatalog(state = this._state()) {
    let added = 0;
    for (const ability of BASE_ABILITIES) {
      if (state.catalog[ability.id]) continue;
      state.catalog[ability.id] = this._decorate(ability);
      added += 1;
    }
    if (added) this._save(state, { actor: 'system', kind: 'weave.catalog.seed', reason: `${added} base abilities` });
    return added;
  }

  /** Attach entropy address + derived fields to a catalog entry. */
  _decorate(ability) {
    const address = deriveAddress({ domain: 'WEA', seed: this.seed, label: ability.id, sublabel: `${ability.school}:${ability.tier}` });
    return {
      ...ability,
      address: address.address,
      evmAddress: address.evm,
      schoolLabel: SCHOOLS[ability.school]?.label || ability.school,
      glyph: SCHOOLS[ability.school]?.glyph || '◇',
      origin: ability.origin || 'base',
      resonance: ability.resonance ?? 0.5,
      costRlu: ability.costRlu ?? 10,
      requires: ability.requires || { level: 1 },
      catalogHash: contentAddress(ability),
    };
  }

  /**
   * Register an ability generated from mined reality (an `artifact` fragment).
   * Deterministic: the same fragment hash always yields the same ability id, so
   * two miners publishing the same block cannot create duplicates.
   */
  abilityFromArtifact(fragment, { actor = 'miner' } = {}) {
    if (!fragment || fragment.kind !== 'artifact') throw toBadRequest('abilityFromArtifact needs an artifact fragment');
    const state = this._state();
    const abilityId = `gen-${hashHex('weave-gen', fragment.sourceHash, fragment.index).slice(0, 12)}`;
    if (state.catalog[abilityId]) return { ability: state.catalog[abilityId], created: false };

    const rng = createRng(`weave-ability|${this.seed}|${fragment.sourceHash}|${fragment.index}`);
    const school = rng.pick(SCHOOL_IDS);
    const stats = fragment.stats || {};
    const ability = this._decorate({
      id: abilityId,
      name: `${fragment.trait[0].toUpperCase()}${fragment.trait.slice(1)} ${fragment.family[0].toUpperCase()}${fragment.family.slice(1)}`,
      school,
      tier: clamp(Math.round((stats.weaveAffinity || 3) / 2), 1, 5),
      power: clamp(stats.power || rng.range(12, 40), 6, 90),
      stability: clamp(stats.stability || rng.range(45, 90), 10, 98),
      resonance: round(clamp(fragment.resonance || 0.5, 0.1, 1.6), 3),
      costRlu: clamp(Math.round((stats.power || 20) * 0.9), 8, 200),
      requires: { level: clamp(Math.round((stats.weaveAffinity || 3)), 1, 20) },
      origin: 'mined',
      sourceFragment: fragment.address,
      sourceBlock: fragment.parent || null,
      rarity: fragment.rarity,
      note: fragment.text,
    });
    state.catalog[abilityId] = ability;
    state.stats.generated += 1;
    this._save(state, { actor, kind: 'weave.catalog.generate', reason: `from ${fragment.address}` });
    this.bus.emit('weave.ability.generated', { abilityId, address: ability.address, rarity: ability.rarity, school });
    return { ability, created: true };
  }

  catalog({ school = null, tier = null, origin = null, limit = 200 } = {}) {
    const state = this._state();
    this.ensureCatalog(state);
    return Object.values(state.catalog)
      .filter((a) => (school ? a.school === school : true))
      .filter((a) => (tier ? Number(a.tier) === Number(tier) : true))
      .filter((a) => (origin ? a.origin === origin : true))
      .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
      .slice(0, clamp(limit, 1, 500));
  }

  getAbility(abilityId) {
    const state = this._state();
    this.ensureCatalog(state);
    return state.catalog[abilityId] || null;
  }

  /** Full synergy matrix + schools, for the weave UI. */
  schools() {
    return {
      schools: Object.values(SCHOOLS),
      matrix: SYNERGY_MATRIX,
      outcomes: OUTCOMES,
      maxComponents: 4,
      minComponents: 2,
    };
  }

  /* ─────────────────────────────── holdings ───────────────────────────── */

  _holdings(state, profileId) {
    if (!state.holdings[profileId]) state.holdings[profileId] = {};
    return state.holdings[profileId];
  }

  residueOf(profileId) {
    const state = this._state();
    return round(state.residue[profileId] || 0, 2);
  }

  /**
   * Unlock an ability. Cost is paid in Reality Units (mined content credit) or
   * residue (from fractures / unweaves). Prerequisites are enforced in code.
   */
  unlock(profileId, abilityId, { payWith = 'rlu', actor = null } = {}) {
    const state = this._state();
    this.ensureCatalog(state);
    const ability = state.catalog[abilityId];
    if (!ability) throw toNotFound(`unknown ability: ${abilityId}`);
    const holdings = this._holdings(state, profileId);
    if (holdings[abilityId]) throw toBadRequest('ability already unlocked', { abilityId, unlockedAt: holdings[abilityId].unlockedAt });

    // Prerequisite enforcement — level from Entropy Memory, abilities from here.
    let profileLevel = 1;
    if (this.peers.memory) {
      const profile = this.peers.memory.getProfile(profileId);
      if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
      profileLevel = this.peers.memory.powerLevel(profile);
      for (const prereq of ability.requires.abilities || []) {
        if (!holdings[prereq]) throw toBadRequest(`missing prerequisite ability: ${prereq}`, { required: ability.requires });
      }
    }
    if (profileLevel < (ability.requires.level || 1)) {
      throw toBadRequest(`requires power level ${ability.requires.level}`, { profileLevel, required: ability.requires.level });
    }

    const cost = ability.costRlu;
    if (payWith === 'residue') {
      const have = state.residue[profileId] || 0;
      const residueCost = round(cost * 0.6, 2);
      if (have < residueCost) throw toBadRequest('insufficient residue', { have, need: residueCost });
      state.residue[profileId] = round(have - residueCost, 2);
    } else if (this.peers.miners) {
      const wallet = this.peers.miners.spendReality({ profileId, amount: cost, reason: `unlock ${abilityId}`, actor: actor || profileId });
      if (!wallet.ok) throw toBadRequest('insufficient Reality Units', wallet.detail);
    } else {
      // No miner peer (unit tests / standalone): record the debt honestly.
      state.residue[profileId] = round((state.residue[profileId] || 0) - cost, 2);
    }

    holdings[abilityId] = {
      abilityId,
      address: ability.address,
      level: 1,
      xp: 0,
      uses: 0,
      unlockedAt: nowIso(),
      costRlu: cost,
      paidWith: payWith,
      origin: ability.origin,
    };
    state.stats.unlocks += 1;
    this._save(state, { actor: actor || profileId, kind: 'weave.unlock', reason: abilityId });
    this.bus.emit('weave.unlocked', { profileId, abilityId, address: ability.address, costRlu: cost });
    this.peers.missions?.observe({ profileId, event: 'weave.unlock', amount: 1, meta: { abilityId } });

    if (this.peers.memory) {
      this.peers.memory.remember(profileId, {
        kind: 'unlock',
        text: `Unlocked ${ability.name} (${ability.schoolLabel}, tier ${ability.tier}) for ${cost} RLU.`,
        tags: ['weave', ability.school, abilityId],
        resonance: 1 + ability.tier * 0.2,
        decayDays: 200,
        source: 'weave',
        ref: { abilityId, address: ability.address },
      }, { actor: actor || profileId });
    }

    return { profileId, ability: { ...ability }, holding: holdings[abilityId], residue: round(state.residue[profileId] || 0, 2) };
  }

  holdingsOf(profileId) {
    const state = this._state();
    this.ensureCatalog(state);
    const holdings = state.holdings[profileId] || {};
    return {
      profileId,
      count: Object.keys(holdings).length,
      residue: round(state.residue[profileId] || 0, 2),
      abilities: Object.values(holdings)
        .map((h) => ({ ...h, ability: state.catalog[h.abilityId] || null }))
        .sort((a, b) => Date.parse(b.unlockedAt) - Date.parse(a.unlockedAt)),
      fusions: (state.byProfile[profileId] || []).map((id) => state.fusions[id]).filter(Boolean),
    };
  }

  /* ─────────────────────────────── weaving ────────────────────────────── */

  /**
   * Deterministic fusion analysis — no state change. The UI calls this on every
   * selection change so the player sees the outcome *before* spending.
   *
   * @param {string} profileId
   * @param {string[]} abilityIds  2..4 unlocked ability ids
   */
  analyze(profileId, abilityIds, { state = null } = {}) {
    const st = state || this._state();
    this.ensureCatalog(st);
    const ids = [...new Set((abilityIds || []).map(String))];
    if (ids.length < 2 || ids.length > 4) throw toBadRequest('weaving requires 2 to 4 distinct abilities', { got: ids.length });

    const holdings = st.holdings[profileId] || {};
    const missing = ids.filter((id) => !st.catalog[id]);
    if (missing.length) throw toNotFound(`unknown ability id(s): ${missing.join(', ')}`);
    const notOwned = ids.filter((id) => !holdings[id]);
    if (notOwned.length) throw toBadRequest(`ability not unlocked: ${notOwned.join(', ')}`, { hint: 'POST /v1/weave/unlock first' });

    const components = ids.map((id) => ({ ...st.catalog[id], heldLevel: holdings[id].level || 1 }));

    // Pairwise synergy
    let pairBoost = 0;
    let incompatiblePairs = 0;
    const pairs = [];
    for (let i = 0; i < components.length; i += 1) {
      for (let j = i + 1; j < components.length; j += 1) {
        const a = components[i];
        const b = components[j];
        const value = SYNERGY_MATRIX[a.school]?.[b.school] ?? 0;
        pairBoost += value;
        if (value <= -0.2) incompatiblePairs += 1;
        pairs.push({ a: a.id, b: b.id, schools: [a.school, b.school], synergy: value, verdict: value >= 0.3 ? 'harmonic' : value >= 0.08 ? 'compatible' : value > -0.2 ? 'neutral' : 'clash' });
      }
    }

    const n = components.length;
    const weaveHandLevel = this.peers.memory ? this.peers.memory.getProfile(profileId)?.skills?.['weave-hand']?.level || 1 : 1;
    const rawPower = components.reduce((sum, c) => sum + c.power * (1 + 0.1 * ((c.heldLevel || 1) / 10)), 0);
    const sizeFactor = 1 + 0.18 * (n - 2);
    const harmony = clamp(1 + pairBoost / Math.max(1, pairs.length), 0.4, 1.6);
    const power = round(rawPower * (1 + pairBoost) * sizeFactor, 2);
    const meanStability = components.reduce((sum, c) => sum + c.stability, 0) / n;
    const resonanceBonus = round(components.reduce((sum, c) => sum + (c.resonance || 0.5), 0) * 3, 2);
    const stability = round(clamp(meanStability - 11 * (n - 2) - 26 * incompatiblePairs + 0.35 * weaveHandLevel + resonanceBonus, 4, 100), 1);
    // Geometric mean of component resonance, scaled by school harmony.
    const resonanceProduct = components.reduce((prod, c) => prod * Math.max(0.1, c.resonance || 0.5), 1);
    const resonance = round(Math.pow(resonanceProduct, 1 / n) * harmony, 3);

    const outcome = stability >= OUTCOMES.STABLE.minStability ? OUTCOMES.STABLE : stability >= OUTCOMES.VOLATILE.minStability ? OUTCOMES.VOLATILE : OUTCOMES.FRACTURE;
    const finalPower = round(power * outcome.powerFactor, 2);

    const fusionSeed = hashHex('fusion', this.seed, profileId, ids.slice().sort().join('+'));
    const rng = createRng(fusionSeed);
    const name = `${rng.pick(WEAVE_PREFIX)} ${rng.pick(WEAVE_SUFFIX)}`;
    const dominant = components.slice().sort((a, b) => b.power - a.power)[0];
    const address = deriveAddress({ domain: 'WEA', seed: this.seed, label: fusionSeed.slice(0, 24), sublabel: ids.slice().sort().join('+') });

    return {
      fusionSeed,
      fusionId: fusionSeed.slice(0, 18),
      name,
      address: address.address,
      evmAddress: address.evm,
      codeword: entropyPhrase(fusionSeed, 2),
      profileId,
      components: components.map((c) => ({ id: c.id, name: c.name, school: c.school, tier: c.tier, power: c.power, stability: c.stability, resonance: c.resonance, heldLevel: c.heldLevel })),
      pairs,
      metrics: {
        n,
        pairBoost: round(pairBoost, 3),
        incompatiblePairs,
        sizeFactor: round(sizeFactor, 3),
        harmony: round(harmony, 3),
        rawPower: round(rawPower, 2),
        meanStability: round(meanStability, 1),
        weaveHandLevel,
        resonanceBonus,
      },
      result: {
        power: finalPower,
        preOutcomePower: power,
        stability,
        resonance,
        outcome: outcome.id,
        outcomeNote: outcome.note,
        school: dominant.school,
        tier: clamp(Math.round(components.reduce((s, c) => s + c.tier, 0) / n) + (n >= 4 ? 1 : 0), 1, 6),
        durability: outcome.id === 'volatile' ? 6 + Math.round(stability / 12) : null,
        residueOnFracture: round(components.reduce((s, c) => s + c.costRlu, 0) * 0.45, 2),
      },
    };
  }

  /**
   * Commit a weave. Returns either a fusion or a fracture (residue).
   * Callers wrap this in the smart-value gate — see routes.js.
   */
  weave(profileId, abilityIds, { actor = null } = {}) {
    const state = this._state();
    const analysis = this.analyze(profileId, abilityIds, { state });
    const { result } = analysis;
    const holdings = this._holdings(state, profileId);

    if (result.outcome === 'fracture') {
      state.residue[profileId] = round((state.residue[profileId] || 0) + result.residueOnFracture, 2);
      state.stats.weaves += 1;
      state.stats.fractures += 1;
      for (const component of analysis.components) {
        if (holdings[component.id]) holdings[component.id].uses += 1;
      }
      this._save(state, { actor: actor || profileId, kind: 'weave.fracture', reason: `stability ${result.stability}` });
      this.bus.emit('weave.fracture', { profileId, name: analysis.name, stability: result.stability, residue: result.residueOnFracture });
      if (this.peers.memory) {
        this.peers.memory.remember(profileId, {
          kind: 'fracture',
          text: `"${analysis.name}" fractured at stability ${result.stability}. Recovered ${result.residueOnFracture} residue.`,
          tags: ['weave', 'fracture', ...analysis.components.map((c) => c.id)],
          resonance: 1.1,
          decayDays: 90,
          source: 'weave',
        }, { actor: actor || profileId });
        this.peers.memory.recordSkillUse(profileId, 'weave-hand', { outcome: 'fail', actor: actor || profileId });
      }
      return { status: 'fracture', analysis, residue: round(state.residue[profileId] || 0, 2) };
    }

    const fusion = {
      fusionId: analysis.fusionId,
      name: analysis.name,
      address: analysis.address,
      evmAddress: analysis.evmAddress,
      codeword: analysis.codeword,
      profileId,
      components: analysis.components.map((c) => c.id),
      pairs: analysis.pairs,
      metrics: analysis.metrics,
      power: result.power,
      stability: result.stability,
      resonance: result.resonance,
      outcome: result.outcome,
      school: result.school,
      tier: result.tier,
      durability: result.durability,
      maxDurability: result.durability,
      uses: 0,
      wovenAt: nowIso(),
      status: 'active',
      contentHash: contentAddress({ fusionId: analysis.fusionId, components: analysis.components.map((c) => c.id), power: result.power, stability: result.stability }),
    };

    state.fusions[fusion.fusionId] = fusion;
    state.byProfile[profileId] = [fusion.fusionId, ...(state.byProfile[profileId] || []).filter((id) => id !== fusion.fusionId)].slice(0, 200);
    for (const component of analysis.components) {
      if (holdings[component.id]) {
        holdings[component.id].uses += 1;
        holdings[component.id].xp = (holdings[component.id].xp || 0) + 12;
        holdings[component.id].level = 1 + Math.floor((holdings[component.id].xp || 0) / 60);
      }
    }
    state.stats.weaves += 1;

    const recipeKey = analysis.components.map((c) => c.id).slice().sort().join('+');
    const recipe = state.recipes[recipeKey] || { recipeKey, count: 0, bestStability: 0, bestPower: 0, firstSeenAt: nowIso(), fusionIds: [], schools: [...new Set(analysis.components.map((c) => c.school))], name: analysis.name };
    recipe.count += 1;
    recipe.bestStability = Math.max(recipe.bestStability, result.stability);
    recipe.bestPower = Math.max(recipe.bestPower, result.power);
    recipe.lastSeenAt = nowIso();
    recipe.fusionIds = [fusion.fusionId, ...recipe.fusionIds].slice(0, 20);
    state.recipes[recipeKey] = recipe;

    this._save(state, { actor: actor || profileId, kind: 'weave.fuse', reason: `${analysis.name} (${result.outcome})` });
    this.bus.emit('weave.fused', { profileId, fusionId: fusion.fusionId, name: fusion.name, address: fusion.address, outcome: fusion.outcome, power: fusion.power });
    this.peers.missions?.observe({ profileId, event: 'weave.fuse', amount: 1, meta: { fusionId: fusion.fusionId, outcome: fusion.outcome } });
    if (fusion.outcome === 'stable') this.peers.missions?.observe({ profileId, event: 'weave.stable', amount: 1, meta: { fusionId: fusion.fusionId } });

    if (this.peers.memory) {
      this.peers.memory.remember(profileId, {
        kind: 'weave',
        text: `Wove "${fusion.name}" from ${analysis.components.map((c) => c.name).join(' + ')} — power ${fusion.power}, stability ${fusion.stability} (${fusion.outcome}).`,
        tags: ['weave', fusion.outcome, fusion.school, ...analysis.components.map((c) => c.id)],
        resonance: fusion.outcome === 'stable' ? 2.2 : 1.4,
        decayDays: 300,
        source: 'weave',
        ref: { fusionId: fusion.fusionId, address: fusion.address },
      }, { actor: actor || profileId });
      this.peers.memory.recordSkillUse(profileId, 'weave-hand', { outcome: fusion.outcome === 'stable' ? 'win' : 'use', actor: actor || profileId });
    }

    return { status: fusion.outcome, fusion, recipe: { recipeKey, count: recipe.count }, residue: round(state.residue[profileId] || 0, 2) };
  }

  /** Use a fusion in a match: volatile weaves lose durability. */
  useFusion(profileId, fusionId, { outcome = 'use', actor = null } = {}) {
    const state = this._state();
    const fusion = state.fusions[fusionId];
    if (!fusion || fusion.profileId !== profileId) throw toNotFound(`unknown fusion: ${fusionId}`);
    fusion.uses += 1;
    fusion.lastUsedAt = nowIso();
    if (fusion.outcome === 'volatile' && fusion.durability !== null) {
      fusion.durability -= 1;
      if (fusion.durability <= 0) {
        fusion.status = 'dissolved';
        state.residue[profileId] = round((state.residue[profileId] || 0) + round(fusion.power * 0.12, 2), 2);
      }
    }
    this._save(state, { actor: actor || profileId, kind: 'weave.fusion.use', reason: `${fusionId}:${outcome}` });
    return { fusion, residue: round(state.residue[profileId] || 0, 2) };
  }

  /** Unweave: dissolve a fusion back into residue. */
  unweave(profileId, fusionId, { actor = null } = {}) {
    const state = this._state();
    const fusion = state.fusions[fusionId];
    if (!fusion || fusion.profileId !== profileId) throw toNotFound(`unknown fusion: ${fusionId}`);
    if (fusion.status !== 'active') throw toBadRequest('fusion is not active', { status: fusion.status });
    const refund = round(fusion.power * 0.2 + fusion.components.length * 4, 2);
    fusion.status = 'unwoven';
    fusion.unwovenAt = nowIso();
    state.residue[profileId] = round((state.residue[profileId] || 0) + refund, 2);
    state.byProfile[profileId] = (state.byProfile[profileId] || []).filter((id) => id !== fusionId);
    this._save(state, { actor: actor || profileId, kind: 'weave.unweave', reason: `${fusionId} → ${refund} residue` });
    this.bus.emit('weave.unwoven', { profileId, fusionId, refund });
    return { fusionId, status: 'unwoven', refund, residue: round(state.residue[profileId] || 0, 2) };
  }

  /** Proven recipes across the network (community knowledge). */
  recipes({ limit = 24, sortBy = 'count' } = {}) {
    const state = this._state();
    const all = Object.values(state.recipes);
    all.sort((a, b) => (sortBy === 'power' ? b.bestPower - a.bestPower : sortBy === 'stability' ? b.bestStability - a.bestStability : b.count - a.count));
    return {
      count: all.length,
      recipes: all.slice(0, clamp(limit, 1, 100)).map((r) => ({
        ...r,
        components: r.recipeKey.split('+'),
        componentNames: r.recipeKey.split('+').map((id) => state.catalog[id]?.name || id),
      })),
    };
  }

  /** Top fusions leaderboard. */
  leaderboard({ limit = 20 } = {}) {
    const state = this._state();
    return Object.values(state.fusions)
      .filter((f) => f.status === 'active')
      .sort((a, b) => b.power * (b.stability / 100) - a.power * (a.stability / 100))
      .slice(0, clamp(limit, 1, 100))
      .map((f, i) => ({ rank: i + 1, ...f, score: round(f.power * (f.stability / 100), 2) }));
  }

  stats() {
    const state = this._state();
    return {
      ...state.stats,
      catalogSize: Object.keys(state.catalog).length,
      minedAbilities: Object.values(state.catalog).filter((a) => a.origin === 'mined').length,
      activeFusions: Object.values(state.fusions).filter((f) => f.status === 'active').length,
      recipes: Object.keys(state.recipes).length,
      residueOutstanding: round(Object.values(state.residue).reduce((s, v) => s + v, 0), 2),
      holders: Object.keys(state.holdings).filter((k) => Object.keys(state.holdings[k]).length > 0).length,
    };
  }

  /** Convenience used by the miner pipeline: turn a whole block into abilities. */
  ingestBlock(block, { actor = 'miner' } = {}) {
    const created = [];
    for (const fragment of block.reality?.fragments || []) {
      if (fragment.kind !== 'artifact') continue;
      const { ability, created: isNew } = this.abilityFromArtifact(fragment, { actor });
      if (isNew) created.push(ability);
    }
    return { blockHeight: block.height, blockAddress: block.address, abilitiesCreated: created.length, abilities: created };
  }

  /**
   * Reverse index: resolve an EX-WEA-… address to the ability or fusion that
   * owns it. Integrations only ever hold addresses, so this is the way back.
   * @returns {{type:'ability'|'fusion', record:object}|null}
   */
  findByAddress(address) {
    if (!address) return null;
    const state = this._state();
    this.ensureCatalog(state);
    const ability = Object.values(state.catalog).find((a) => a.address === address);
    if (ability) return { type: 'ability', record: ability };
    const fusion = Object.values(state.fusions).find((f) => f.address === address);
    if (fusion) return { type: 'fusion', record: fusion };
    return null;
  }

  /** Public helper so routes can generate a fragment deterministically. */
  static fragmentFromHash = fragmentFromHash;
}

module.exports = { PowerWeaving, SCHOOLS, SCHOOL_IDS, SYNERGY_MATRIX, BASE_ABILITIES, OUTCOMES };
