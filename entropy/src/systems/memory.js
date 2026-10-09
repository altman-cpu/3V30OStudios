'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY MEMORY  —  the profile system that remembers you
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Remembers four things, exactly as specified:
 *
 *      1. SKILLS              — xp, level, last-used, an entropy "signature"
 *      2. LOADOUTS            — socketed artifact/ability builds + their record
 *      3. WINS                — match ledger: wins / losses / raids / streaks
 *      4. COMPANION BEHAVIOURS— per-companion tactic weights, bond, quirks
 *
 *  Design notes worth understanding like a pro:
 *
 *  • Memory is a *trace log* plus a *consolidated digest*. Traces are cheap,
 *    timestamped, and decay. Consolidation promotes repeated traces into
 *    durable structure (skill xp, habits, companion weights). This mirrors how
 *    real memory systems are built (short-term → long-term consolidation) and
 *    keeps profile JSON small even after thousands of matches.
 *
 *  • Recall is a scored retrieval, not a DB query:
 *        score = 0.45·keywordOverlap + 0.25·recency + 0.20·resonance
 *                + 0.10·accessBoost
 *    No embeddings, no external model — deterministic and explainable, which
 *    matters when a player asks "why did it remember that?"
 *
 *  • Every record carries an entropy address (EX-MEM-…) and can be plated, so
 *    a profile can be exported to another network and verified on arrival.
 *
 *  • Forget is a *soft* delete: the trace is marked `forgotten` and excluded
 *    from recall, but the journal keeps the fact that it was forgotten. Players
 *    get erasure; auditors get accountability.
 */

const {
  deriveAddress,
  createRng,
  hashHex,
  contentAddress,
  nowIso,
  nowMs,
  clamp,
  round,
  ewma,
  epochDay,
  DAY_MS,
} = require('../core/entropy-core');
const { toBadRequest, toNotFound } = require('../core/http');

const DOMAIN = 'memory';

/* Curated starting skills. More skills are discovered from mined artifacts and
 * woven abilities at runtime, so this list is a floor, not a ceiling. */
const BASE_SKILLS = Object.freeze([
  { id: 'scan-literacy', name: 'Scan Literacy', school: 'perception', note: 'reads AR contacts faster' },
  { id: 'weave-hand', name: 'Weave Hand', school: 'weave', note: 'stability when fusing abilities' },
  { id: 'gate-hold', name: 'Gate Hold', school: 'defense', note: 'holding objectives under pressure' },
  { id: 'flank-instinct', name: 'Flank Instinct', school: 'offense', note: 'timing lateral pressure' },
  { id: 'squad-bond', name: 'Squad Bond', school: 'command', note: 'companion tactic convergence' },
  { id: 'seal-discipline', name: 'Seal Discipline', school: 'protocol', note: 'clean unmask habits' },
  { id: 'tide-sense', name: 'Tide Sense', school: 'perception', note: 'world-event anticipation' },
  { id: 'recall-craft', name: 'Recall Craft', school: 'memory', note: 'cheap, precise recall' },
]);

const LOADOUT_SLOTS = Object.freeze(['core', 'offhand', 'visor', 'tether', 'sigil']);

/** Match result → the counter it increments ('loss' + 's' is not 'losses'). */
const RESULT_BUCKETS = Object.freeze({ win: 'wins', loss: 'losses', draw: 'draws' });

/* Level curve: gentle early, meaningful later. xp needed to *reach* level L. */
function xpForLevel(level) {
  return Math.floor(100 * Math.pow(Math.max(1, level), 1.35));
}

function levelFromXp(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1) && level < 99) level += 1;
  return level;
}

class EntropyMemory {
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

  /** Late-bound peers (avoids circular construction). */
  attach(peers) {
    this.peers = { ...this.peers, ...peers };
    return this;
  }

  /* ───────────────────────────── state access ─────────────────────────── */

  _state() {
    return this.vault.read(DOMAIN, { profiles: {}, bySubject: {}, skills: {}, stats: { created: 0, traces: 0, matches: 0, consolidations: 0 } });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'memory', ...meta });
  }

  /* ────────────────────────────── profiles ────────────────────────────── */

  /** Deterministic profile id + address for a subject. */
  static profileIdFor(subject) {
    return hashHex('memory-profile', subject).slice(0, 16);
  }

  /** Get a profile, optionally creating it. */
  ensureProfile(subject, { alias = null, create = true } = {}) {
    const state = this._state();
    const existingId = state.bySubject[subject];
    if (existingId && state.profiles[existingId]) {
      const profile = state.profiles[existingId];
      if (alias && profile.alias !== alias) {
        profile.alias = alias;
        profile.updatedAt = nowIso();
        this._save(state, { actor: subject, kind: 'memory.alias' });
      }
      return profile;
    }
    if (!create) return null;

    const profileId = EntropyMemory.profileIdFor(subject);
    const rng = createRng(`profile|${this.seed}|${subject}`);
    const address = deriveAddress({ domain: 'MEM', seed: this.seed, label: profileId, sublabel: subject });
    const profile = {
      profileId,
      subject,
      alias: alias || subject,
      address: address.address,
      evmAddress: address.evm,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      era: `E${epochDay()}`,
      codename: `${rng.pick(['Azure', 'Halcyon', 'Prism', 'Verge', 'Lumen', 'Cobalt'])} ${rng.pick(['Cascade', 'Meridian', 'Chorus', 'Bastion', 'Drift', 'Sigil'])}`,
      skills: Object.fromEntries(
        BASE_SKILLS.map((s) => [
          s.id,
          { ...s, xp: 0, level: 1, uses: 0, lastUsedAt: null, bestStreak: 0, signature: deriveAddress({ domain: 'MEM', seed: this.seed, label: `${profileId}:skill`, sublabel: s.id }).address },
        ]),
      ),
      loadouts: {},
      equippedLoadout: null,
      record: {
        wins: 0,
        losses: 0,
        draws: 0,
        raidsCompleted: 0,
        raidsFailed: 0,
        scans: 0,
        sealsUnmasked: 0,
        realityMined: 0,
        rluLifetime: 0,
        streak: { current: 0, best: 0, kind: null },
        history: [],
      },
      companionBehaviors: {},
      traces: {},
      traceIndex: [],
      habits: {},
      preferences: { tacticBias: {}, playWindow: {}, lobbyStyle: null },
      memorySignature: null,
      consolidatedAt: null,
    };
    state.profiles[profileId] = profile;
    state.bySubject[subject] = profileId;
    state.stats.created += 1;
    this._save(state, { actor: subject, kind: 'memory.profile.create', reason: alias || 'auto' });
    profile.memorySignature = this.signature(profileId, state);
    this._save(state, { actor: subject, kind: 'memory.profile.sign' });
    this.bus.emit('memory.profile.created', { profileId, subject, address: profile.address });
    return state.profiles[profileId];
  }

  getProfile(profileIdOrSubject) {
    const state = this._state();
    return state.profiles[profileIdOrSubject] || state.profiles[state.bySubject[profileIdOrSubject]] || null;
  }

  requireProfile(profileIdOrSubject) {
    const profile = this.getProfile(profileIdOrSubject);
    if (!profile) throw toNotFound(`unknown memory profile: ${profileIdOrSubject}`, { hint: 'POST /v1/memory/profiles to create one' });
    return profile;
  }

  listProfiles({ limit = 50, sort = 'recent' } = {}) {
    const state = this._state();
    const all = Object.values(state.profiles);
    if (sort === 'wins') all.sort((a, b) => b.record.wins - a.record.wins);
    else if (sort === 'rlu') all.sort((a, b) => b.record.rluLifetime - a.record.rluLifetime);
    else all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return all.slice(0, limit).map((p) => this.summary(p));
  }

  /** Compact profile view for lists and the HUD. */
  summary(profile) {
    const topSkills = Object.values(profile.skills)
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 4)
      .map((s) => ({ id: s.id, name: s.name, level: s.level, xp: s.xp }));
    return {
      profileId: profile.profileId,
      subject: profile.subject,
      alias: profile.alias,
      codename: profile.codename,
      address: profile.address,
      evmAddress: profile.evmAddress,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      level: this.powerLevel(profile),
      record: profile.record,
      topSkills,
      loadoutCount: Object.keys(profile.loadouts).length,
      equippedLoadout: profile.equippedLoadout,
      companions: Object.keys(profile.companionBehaviors).length,
      traces: profile.traceIndex.filter((id) => profile.traces[id]?.status === 'active').length,
      habits: Object.keys(profile.habits).length,
      memorySignature: profile.memorySignature,
    };
  }

  /** Single composite level (skill xp + wins + mined reality). */
  powerLevel(profile) {
    const skillXp = Object.values(profile.skills).reduce((sum, s) => sum + s.xp, 0);
    return Math.max(1, levelFromXp(skillXp + profile.record.wins * 40 + Math.floor(profile.record.rluLifetime)));
  }

  /* ─────────────────────────────── traces ─────────────────────────────── */

  /**
   * Remember something. Traces are the atomic unit of Entropy Memory.
   * @param {string} profileId
   * @param {object} input {kind, text, tags, resonance, decayDays, source, ref}
   */
  remember(profileId, input, { actor = null } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    const kind = String(input.kind || 'note').toLowerCase();
    const text = String(input.text || '').trim();
    if (!text) throw toBadRequest('remember() requires non-empty text');

    const traceId = hashHex('trace', profileId, kind, text, nowMs()).slice(0, 18);
    const address = deriveAddress({ domain: 'MEM', seed: this.seed, label: traceId, sublabel: kind });
    const trace = {
      traceId,
      address: address.address,
      evmAddress: address.evm,
      kind,
      text: text.slice(0, 500),
      tags: (input.tags || []).slice(0, 12).map(String),
      resonance: round(clamp(Number(input.resonance ?? 0.5), 0, 10), 3),
      decayDays: clamp(Number(input.decayDays ?? 30), 1, 3650),
      source: input.source || 'manual',
      ref: input.ref || null,
      status: 'active',
      accesses: 0,
      createdAt: nowIso(),
      lastAccessedAt: null,
      contentHash: contentAddress({ kind, text, tags: input.tags || [], resonance: traceId ? undefined : undefined }),
    };
    profile.traces[traceId] = trace;
    profile.traceIndex = [traceId, ...profile.traceIndex].slice(0, 2000);
    profile.updatedAt = nowIso();
    state.stats.traces += 1;
    this._save(state, { actor: actor || profile.subject, kind: 'memory.trace.add', reason: kind });
    this.bus.emit('memory.trace', { profileId: profile.profileId, traceId, kind, address: trace.address });
    return trace;
  }

  /**
   * Scored recall.
   * @param {string} profileId
   * @param {object} opts {query, kind, tags, limit, includeForgotten}
   */
  recall(profileId, { query = '', kind = null, tags = null, limit = 8, includeForgotten = false } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);

    const q = String(query).toLowerCase();
    const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
    const wantTags = (tags || []).map((t) => String(t).toLowerCase());
    const now = nowMs();

    const scored = Object.values(profile.traces)
      .filter((t) => (includeForgotten ? true : t.status === 'active'))
      .filter((t) => (kind ? t.kind === kind : true))
      .filter((t) => (wantTags.length ? wantTags.some((tag) => (t.tags || []).map((x) => x.toLowerCase()).includes(tag)) : true))
      .map((t) => {
        const text = `${t.text} ${t.kind} ${(t.tags || []).join(' ')}`.toLowerCase();
        const overlap = qTokens.length ? qTokens.filter((tok) => text.includes(tok)).length / qTokens.length : 0.4;
        const ageDays = (now - Date.parse(t.createdAt)) / DAY_MS;
        const recency = Math.exp(-ageDays / Math.max(1, t.decayDays)); // exponential forgetting
        const accessBoost = clamp(t.accesses / 20, 0, 1);
        const resonanceNorm = clamp(t.resonance / 4, 0, 1);
        const score = round(0.45 * overlap + 0.25 * recency + 0.2 * resonanceNorm + 0.1 * accessBoost, 4);
        return { trace: t, score, breakdown: { overlap: round(overlap, 3), recency: round(recency, 3), resonance: round(resonanceNorm, 3), access: round(accessBoost, 3) } };
      })
      .filter((entry) => entry.score > 0.02)
      .sort((a, b) => b.score - a.score)
      .slice(0, clamp(limit, 1, 50));

    // Recall is a read, but it *strengthens* memory (spacing effect). Persist
    // the access counters so repeated recall keeps a trace alive.
    if (scored.length) {
      for (const { trace } of scored) {
        trace.accesses += 1;
        trace.lastAccessedAt = nowIso();
      }
      this._save(state, { actor: profile.subject, kind: 'memory.recall', reason: q || kind || 'browse' });
    }

    if (scored.length) this.peers.missions?.observe({ profileId: profile.profileId, event: 'memory.recall', amount: 1, meta: { query: q || null, kind } });

    return {
      profileId: profile.profileId,
      address: profile.address,
      query: q || null,
      kind,
      tags: wantTags,
      count: scored.length,
      results: scored.map(({ trace, score, breakdown }) => ({ ...trace, score, breakdown })),
      memoryPressure: this.memoryPressure(profile),
    };
  }

  /** Soft-delete a trace. Journal keeps the fact of forgetting. */
  forget(profileId, traceId, { actor = null, reason = 'player-requested erasure' } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    const trace = profile.traces[traceId];
    if (!trace) throw toNotFound(`unknown trace: ${traceId}`);
    trace.status = 'forgotten';
    trace.forgottenAt = nowIso();
    trace.text = '[redacted]';
    trace.tags = [];
    profile.updatedAt = nowIso();
    this._save(state, { actor: actor || profile.subject, kind: 'memory.trace.forget', reason });
    this.bus.emit('memory.forget', { profileId: profile.profileId, traceId });
    return { traceId, status: 'forgotten', at: trace.forgottenAt, reason };
  }

  /** 0..1 fullness indicator used by the HUD "memory pressure" ring. */
  memoryPressure(profile) {
    const active = Object.values(profile.traces).filter((t) => t.status === 'active');
    const weight = active.reduce((sum, t) => sum + clamp(t.resonance, 0, 4), 0);
    return round(clamp(weight / 400, 0, 1), 3);
  }

  /* ─────────────────────────── consolidation ──────────────────────────── */

  /**
   * Decay old traces and promote repetition into durable structure.
   * Safe to run on a timer (the server does it hourly) or on demand.
   */
  consolidate(profileId, { actor = null } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    const now = nowMs();

    const report = { decayed: 0, archived: 0, promoted: [], habits: [] };

    for (const trace of Object.values(profile.traces)) {
      if (trace.status !== 'active') continue;
      const ageDays = (now - Date.parse(trace.createdAt)) / DAY_MS;
      const halfLife = Math.max(1, trace.decayDays);
      const strength = Math.exp(-ageDays / halfLife) * (1 + clamp(trace.accesses, 0, 20) / 40);
      trace.resonance = round(trace.resonance * clamp(strength, 0.15, 1.15), 3);
      report.decayed += 1;
      if (trace.resonance < 0.05 && ageDays > halfLife) {
        trace.status = 'archived';
        trace.archivedAt = nowIso();
        report.archived += 1;
      }
    }

    // Promotion: repeated trace kinds become habits; tagged repetitions become
    // skill xp. This is the short-term → long-term step.
    const kindCounts = new Map();
    const tagCounts = new Map();
    for (const trace of Object.values(profile.traces)) {
      if (trace.status !== 'active') continue;
      kindCounts.set(trace.kind, (kindCounts.get(trace.kind) || 0) + trace.resonance);
      for (const tag of trace.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + trace.resonance);
    }
    for (const [kind, weight] of kindCounts) {
      if (weight >= 3) {
        const habitId = `habit:${kind}`;
        const prev = profile.habits[habitId]?.weight ?? 0;
        profile.habits[habitId] = {
          habitId,
          kind,
          weight: round(ewma(prev, weight, 0.4), 3),
          address: deriveAddress({ domain: 'MEM', seed: this.seed, label: `${profile.profileId}:habit`, sublabel: kind }).address,
          observedAt: nowIso(),
        };
        report.habits.push(habitId);
      }
    }
    for (const [tag, weight] of tagCounts) {
      const skillId = BASE_SKILLS.find((s) => tag.includes(s.id) || s.id.includes(tag))?.id || null;
      if (skillId && weight >= 2) {
        const gained = Math.round(weight * 6);
        this._addSkillXp(state, profile, skillId, gained);
        report.promoted.push({ skillId, xp: gained, fromTag: tag });
      }
    }

    profile.consolidatedAt = nowIso();
    profile.updatedAt = nowIso();
    state.stats.consolidations += 1;
    profile.memorySignature = this.signature(profileId, state);
    this._save(state, { actor: actor || profile.subject, kind: 'memory.consolidate' });
    this.bus.emit('memory.consolidated', { profileId: profile.profileId, ...report });
    return { profileId: profile.profileId, address: profile.address, at: profile.consolidatedAt, ...report, pressure: this.memoryPressure(profile), signature: profile.memorySignature };
  }

  /* ─────────────────────────────── skills ─────────────────────────────── */

  _addSkillXp(state, profile, skillId, xp, { name = null, school = null, note = null } = {}) {
    if (!profile.skills[skillId]) {
      profile.skills[skillId] = {
        id: skillId,
        name: name || skillId.replace(/[-_]/g, ' '),
        school: school || 'discovered',
        note: note || 'learned from mined reality',
        xp: 0,
        level: 1,
        uses: 0,
        lastUsedAt: null,
        bestStreak: 0,
        signature: deriveAddress({ domain: 'MEM', seed: this.seed, label: `${profile.profileId}:skill`, sublabel: skillId }).address,
      };
    }
    const skill = profile.skills[skillId];
    const before = skill.level;
    skill.xp = Math.max(0, skill.xp + xp);
    skill.level = levelFromXp(skill.xp);
    skill.uses += xp > 0 ? 1 : 0;
    skill.lastUsedAt = nowIso();
    return { skill, leveledUp: skill.level > before, levelsGained: skill.level - before };
  }

  /** Record skill usage; outcome drives xp delta. */
  recordSkillUse(profileId, skillId, { outcome = 'use', notes = null, actor = null } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    const deltas = { win: 45, loss: 14, draw: 22, use: 8, teach: 30, fail: 5, raid: 60 };
    const delta = deltas[String(outcome).toLowerCase()] ?? 8;
    const { skill, leveledUp, levelsGained } = this._addSkillXp(state, profile, skillId, delta, { note: notes || undefined });
    if (outcome === 'win') {
      const streak = (profile.record.streak.kind === skillId ? profile.record.streak.current : 0) + 1;
      profile.record.streak = { current: streak, best: Math.max(streak, profile.record.streak.best), kind: skillId };
      skill.bestStreak = Math.max(skill.bestStreak, streak);
    }
    profile.updatedAt = nowIso();
    profile.memorySignature = this.signature(profileId, state);
    this._save(state, { actor: actor || profile.subject, kind: 'memory.skill.use', reason: `${skillId}:${outcome}` });
    return { skillId, xp: skill.xp, level: skill.level, gained: delta, leveledUp, levelsGained, nextLevelXp: xpForLevel(skill.level + 1) };
  }

  skillTree(profileId) {
    const profile = this.requireProfile(profileId);
    const schools = {};
    for (const skill of Object.values(profile.skills)) {
      schools[skill.school] = schools[skill.school] || { school: skill.school, skills: [], xp: 0, level: 0 };
      schools[skill.school].skills.push({ ...skill, nextLevelXp: xpForLevel(skill.level + 1) });
      schools[skill.school].xp += skill.xp;
      schools[skill.school].level = Math.max(schools[skill.school].level, skill.level);
    }
    return {
      profileId: profile.profileId,
      address: profile.address,
      powerLevel: this.powerLevel(profile),
      totalXp: Object.values(profile.skills).reduce((sum, s) => sum + s.xp, 0),
      schools: Object.values(schools).sort((a, b) => b.xp - a.xp),
    };
  }

  /* ────────────────────────────── loadouts ────────────────────────────── */

  /**
   * Save (or update) a loadout. Slots accept mined artifact addresses or woven
   * ability addresses — both are verified for shape so junk cannot be socketed.
   */
  saveLoadout(profileId, { loadoutId = null, name, slots = {}, notes = null, actor = null }) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    if (!name) throw toBadRequest('loadout requires a name');

    const id = loadoutId || hashHex('loadout', profileId, name, nowMs()).slice(0, 14);
    const cleanSlots = {};
    for (const slot of LOADOUT_SLOTS) {
      const value = slots[slot];
      if (!value) continue;
      cleanSlots[slot] = String(value).slice(0, 120);
    }
    const existing = profile.loadouts[id];
    const loadout = {
      loadoutId: id,
      name: String(name).slice(0, 60),
      address: deriveAddress({ domain: 'MEM', seed: this.seed, label: `${profileId}:loadout`, sublabel: id }).address,
      slots: cleanSlots,
      notes: notes ? String(notes).slice(0, 240) : existing?.notes || null,
      record: existing?.record || { wins: 0, losses: 0, draws: 0, raids: 0 },
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      version: (existing?.version || 0) + 1,
      contentHash: contentAddress({ id, name, slots: cleanSlots }),
    };
    profile.loadouts[id] = loadout;
    if (!profile.equippedLoadout) profile.equippedLoadout = id;
    profile.updatedAt = nowIso();
    this._save(state, { actor: actor || profile.subject, kind: 'memory.loadout.save', reason: loadout.name });
    this.bus.emit('memory.loadout.saved', { profileId: profile.profileId, loadoutId: id, address: loadout.address });
    return loadout;
  }

  equipLoadout(profileId, loadoutId, { actor = null } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    if (!profile.loadouts[loadoutId]) throw toNotFound(`unknown loadout: ${loadoutId}`);
    profile.equippedLoadout = loadoutId;
    profile.updatedAt = nowIso();
    this._save(state, { actor: actor || profile.subject, kind: 'memory.loadout.equip', reason: loadoutId });
    return { profileId: profile.profileId, equipped: loadoutId, loadout: profile.loadouts[loadoutId] };
  }

  listLoadouts(profileId) {
    const profile = this.requireProfile(profileId);
    return {
      profileId: profile.profileId,
      slots: LOADOUT_SLOTS.slice(),
      equipped: profile.equippedLoadout,
      loadouts: Object.values(profile.loadouts).sort((a, b) => b.record.wins - a.record.wins),
    };
  }

  /* ─────────────────────── match ledger (wins & co) ───────────────────── */

  /**
   * Record a match. This is the fan-out point: it updates wins, loadout
   * record, skill xp, companion behaviour weights (delegated to Squad) and
   * writes a memory trace so the profile can *explain* its own history.
   *
   * @param {string} profileId
   * @param {object} input {result, mode, loadoutId, companions[], tactics[], score, raidId, lobbyId, durationSec, notes}
   */
  recordMatch(profileId, input = {}, { actor = null } = {}) {
    const state = this._state();
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);

    const result = String(input.result || 'draw').toLowerCase();
    if (!['win', 'loss', 'draw'].includes(result)) throw toBadRequest('result must be win|loss|draw');
    const mode = String(input.mode || 'skirmish').toLowerCase();
    const loadoutId = input.loadoutId && profile.loadouts[input.loadoutId] ? input.loadoutId : profile.equippedLoadout;
    const tactics = (input.tactics || []).slice(0, 8).map(String);
    const companions = (input.companions || []).slice(0, 6).map(String);

    const bucket = RESULT_BUCKETS[result];
    profile.record[bucket] += 1;
    if (mode === 'raid') profile.record[result === 'win' ? 'raidsCompleted' : 'raidsFailed'] += 1;
    profile.record.streak.current = result === 'win' ? profile.record.streak.current + 1 : 0;
    profile.record.streak.best = Math.max(profile.record.streak.best, profile.record.streak.current);
    profile.record.history = [
      { at: nowIso(), result, mode, loadoutId, tactics, companions, score: Number(input.score ?? 0), lobbyId: input.lobbyId || null, raidId: input.raidId || null, durationSec: Number(input.durationSec ?? 0) },
      ...profile.record.history,
    ].slice(0, 200);

    if (loadoutId) {
      const loadout = profile.loadouts[loadoutId];
      loadout.record[bucket] += 1;
      if (mode === 'raid') loadout.record.raids += 1;
      loadout.lastResult = result;
      loadout.updatedAt = nowIso();
    }

    // Skill xp: tactics used in the match map onto skill ids when they match.
    const skillGains = [];
    for (const tactic of tactics) {
      const skillId = this._skillForTactic(tactic, mode, result);
      const gain = this._addSkillXp(state, profile, skillId, result === 'win' ? 26 : 9, { school: 'tactic' });
      skillGains.push({ skillId, level: gain.skill.level, xp: gain.skill.xp, leveledUp: gain.leveledUp });
    }

    // Companion behaviour learning is delegated to the Squad system so the
    // weights live in one place; Memory keeps a mirror for the profile view.
    const companionUpdates = [];
    if (this.peers.squad) {
      for (const companionId of companions) {
        const update = this.peers.squad.learnFromMatch({ profileId: profile.profileId, companionId, result, tactics, mode });
        companionUpdates.push(update);
        profile.companionBehaviors[companionId] = {
          companionId,
          tacticWeights: update.tacticWeights,
          preferredTactic: update.preferredTactic,
          bond: update.bond,
          wins: (profile.companionBehaviors[companionId]?.wins || 0) + (result === 'win' ? 1 : 0),
          matches: (profile.companionBehaviors[companionId]?.matches || 0) + 1,
          quirks: update.quirks,
          lastSeenAt: nowIso(),
          address: deriveAddress({ domain: 'SQD', seed: this.seed, label: `${profile.profileId}:behavior`, sublabel: companionId }).address,
        };
      }
    }

    // Play-window preference (what times this player actually shows up).
    const hour = new Date().getUTCHours();
    profile.preferences.playWindow[hour] = (profile.preferences.playWindow[hour] || 0) + 1;
    for (const tactic of tactics) {
      profile.preferences.tacticBias[tactic] = (profile.preferences.tacticBias[tactic] || 0) + (result === 'win' ? 2 : 1);
    }
    profile.preferences.lobbyStyle = input.lobbyStyle || profile.preferences.lobbyStyle;

    const trace = {
      kind: result === 'win' ? 'win' : mode === 'raid' ? 'raid' : 'match',
      text: `${result.toUpperCase()} in ${mode}${loadoutId ? ` on loadout "${profile.loadouts[loadoutId]?.name}"` : ''}${tactics.length ? ` using ${tactics.join(', ')}` : ''}${companions.length ? ` with ${companions.join(', ')}` : ''}.`,
      tags: [mode, result, ...tactics].slice(0, 10),
      resonance: result === 'win' ? 1.4 : 0.7,
      decayDays: result === 'win' ? 120 : 45,
      source: 'match',
      ref: { lobbyId: input.lobbyId || null, raidId: input.raidId || null },
    };
    const traceId = hashHex('trace', profile.profileId, trace.kind, trace.text, nowMs()).slice(0, 18);
    const traceAddress = deriveAddress({ domain: 'MEM', seed: this.seed, label: traceId, sublabel: trace.kind });
    profile.traces[traceId] = { traceId, address: traceAddress.address, ...trace, status: 'active', accesses: 0, createdAt: nowIso(), lastAccessedAt: null };
    profile.traceIndex = [traceId, ...profile.traceIndex].slice(0, 2000);
    state.stats.matches += 1;
    profile.updatedAt = nowIso();
    profile.memorySignature = this.signature(profileId, state);
    this._save(state, { actor: actor || profile.subject, kind: 'memory.match.record', reason: `${mode}:${result}` });
    this.bus.emit('memory.match', { profileId: profile.profileId, result, mode, address: profile.address });

    // Cadence fan-out lives here (not in the HTTP route) so CLI, SDK and
    // internal callers all advance missions identically.
    this.peers.missions?.observe({ profileId: profile.profileId, event: 'match.play', amount: 1, meta: { mode, result } });
    if (result === 'win') this.peers.missions?.observe({ profileId: profile.profileId, event: 'match.win', amount: 1, meta: { mode } });

    return {
      profileId: profile.profileId,
      address: profile.address,
      result,
      mode,
      record: profile.record,
      loadoutId,
      skillGains,
      companionUpdates,
      traceId,
      traceAddress: traceAddress.address,
      signature: profile.memorySignature,
      powerLevel: this.powerLevel(profile),
    };
  }

  /** Map a tactic string onto a memory skill id (deterministic, explainable). */
  _skillForTactic(tactic, mode, result) {
    const table = {
      'flank-left': 'flank-instinct',
      'split-push': 'flank-instinct',
      'hold-gate': 'gate-hold',
      'shield-front': 'gate-hold',
      'overwatch': 'tide-sense',
      'high-ground': 'tide-sense',
      'burst-scan': 'scan-literacy',
      'focus-fire': 'weave-hand',
      'revive-first': 'squad-bond',
      'kite-back': 'recall-craft',
    };
    if (table[tactic]) return table[tactic];
    if (mode === 'raid') return 'gate-hold';
    if (result === 'win') return 'seal-discipline';
    return hashHex('skill-map', tactic).slice(0, 4).startsWith('0') ? 'scan-literacy' : 'weave-hand';
  }

  /* ─────────────────── companion behaviour mirror (read) ──────────────── */

  companionBehaviors(profileId) {
    const profile = this.requireProfile(profileId);
    const entries = Object.values(profile.companionBehaviors);
    return {
      profileId: profile.profileId,
      address: profile.address,
      count: entries.length,
      companions: entries
        .map((c) => ({
          ...c,
          winRate: c.matches ? round(c.wins / c.matches, 3) : 0,
        }))
        .sort((a, b) => b.bond - a.bond),
    };
  }

  /* ───────────────────────── signature & export ───────────────────────── */

  /**
   * Memory signature: a stable fingerprint of the durable parts of a profile.
   * Two networks with the same seed and the same history produce the same
   * signature — that is how cross-instance profile import is verified.
   */
  signature(profileId, state = this._state()) {
    const profile = state.profiles[profileId] || state.profiles[state.bySubject[profileId]];
    if (!profile) throw toNotFound(`unknown memory profile: ${profileId}`);
    const durable = {
      subject: profile.subject,
      skills: Object.fromEntries(Object.entries(profile.skills).map(([id, s]) => [id, { xp: s.xp, level: s.level, uses: s.uses }])),
      loadouts: Object.fromEntries(Object.entries(profile.loadouts).map(([id, l]) => [id, { name: l.name, slots: l.slots, record: l.record }])),
      record: profile.record,
      habits: profile.habits,
      companionBehaviors: profile.companionBehaviors,
    };
    const hash = contentAddress(durable);
    return {
      contentHash: hash,
      address: deriveAddress({ domain: 'MEM', seed: this.seed, label: `${profileId}:signature`, sublabel: hash.slice(0, 16) }).address,
      evmAddress: `0x${hash.slice(0, 40)}`,
      computedAt: nowIso(),
    };
  }

  /** Portable export bundle (for custom integrations / migrations). */
  exportProfile(profileId, { includeTraces = true } = {}) {
    const profile = this.requireProfile(profileId);
    const bundle = {
      protocol: 'ENTROPY-MEMORY',
      version: 1,
      exportedAt: nowIso(),
      networkSeedFingerprint: hashHex('fingerprint', this.seed).slice(0, 24),
      profile: { ...profile, traces: includeTraces ? profile.traces : {} },
      signature: this.signature(profileId),
    };
    bundle.contentHash = contentAddress(bundle.profile);
    return bundle;
  }

  /**
   * Import a bundle. Idempotent by (subject, signature): re-importing the same
   * bundle is a no-op, which makes retries safe for integrators.
   */
  importProfile(bundle, { actor = null } = {}) {
    if (!bundle || bundle.protocol !== 'ENTROPY-MEMORY') throw toBadRequest('not an ENTROPY-MEMORY bundle');
    const incoming = bundle.profile;
    if (!incoming?.subject) throw toBadRequest('bundle.profile.subject is required');
    const state = this._state();
    const existingId = state.bySubject[incoming.subject];
    const existing = existingId ? state.profiles[existingId] : null;

    if (existing && existing.memorySignature?.contentHash === bundle.signature?.contentHash) {
      return { status: 'noop', profileId: existing.profileId, reason: 'signature already present' };
    }
    if (existing) {
      // Merge strategy: keep the higher of each durable number, union traces.
      for (const [id, skill] of Object.entries(incoming.skills || {})) {
        const current = existing.skills[id];
        if (!current || skill.xp > current.xp) existing.skills[id] = { ...current, ...skill };
      }
      for (const [id, loadout] of Object.entries(incoming.loadouts || {})) {
        if (!existing.loadouts[id] || (loadout.version || 0) > (existing.loadouts[id].version || 0)) existing.loadouts[id] = loadout;
      }
      for (const key of ['wins', 'losses', 'draws', 'raidsCompleted', 'raidsFailed', 'scans', 'sealsUnmasked', 'realityMined']) {
        existing.record[key] = Math.max(existing.record[key] || 0, incoming.record?.[key] || 0);
      }
      existing.record.rluLifetime = Math.max(existing.record.rluLifetime || 0, incoming.record?.rluLifetime || 0);
      Object.assign(existing.traces, incoming.traces || {});
      existing.traceIndex = [...new Set([...(incoming.traceIndex || []), ...existing.traceIndex])].slice(0, 2000);
      existing.companionBehaviors = { ...existing.companionBehaviors, ...(incoming.companionBehaviors || {}) };
      existing.updatedAt = nowIso();
      existing.importedFrom = bundle.networkSeedFingerprint || null;
      existing.memorySignature = this.signature(existing.profileId, state);
      this._save(state, { actor: actor || existing.subject, kind: 'memory.profile.import.merge' });
      return { status: 'merged', profileId: existing.profileId, signature: existing.memorySignature };
    }

    const profileId = incoming.profileId && !state.profiles[incoming.profileId] ? incoming.profileId : EntropyMemory.profileIdFor(incoming.subject);
    const address = deriveAddress({ domain: 'MEM', seed: this.seed, label: profileId, sublabel: incoming.subject });
    state.profiles[profileId] = { ...incoming, profileId, address: address.address, evmAddress: address.evm, importedAt: nowIso(), importedFrom: bundle.networkSeedFingerprint || null };
    state.bySubject[incoming.subject] = profileId;
    state.stats.created += 1;
    state.profiles[profileId].memorySignature = this.signature(profileId, state);
    this._save(state, { actor: actor || incoming.subject, kind: 'memory.profile.import.create' });
    this.bus.emit('memory.profile.imported', { profileId, subject: incoming.subject });
    return { status: 'created', profileId, signature: state.profiles[profileId].memorySignature };
  }

  /* ─────────────────────────── graph for the HUD ──────────────────────── */

  /** Nodes + edges describing the profile, rendered as the memory constellation. */
  graph(profileId, { limit = 40 } = {}) {
    const profile = this.requireProfile(profileId);
    const nodes = [{ id: profile.profileId, kind: 'profile', label: profile.alias, address: profile.address, weight: 1 }];
    const edges = [];

    for (const skill of Object.values(profile.skills).sort((a, b) => b.xp - a.xp).slice(0, 8)) {
      nodes.push({ id: `skill:${skill.id}`, kind: 'skill', label: `${skill.name} L${skill.level}`, address: skill.signature, weight: clamp(skill.level / 20, 0.05, 1) });
      edges.push({ from: profile.profileId, to: `skill:${skill.id}`, kind: 'has-skill' });
    }
    for (const loadout of Object.values(profile.loadouts).slice(0, 6)) {
      nodes.push({ id: `loadout:${loadout.loadoutId}`, kind: 'loadout', label: loadout.name, address: loadout.address, weight: clamp(loadout.record.wins / 20, 0.05, 1) });
      edges.push({ from: profile.profileId, to: `loadout:${loadout.loadoutId}`, kind: 'equipped' });
    }
    for (const companion of Object.values(profile.companionBehaviors).slice(0, 6)) {
      nodes.push({ id: `companion:${companion.companionId}`, kind: 'companion', label: companion.companionId, address: companion.address, weight: clamp(companion.bond, 0.05, 1) });
      edges.push({ from: profile.profileId, to: `companion:${companion.companionId}`, kind: 'bonded' });
    }
    for (const traceId of profile.traceIndex.slice(0, limit)) {
      const trace = profile.traces[traceId];
      if (!trace || trace.status !== 'active') continue;
      nodes.push({ id: `trace:${traceId}`, kind: trace.kind, label: trace.text.slice(0, 44), address: trace.address, weight: clamp(trace.resonance / 3, 0.05, 1) });
      edges.push({ from: profile.profileId, to: `trace:${traceId}`, kind: 'remembers' });
    }
    return { profileId: profile.profileId, address: profile.address, nodes, edges, pressure: this.memoryPressure(profile) };
  }

  /** Aggregate network memory stats for the status strip. */
  stats() {
    const state = this._state();
    const profiles = Object.values(state.profiles);
    return {
      ...state.stats,
      profiles: profiles.length,
      activeTraces: profiles.reduce((sum, p) => sum + Object.values(p.traces).filter((t) => t.status === 'active').length, 0),
      totalWins: profiles.reduce((sum, p) => sum + p.record.wins, 0),
      totalMatches: profiles.reduce((sum, p) => sum + p.record.history.length, 0),
      loadouts: profiles.reduce((sum, p) => sum + Object.keys(p.loadouts).length, 0),
      companionsTracked: profiles.reduce((sum, p) => sum + Object.keys(p.companionBehaviors).length, 0),
      skills: Object.keys(state.skills || {}).length,
    };
  }
}

module.exports = { EntropyMemory, BASE_SKILLS, LOADOUT_SLOTS, xpForLevel, levelFromXp };
