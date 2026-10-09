'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MISSIONS · WORLD EVENTS · SEASONS  —  the cadence layer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Four cadences, one generator, zero hand-authored content per day:
 *
 *      daily     seeded from (genesisSeed, epochDay)        — resets 00:00 UTC
 *      weekly    seeded from (genesisSeed, ISO week)        — resets Monday
 *      seasonal  seeded from (genesisSeed, seasonId)        — 28-day ladder
 *      event     world events, deterministic per day but
 *                triggerable early by an Architect token
 *
 *  Why seed-derived instead of stored? Because then *every* node agrees on
 *  today's missions without a database sync, a player who logs in on a fresh
 *  instance sees the same objectives, and the content cost of a year of dailies
 *  is zero bytes. State only stores **progress**, never the definition.
 *
 *  Progress is event-driven: `observe()` is the single funnel that every other
 *  system calls (match recorded, scan run, weave fused, block mined, raid
 *  cleared). Objective counters are matched by `objective.event`, so adding a
 *  new objective type never requires touching the systems that emit events.
 *
 *  Rewards are Reality Units (RLU) + memory xp + occasional mined artifacts.
 *  Nothing here is a currency with monetary value — see reality-gen.js.
 */

const {
  deriveAddress,
  createRng,
  hashHex,
  nowIso,
  clamp,
  round,
  epochDay,
  weekKey,
  dailySeed,
  weeklySeed,
  seasonalSeed,
  DAY_MS,
} = require('../core/entropy-core');
const { briefFrom } = require('../core/reality-gen');
const { toBadRequest, toNotFound } = require('../core/http');

const DOMAIN = 'missions';

/** Season length in days. 28 keeps seasons aligned to whole weeks. */
const SEASON_LENGTH_DAYS = 28;

/**
 * Season 1 begins on this date. Anchoring to an ISO string (rather than a raw
 * day number) keeps season numbering human-checkable: seasonId S001 starts
 * 2026-06-01, S002 on 2026-06-29, and so on forever. 28 days = exactly four
 * weeks, so weekly missions always land inside one season.
 */
const SEASON_EPOCH_ISO = '2026-06-01T00:00:00Z';
const SEASON_EPOCH_DAY = Math.floor(Date.parse(SEASON_EPOCH_ISO) / DAY_MS);

/* ── objective vocabulary ─────────────────────────────────────────────────── */

const OBJECTIVE_EVENTS = Object.freeze({
  'match.win': { label: 'Win a match', defaultTarget: 3 },
  'match.play': { label: 'Play a match', defaultTarget: 5 },
  'match.raid.win': { label: 'Clear a raid', defaultTarget: 1 },
  'scan.run': { label: 'Run a scan', defaultTarget: 4 },
  'scan.deep': { label: 'Run a deep scan', defaultTarget: 2 },
  'scan.rare': { label: 'Find a plated contact', defaultTarget: 1 },
  'weave.unlock': { label: 'Unlock an ability', defaultTarget: 2 },
  'weave.fuse': { label: 'Weave a fusion', defaultTarget: 1 },
  'weave.stable': { label: 'Land a stable weave', defaultTarget: 1 },
  'squad.recruit': { label: 'Recruit a companion', defaultTarget: 1 },
  'squad.drill': { label: 'Drill a tactic', defaultTarget: 3 },
  'squad.quirk': { label: 'Surface a companion quirk', defaultTarget: 1 },
  'miner.block': { label: 'Mine a reality block', defaultTarget: 1 },
  'miner.share': { label: 'Submit pool shares', defaultTarget: 20 },
  'unmask.seal': { label: 'Unmask a pending seal', defaultTarget: 1 },
  'lobby.join': { label: 'Join a safe lobby', defaultTarget: 2 },
  'party.form': { label: 'Form a party', defaultTarget: 1 },
  'memory.recall': { label: 'Recall a trace', defaultTarget: 3 },
  'ar.anchor': { label: 'Pin a map anchor', defaultTarget: 2 },
});

const OBJECTIVE_EVENT_IDS = Object.keys(OBJECTIVE_EVENTS);

/** Mission archetypes: title pattern, cadence weighting, objective picks. */
const ARCHETYPES = Object.freeze([
  { id: 'recon', title: 'Recon of {place}', weight: 14, events: ['scan.run', 'scan.deep', 'ar.anchor'], rewardRlu: 26, xp: 40, note: 'perception cadence' },
  { id: 'weave-trial', title: 'Weave Trial: {glyph}', weight: 12, events: ['weave.unlock', 'weave.fuse', 'weave.stable'], rewardRlu: 38, xp: 60, note: 'power-weaving cadence' },
  { id: 'squad-bond', title: 'Squad Bond: {companion}', weight: 12, events: ['squad.recruit', 'squad.drill', 'squad.quirk'], rewardRlu: 24, xp: 45, note: 'companion learning cadence' },
  { id: 'gate-hold', title: 'Hold {place}', weight: 13, events: ['match.win', 'match.play', 'lobby.join'], rewardRlu: 30, xp: 50, note: 'combat cadence' },
  { id: 'deep-raid', title: 'Raid Contract: {place}', weight: 8, events: ['match.raid.win', 'party.form', 'match.win'], rewardRlu: 70, xp: 120, note: 'co-op cadence' },
  { id: 'reality-quota', title: 'Reality Quota {n}', weight: 10, events: ['miner.block', 'miner.share'], rewardRlu: 44, xp: 55, note: 'mining cadence' },
  { id: 'recall-rite', title: 'Recall Rite: {memory}', weight: 9, events: ['memory.recall', 'unmask.seal'], rewardRlu: 22, xp: 38, note: 'memory cadence' },
]);

const WORLD_EVENT_KINDS = Object.freeze([
  { id: 'chromium-rain', title: 'Chromium Rain', modifier: { kind: 'rluMultiplier', value: 1.5, scope: 'mining' }, note: 'mined reality pays 1.5×' },
  { id: 'tidal-surge', title: 'Tidal Surge', modifier: { kind: 'scanDepthBonus', value: 2, scope: 'ar' }, note: 'deep scans reach further' },
  { id: 'weave-bloom', title: 'Weave Bloom', modifier: { kind: 'stabilityBonus', value: 8, scope: 'weave' }, note: '+8 stability on all fusions' },
  { id: 'quiet-accord', title: 'The Quiet Accord', modifier: { kind: 'safetyBoost', value: 12, scope: 'multiplayer' }, note: 'lobby safety scores rise' },
  { id: 'unmask-vigil', title: 'Unmask Vigil', modifier: { kind: 'pendingDiscount', value: 0.7, scope: 'keyring' }, note: 'seals need 30% less smart value' },
  { id: 'signal-chorus', title: 'Signal Chorus', modifier: { kind: 'bondMultiplier', value: 1.6, scope: 'squad' }, note: 'companion bond accrues faster' },
  { id: 'memory-tide', title: 'Memory Tide', modifier: { kind: 'recallBoost', value: 1.4, scope: 'memory' }, note: 'recall scores lifted; traces decay slower' },
]);

/** Season ladder: tier thresholds are fractions of season xp. */
const SEASON_TIERS = Object.freeze([
  { tier: 1, name: 'Unmasked', atXp: 0, rewardRlu: 40, note: 'entry' },
  { tier: 2, name: 'Plated', atXp: 400, rewardRlu: 90, note: 'first chromium plate' },
  { tier: 3, name: 'Woven', atXp: 1100, rewardRlu: 180, note: 'fusion authority' },
  { tier: 4, name: 'Tide-Bound', atXp: 2200, rewardRlu: 320, note: 'world-event immunity' },
  { tier: 5, name: 'Chorus', atXp: 3800, rewardRlu: 520, note: 'squad oath tier' },
  { tier: 6, name: 'Architect', atXp: 6000, rewardRlu: 820, note: 'may author world events' },
  { tier: 7, name: 'Genesis', atXp: 9000, rewardRlu: 1400, note: 'unmask authority' },
]);

class Missions {
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
      progress: {}, // `${profileId}:${missionId}` → progress record
      accepted: {}, // profileId → [missionId]
      completed: {}, // profileId → [{missionId, at, rewardRlu, xp}]
      seasons: {}, // profileId → {seasonId, xp, claimedTiers[]}
      events: {}, // eventId → live world event
      eventLog: [],
      stats: { completed: 0, rluPaid: 0, xpPaid: 0, eventsTriggered: 0 },
    });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'missions', ...meta });
  }

  /* ─────────────────────────────── seasons ────────────────────────────── */

  /** Current season descriptor — deterministic from the epoch day. */
  currentSeason(day = epochDay()) {
    const index = Math.max(0, Math.floor((day - SEASON_EPOCH_DAY) / SEASON_LENGTH_DAYS));
    const seasonId = `S${String(index + 1).padStart(3, '0')}`;
    const startDay = SEASON_EPOCH_DAY + index * SEASON_LENGTH_DAYS;
    const endDay = startDay + SEASON_LENGTH_DAYS - 1;
    const rng = createRng(seasonalSeed(this.seed, seasonId));
    const laws = this.peers.miners ? this.peers.miners.fragmentsByKind('law', { limit: 3 }) : [];
    return {
      seasonId,
      index: index + 1,
      name: `Season of the ${rng.pick(['Ninth Tide', 'Pale Spiral', 'Quiet Choir', 'Second Sunrise', 'Woven Basalt', 'Unmask Light', 'Chromium Rain', 'Held Breath'])}`,
      codename: `SEASON-${seasonId}`,
      address: deriveAddress({ domain: 'MSN', seed: this.seed, label: `season:${seasonId}`, sublabel: 'season' }).address,
      startsAt: new Date(startDay * DAY_MS).toISOString(),
      endsAt: new Date((endDay + 1) * DAY_MS - 1).toISOString(),
      dayOfSeason: day - startDay + 1,
      daysRemaining: Math.max(0, endDay - day),
      tiers: SEASON_TIERS,
      laws: laws.length
        ? laws.map((l) => ({ text: l.text, address: l.address, source: 'mined' }))
        : [
            {
              text: `${rng.pick(['The Watchtower', 'The Weave Council', 'The Quiet Accord'])} ${rng.pick(['remembers', 'witnesses', 'rewards'])} ${rng.pick(['unsealed memory', 'unscored kindness', 'a companion left behind'])} this season.`,
              address: deriveAddress({ domain: 'MSN', seed: this.seed, label: `season:${seasonId}`, sublabel: 'law' }).address,
              source: 'derived',
            },
          ],
      modifiers: this.liveWorldEvents().map((e) => ({ eventId: e.eventId, kind: e.modifier.kind, value: e.modifier.value, scope: e.modifier.scope })),
    };
  }

  /** Season progression for a profile (tier, xp, unclaimed rewards). */
  seasonProgress(profileId, { claim = false } = {}) {
    const state = this._state();
    const season = this.currentSeason();
    const record = state.seasons[profileId] || { profileId, seasonId: season.seasonId, xp: 0, claimedTiers: [], history: [] };
    if (record.seasonId !== season.seasonId) {
      // Season turn: archive the old record, start a fresh one.
      record.history = [{ seasonId: record.seasonId, xp: record.xp, tiers: record.claimedTiers.length, archivedAt: nowIso() }, ...(record.history || [])].slice(0, 12);
      record.seasonId = season.seasonId;
      record.xp = 0;
      record.claimedTiers = [];
      this.bus.emit('missions.season.turn', { profileId, seasonId: season.seasonId });
    }
    const tier = [...SEASON_TIERS].reverse().find((t) => record.xp >= t.atXp) || SEASON_TIERS[0];
    const next = SEASON_TIERS.find((t) => t.atXp > record.xp) || null;
    const claimable = SEASON_TIERS.filter((t) => record.xp >= t.atXp && !record.claimedTiers.includes(t.tier));

    if (claim && claimable.length && this.peers.miners) {
      let total = 0;
      for (const t of claimable) {
        this.peers.miners.creditReality({ profileId, amount: t.rewardRlu, reason: `season ${season.seasonId} tier ${t.tier} (${t.name})`, actor: profileId });
        record.claimedTiers.push(t.tier);
        total += t.rewardRlu;
      }
      state.seasons[profileId] = record;
      this._save(state, { actor: profileId, kind: 'missions.season.claim', reason: `${claimable.length} tiers → ${total} RLU` });
      return { ...this._seasonView(record, season, tier, next, []), claimed: { tiers: claimable.map((t) => t.tier), rlu: total } };
    }

    state.seasons[profileId] = record;
    this._save(state, { actor: profileId, kind: 'missions.season.read' });
    return { ...this._seasonView(record, season, tier, next, claimable), claimed: null };
  }

  _seasonView(record, season, tier, next, claimable) {
    return {
      profileId: record.profileId,
      season: { seasonId: season.seasonId, name: season.name, address: season.address, endsAt: season.endsAt, daysRemaining: season.daysRemaining },
      xp: record.xp,
      tier: { ...tier, progress: next ? round((record.xp - tier.atXp) / (next.atXp - tier.atXp), 3) : 1 },
      nextTier: next ? { ...next, xpNeeded: next.atXp - record.xp } : null,
      claimedTiers: record.claimedTiers,
      claimableTiers: claimable.map((t) => ({ tier: t.tier, name: t.name, rewardRlu: t.rewardRlu })),
      history: record.history || [],
    };
  }

  /* ─────────────────────── mission generation (daily/weekly) ──────────── */

  /**
   * Generate the mission set for a cadence. Pure function of the seed + date,
   * so it can be called on every request without storing definitions.
   *
   * @param {'daily'|'weekly'|'seasonal'|'event'} cadence
   */
  generate(cadence, { day = epochDay(), week = weekKey(), limit = null, profileId = null } = {}) {
    const season = this.currentSeason(day);
    const seed =
      cadence === 'daily'
        ? dailySeed(this.seed, day)
        : cadence === 'weekly'
          ? weeklySeed(this.seed, week)
          : cadence === 'seasonal'
            ? seasonalSeed(this.seed, season.seasonId)
            : `${this.seed}|event|${day}`;
    const rng = createRng(seed);
    const counts = { daily: 4, weekly: 3, seasonal: 2, event: 1 };
    const count = limit ?? counts[cadence] ?? 3;

    const bag = [];
    for (const archetype of ARCHETYPES) for (let i = 0; i < archetype.weight; i += 1) bag.push(archetype);

    const missions = [];
    const usedArchetypes = new Set();
    for (let i = 0; i < count; i += 1) {
      let archetype = rng.pick(bag);
      let guard = 0;
      while (usedArchetypes.has(archetype.id) && guard < 12) {
        archetype = rng.pick(bag);
        guard += 1;
      }
      usedArchetypes.add(archetype.id);

      const objectiveCount = cadence === 'daily' ? rng.range(2, 3) : cadence === 'weekly' ? rng.range(3, 4) : 2;
      const events = rng.shuffle(archetype.events).slice(0, objectiveCount);
      const cadenceMultiplier = { daily: 1, weekly: 2.4, seasonal: 4, event: 1.6 }[cadence] || 1;
      const placeName = this._placeName(rng);

      const objectives = events.map((event, idx) => ({
        objectiveId: `${archetype.id}-${idx}`,
        event,
        label: OBJECTIVE_EVENTS[event]?.label || event,
        target: Math.max(1, Math.round((OBJECTIVE_EVENTS[event]?.defaultTarget || 3) * cadenceMultiplier * rng.float(0.8, 1.3))),
        progress: 0,
      }));

      const missionId = hashHex('mission', cadence, seed, archetype.id, i).slice(0, 16);
      const rewardRlu = round(archetype.rewardRlu * cadenceMultiplier * rng.float(0.9, 1.25) * this.eventMultiplier('rluMultiplier'), 1);
      const xp = Math.round(archetype.xp * cadenceMultiplier * rng.float(0.9, 1.2));
      const expiresAt =
        cadence === 'daily'
          ? new Date((day + 1) * DAY_MS).toISOString()
          : cadence === 'weekly'
            ? new Date((day + (7 - (day % 7))) * DAY_MS).toISOString()
            : season.endsAt;

      const fragments = this.peers.miners ? this.peers.miners.recentFragments({ limit: 12 }) : [];
      const brief = briefFrom({ seed: `${seed}|${missionId}`, fragments, title: archetype.title.replace('{place}', placeName).replace('{glyph}', `Glyph ${rng.pick(['ŽEON', 'BLEU', 'UNMASK', 'TIDE', 'LOOM'])}`).replace('{companion}', this.peers.squad ? (this.peers.squad.roster().companions[rng.int(9)]?.name || 'the bench') : 'the bench').replace('{memory}', rng.pick(['first win', 'lost raid', 'unmask ceremony'])).replace('{n}', String(rng.range(2, 9))) });

      missions.push({
        missionId,
        cadence,
        archetype: archetype.id,
        title: brief.title,
        brief: brief.text,
        venue: brief.venue,
        address: deriveAddress({ domain: 'MSN', seed: this.seed, label: missionId, sublabel: cadence }).address,
        evmAddress: deriveAddress({ domain: 'MSN', seed: this.seed, label: missionId, sublabel: cadence }).evm,
        objectives,
        rewardRlu,
        rewardXp: xp,
        seasonId: season.seasonId,
        day,
        week: cadence === 'weekly' ? week : null,
        seedFingerprint: hashHex('mission-fp', seed, missionId).slice(0, 16),
        issuedAt: new Date(day * DAY_MS).toISOString(),
        expiresAt,
        difficulty: clamp(Math.round(objectives.reduce((s, o) => s + o.target, 0) / 6) + (cadence === 'weekly' ? 2 : 0), 1, 10),
      });
    }
    return { cadence, day, week, seasonId: season.seasonId, count: missions.length, missions };
  }

  _placeName(rng) {
    const prefixes = ['Mirror', 'Quiet', 'Solar', 'Hollow', 'Bright', 'Deep', 'Glass', 'Amber'];
    const cores = ['Basin', 'Terrace', 'Archive', 'Reef', 'Spire', 'Causeway', 'Foundry', 'Atrium'];
    return `${rng.pick(prefixes)} ${rng.pick(cores)}`;
  }

  /** The full board for a player: daily + weekly + seasonal + accepted state. */
  board(profileId, { day = epochDay() } = {}) {
    const state = this._state();
    const accepted = new Set(state.accepted[profileId] || []);
    const withProgress = (mission) => {
      const key = `${profileId}:${mission.missionId}`;
      const progress = state.progress[key];
      const objectives = mission.objectives.map((o) => ({ ...o, progress: progress?.objectives?.[o.objectiveId] ?? 0 }));
      const complete = objectives.every((o) => o.progress >= o.target);
      return {
        ...mission,
        objectives,
        accepted: accepted.has(mission.missionId),
        status: state.completed[profileId]?.some((c) => c.missionId === mission.missionId) ? 'completed' : complete ? 'ready' : accepted.has(mission.missionId) ? 'active' : 'available',
        progressPct: round(objectives.reduce((s, o) => s + clamp(o.progress / o.target, 0, 1), 0) / objectives.length, 3),
      };
    };
    return {
      profileId,
      day,
      week: weekKey(new Date(day * DAY_MS)),
      season: this.currentSeason(day),
      daily: this.generate('daily', { day, profileId }).missions.map(withProgress),
      weekly: this.generate('weekly', { day, profileId }).missions.map(withProgress),
      seasonal: this.generate('seasonal', { day, profileId }).missions.map(withProgress),
      completed: (state.completed[profileId] || []).slice(0, 12),
      liveEvents: this.liveWorldEvents(),
    };
  }

  /** Look up one mission definition by id across cadences. */
  findMission(missionId, { day = epochDay() } = {}) {
    for (const cadence of ['daily', 'weekly', 'seasonal', 'event']) {
      const found = this.generate(cadence, { day }).missions.find((m) => m.missionId === missionId);
      if (found) return found;
    }
    return null;
  }

  /** Accept a mission (low risk; progress then accrues automatically). */
  accept(profileId, missionId, { actor = null } = {}) {
    const state = this._state();
    const mission = this.findMission(missionId);
    if (!mission) throw toNotFound(`unknown mission: ${missionId}`);
    state.accepted[profileId] = [...new Set([...(state.accepted[profileId] || []), missionId])];
    const key = `${profileId}:${missionId}`;
    if (!state.progress[key]) {
      state.progress[key] = { profileId, missionId, cadence: mission.cadence, objectives: {}, startedAt: nowIso(), expiresAt: mission.expiresAt };
    }
    this._save(state, { actor: actor || profileId, kind: 'missions.accept', reason: missionId });
    this.bus.emit('missions.accepted', { profileId, missionId, title: mission.title, cadence: mission.cadence });
    if (this.peers.memory) {
      this.peers.memory.remember(profileId, { kind: 'mission', text: `Accepted "${mission.title}" (${mission.cadence}).`, tags: ['mission', mission.cadence], resonance: 0.9, decayDays: mission.cadence === 'daily' ? 14 : 60, source: 'missions' }, { actor: actor || profileId });
    }
    return { missionId, accepted: true, mission };
  }

  /** Missions the player has accepted and not completed (used by AR layer). */
  activeFor(profileId, { limit = 6 } = {}) {
    const state = this._state();
    if (!profileId) return { missions: [] };
    const accepted = state.accepted[profileId] || [];
    const missions = accepted
      .map((id) => this.findMission(id))
      .filter(Boolean)
      .map((mission) => {
        const progress = state.progress[`${profileId}:${mission.missionId}`] || {};
        const objectives = mission.objectives.map((o) => ({ ...o, progress: progress.objectives?.[o.objectiveId] ?? 0 }));
        return { ...mission, objectives, progress: round(objectives.reduce((s, o) => s + clamp(o.progress / o.target, 0, 1), 0) / objectives.length, 3), address: mission.address };
      })
      .filter((m) => Date.parse(m.expiresAt) > Date.now())
      .slice(0, clamp(limit, 1, 20));
    return { profileId, count: missions.length, missions };
  }

  /* ────────────────────────── the event funnel ────────────────────────── */

  /**
   * Observe a gameplay event and advance every matching objective.
   * This is the ONLY place progress is written, which keeps the whole cadence
   * layer auditable from a single call site.
   *
   * @param {object} input {profileId, event, amount, meta}
   */
  observe({ profileId, event, amount = 1, meta = {} } = {}) {
    if (!profileId || !OBJECTIVE_EVENT_IDS.includes(event)) return { observed: false, reason: 'unknown event or missing profile' };
    const state = this._state();
    const accepted = state.accepted[profileId] || [];
    if (!accepted.length) return { observed: false, reason: 'no accepted missions' };

    const advanced = [];
    let readyToComplete = [];
    for (const missionId of accepted) {
      const key = `${profileId}:${missionId}`;
      const progress = state.progress[key];
      if (!progress) continue;
      if (Date.parse(progress.expiresAt) <= Date.now()) continue;
      const mission = this.findMission(missionId);
      if (!mission) continue;
      progress.objectives = progress.objectives || {};
      let changed = false;
      for (const objective of mission.objectives) {
        if (objective.event !== event) continue;
        const before = progress.objectives[objective.objectiveId] ?? 0;
        const after = Math.min(objective.target, before + Number(amount));
        if (after !== before) {
          progress.objectives[objective.objectiveId] = after;
          changed = true;
          advanced.push({ missionId, objectiveId: objective.objectiveId, label: objective.label, from: before, to: after, target: objective.target });
        }
      }
      if (changed) {
        progress.updatedAt = nowIso();
        const done = mission.objectives.every((o) => (progress.objectives[o.objectiveId] ?? 0) >= o.target);
        progress.pct = round(mission.objectives.reduce((s, o) => s + clamp((progress.objectives[o.objectiveId] ?? 0) / o.target, 0, 1), 0) / mission.objectives.length, 3);
        if (done) readyToComplete.push({ missionId, mission, progress });
      }
    }

    if (advanced.length) this._save(state, { actor: profileId, kind: 'missions.progress', reason: event });
    if (readyToComplete.length) this.bus.emit('missions.ready', { profileId, missionIds: readyToComplete.map((r) => r.missionId) });

    return { observed: true, event, advanced, ready: readyToComplete.map((r) => ({ missionId: r.missionId, title: r.mission.title, rewardRlu: r.mission.rewardRlu, rewardXp: r.mission.rewardXp })) };
  }

  /** Claim a completed mission: pays RLU + season xp, writes memory. */
  complete(profileId, missionId, { actor = null } = {}) {
    const state = this._state();
    const key = `${profileId}:${missionId}`;
    const progress = state.progress[key];
    if (!progress) throw toBadRequest('mission not accepted', { missionId });
    if ((state.completed[profileId] || []).some((c) => c.missionId === missionId)) throw toBadRequest('mission already completed', { missionId });
    const mission = this.findMission(missionId);
    if (!mission) throw toNotFound(`unknown mission: ${missionId}`);
    const done = mission.objectives.every((o) => (progress.objectives?.[o.objectiveId] ?? 0) >= o.target);
    if (!done) throw toBadRequest('objectives incomplete', { objectives: mission.objectives.map((o) => ({ ...o, progress: progress.objectives?.[o.objectiveId] ?? 0 })) });

    const rewardRlu = round(mission.rewardRlu * this.eventMultiplier('rluMultiplier'), 1);
    if (this.peers.miners) this.peers.miners.creditReality({ profileId, amount: rewardRlu, reason: `mission ${missionId}`, actor: actor || profileId });

    const season = this.currentSeason();
    const seasonRecord = state.seasons[profileId] || { profileId, seasonId: season.seasonId, xp: 0, claimedTiers: [], history: [] };
    seasonRecord.xp = (seasonRecord.xp || 0) + mission.rewardXp;
    state.seasons[profileId] = seasonRecord;

    state.completed[profileId] = [{ missionId, title: mission.title, cadence: mission.cadence, at: nowIso(), rewardRlu, xp: mission.rewardXp, address: mission.address }, ...(state.completed[profileId] || [])].slice(0, 200);
    state.accepted[profileId] = (state.accepted[profileId] || []).filter((id) => id !== missionId);
    progress.status = 'completed';
    progress.completedAt = nowIso();
    state.stats.completed += 1;
    state.stats.rluPaid = round(state.stats.rluPaid + rewardRlu, 1);
    state.stats.xpPaid += mission.rewardXp;
    this._save(state, { actor: actor || profileId, kind: 'missions.complete', reason: `${missionId} → ${rewardRlu} RLU` });
    this.bus.emit('missions.completed', { profileId, missionId, title: mission.title, rewardRlu, xp: mission.rewardXp });

    if (this.peers.memory) {
      this.peers.memory.remember(profileId, { kind: 'mission-complete', text: `Completed "${mission.title}" (+${rewardRlu} RLU, +${mission.rewardXp} season xp).`, tags: ['mission', mission.cadence, 'complete'], resonance: 1.6, decayDays: 120, source: 'missions', ref: { missionId, address: mission.address } }, { actor: actor || profileId });
      this.peers.memory.recordSkillUse(profileId, mission.cadence === 'weekly' ? 'tide-sense' : 'seal-discipline', { outcome: 'win', actor: actor || profileId });
    }

    const tier = [...SEASON_TIERS].reverse().find((t) => seasonRecord.xp >= t.atXp) || SEASON_TIERS[0];
    return { missionId, title: mission.title, rewardRlu, rewardXp: mission.rewardXp, season: { seasonId: season.seasonId, xp: seasonRecord.xp, tier: tier.name, tierIndex: tier.tier }, at: progress.completedAt };
  }

  /* ───────────────────────────── world events ─────────────────────────── */

  /** Deterministic world events for today (plus any manually triggered ones). */
  /**
   * Reverse index: resolve an EX-MSN-… address to today's mission or a world
   * event. Missions are generated, not stored, so this regenerates the cadence
   * boards and searches them — deterministic, therefore cheap to trust.
   * @returns {{type:'mission'|'world-event'|'season', record:object}|null}
   */
  findByAddress(address) {
    if (!address) return null;
    for (const cadence of ['daily', 'weekly', 'seasonal']) {
      const found = this.generate(cadence).find((m) => m.address === address);
      if (found) return { type: 'mission', record: { ...found, cadence } };
    }
    const event = [...this.worldEvents(), ...this.liveWorldEvents()].find((e) => e.address === address);
    if (event) return { type: 'world-event', record: event };
    const season = this.currentSeason();
    if (season.address === address) return { type: 'season', record: season };
    return null;
  }

  worldEvents({ day = epochDay() } = {}) {
    const rng = createRng(`${this.seed}|world-events|${day}`);
    const count = rng.range(1, 3);
    const chosen = rng.shuffle(WORLD_EVENT_KINDS).slice(0, count);
    return chosen.map((kind, i) => {
      const startHour = rng.range(0, 20);
      const durationHours = rng.range(2, 8);
      const eventId = hashHex('world-event', this.seed, day, kind.id).slice(0, 14);
      return {
        eventId,
        kind: kind.id,
        title: kind.title,
        text: `${kind.title}: ${kind.note}.`,
        modifier: kind.modifier,
        address: deriveAddress({ domain: 'MSN', seed: this.seed, label: eventId, sublabel: kind.id }).address,
        startsAt: new Date(day * DAY_MS + startHour * 3600_000).toISOString(),
        endsAt: new Date(day * DAY_MS + (startHour + durationHours) * 3600_000).toISOString(),
        intensity: round(rng.float(0.3, 1), 2),
        day,
        origin: 'scheduled',
      };
    });
  }

  /** Events live right now (scheduled + triggered). */
  liveWorldEvents(now = Date.now()) {
    const state = this._state();
    const day = Math.floor(now / DAY_MS);
    const scheduled = this.worldEvents({ day }).concat(this.worldEvents({ day: day - 1 }));
    const triggered = Object.values(state.events);
    return [...scheduled, ...triggered]
      .filter((e) => Date.parse(e.startsAt) <= now && Date.parse(e.endsAt) > now)
      .sort((a, b) => Date.parse(b.intensity) - Date.parse(a.intensity));
  }

  /** Multiplier lookup used by rewards (e.g. chromium rain → 1.5× RLU). */
  eventMultiplier(kind, now = Date.now()) {
    const live = this.liveWorldEvents(now).filter((e) => e.modifier.kind === kind);
    if (!live.length) return 1;
    return round(live.reduce((max, e) => Math.max(max, e.modifier.value), 1), 3);
  }

  /** Bonus lookup for non-multiplier modifiers. */
  eventBonus(kind, now = Date.now()) {
    const live = this.liveWorldEvents(now).filter((e) => e.modifier.kind === kind);
    if (!live.length) return 0;
    return live.reduce((max, e) => Math.max(max, e.modifier.value), 0);
  }

  /**
   * Trigger a world event early (Architect authority → SEVERE risk, so it is
   * smart-value gated and lands in the Unmask Pool for a normal token).
   */
  triggerWorldEvent({ kind, durationHours = 4, intensity = 0.8, reason = null }, { actor = null } = {}) {
    const spec = WORLD_EVENT_KINDS.find((k) => k.id === kind);
    if (!spec) throw toBadRequest(`unknown world event kind: ${kind}`, { valid: WORLD_EVENT_KINDS.map((k) => k.id) });
    const state = this._state();
    const now = Date.now();
    const eventId = hashHex('world-event-trigger', this.seed, kind, now, actor).slice(0, 14);
    const event = {
      eventId,
      kind: spec.id,
      title: spec.title,
      text: `${spec.title} (triggered): ${spec.note}. Reason — ${reason || 'architect directive'}.`,
      modifier: spec.modifier,
      address: deriveAddress({ domain: 'MSN', seed: this.seed, label: eventId, sublabel: `${spec.id}:triggered` }).address,
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(now + clamp(Number(durationHours), 1, 72) * 3600_000).toISOString(),
      intensity: round(clamp(Number(intensity), 0.1, 1), 2),
      origin: 'triggered',
      triggeredBy: actor,
      reason,
    };
    state.events[eventId] = event;
    state.eventLog = [event, ...state.eventLog].slice(0, 100);
    state.stats.eventsTriggered += 1;
    this._save(state, { actor: actor || 'architect', kind: 'missions.event.trigger', reason: `${kind}: ${reason || 'no reason given'}` });
    this.bus.emit('missions.worldEvent', { eventId, title: event.title, modifier: event.modifier, endsAt: event.endsAt });
    return event;
  }

  /** Leaderboard for a cadence (most completions / RLU earned). */
  leaderboard({ cadence = null, limit = 20 } = {}) {
    const state = this._state();
    const rows = Object.entries(state.completed)
      .map(([profileId, list]) => {
        const filtered = cadence ? list.filter((c) => c.cadence === cadence) : list;
        return {
          profileId,
          completions: filtered.length,
          rlu: round(filtered.reduce((s, c) => s + (c.rewardRlu || 0), 0), 1),
          xp: filtered.reduce((s, c) => s + (c.rewardXp || 0), 0),
          lastAt: filtered[0]?.at || null,
        };
      })
      .filter((r) => r.completions > 0)
      .sort((a, b) => b.rlu - a.rlu)
      .slice(0, clamp(limit, 1, 100));
    rows.forEach((row, i) => {
      row.rank = i + 1;
      if (this.peers.memory) {
        const profile = this.peers.memory.getProfile(row.profileId);
        row.alias = profile?.alias || row.profileId;
        row.address = profile?.address || null;
      }
    });
    return { cadence, count: rows.length, leaderboard: rows };
  }

  stats() {
    const state = this._state();
    const season = this.currentSeason();
    return {
      ...state.stats,
      playersWithProgress: Object.keys(state.progress).length,
      acceptedTotal: Object.values(state.accepted).reduce((s, list) => s + list.length, 0),
      liveEvents: this.liveWorldEvents().length,
      season: { seasonId: season.seasonId, name: season.name, dayOfSeason: season.dayOfSeason, daysRemaining: season.daysRemaining, tiers: SEASON_TIERS.length },
      archetypes: ARCHETYPES.length,
      objectiveEvents: OBJECTIVE_EVENT_IDS.length,
      worldEventKinds: WORLD_EVENT_KINDS.length,
    };
  }
}

module.exports = { Missions, SEASON_LENGTH_DAYS, SEASON_EPOCH_ISO, SEASON_EPOCH_DAY, SEASON_TIERS, ARCHETYPES, OBJECTIVE_EVENTS, OBJECTIVE_EVENT_IDS, WORLD_EVENT_KINDS };
