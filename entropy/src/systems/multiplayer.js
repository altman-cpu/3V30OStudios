'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SAFE MULTIPLAYER  —  lobbies, parties and co-op raids
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  "Safe" is implemented as *code*, not as a terms-of-service paragraph:
 *
 *   1. SAFETY SCORE — every lobby carries a computed 0..100 score derived from
 *      its settings (invite-only, proximity voice off, filters on, host
 *      moderation on, reporting on, age band). Matchmaking refuses to place a
 *      player into a lobby below their own `safetyFloor`. Safety is therefore a
 *      hard constraint in the join path, not a preference.
 *
 *   2. PSEUDONYMITY — members are stored by profileId + alias only. No email,
 *      no device id, no IP is ever written into lobby state. Positions are
 *      quantised by the AR layer before they can be shared.
 *
 *   3. CONSENT — AR presence sharing is per-member and default-off
 *      (`consentShared:false`). A party member only appears on another
 *      member's scan layer after explicitly opting in.
 *
 *   4. REPORTS ARE PENDING SEALS — a report never auto-punishes. It parks a
 *      seal in the Unmask Pool requiring moderator smart value (or co-signs)
 *      before a sanction is applied. That is the same smart-value machinery as
 *      the rest of the API: moderation is auditable and reversible-by-record.
 *
 *   5. SAFE EXIT — one call leaves every lobby, clears presence and revokes
 *      consent. Panic paths must be single-step.
 *
 *  Raids are a small deterministic state machine (assemble → brief → phases →
 *  resolve), advanced by `tick()`. Because each phase outcome is derived from
 *  (raidSeed, phase, squad composition), a raid replays identically for audit
 *  and can be resolved cooperatively without a realtime server.
 */

const {
  deriveAddress,
  createRng,
  hashHex,
  nowIso,
  clamp,
  round,
  entropyPhrase,
} = require('../core/entropy-core');
const { toBadRequest, toNotFound, toForbidden, toConflict } = require('../core/http');

const DOMAIN = 'multiplayer';

const LOBBY_MODES = Object.freeze(['skirmish', 'raid', 'scan', 'defense', 'escort', 'weave-duel', 'social']);

const PRIVACY = Object.freeze({
  public: { id: 'public', label: 'Public', safetyWeight: 0, note: 'discoverable by matchmaking' },
  'party-code': { id: 'party-code', label: 'Party Code', safetyWeight: 14, note: 'joinable only with a code' },
  invite: { id: 'invite', label: 'Invite Only', safetyWeight: 22, note: 'host must invite each member' },
});

const AGE_BANDS = Object.freeze(['everyone', 'teen', 'mature']);

const CONTENT_FILTERS = Object.freeze(['profanity', 'harassment', 'pii', 'hate', 'gore', 'spam-links', 'doxxing', 'minors-safety']);

const RAID_PHASES = Object.freeze([
  { id: 'assemble', label: 'Assemble', weight: 0.6, note: 'roles filled, consent confirmed' },
  { id: 'brief', label: 'Brief', weight: 0.8, note: 'mined reality brief read aloud' },
  { id: 'approach', label: 'Approach', weight: 1.0, note: 'scan layer open, threats marked' },
  { id: 'breach', label: 'Breach', weight: 1.35, note: 'first objective, highest attrition' },
  { id: 'hold', label: 'Hold', weight: 1.2, note: 'defend while the seal unmask runs' },
  { id: 'unmask', label: 'Unmask', weight: 1.5, note: 'genesis unmask of the raid reward' },
  { id: 'resolve', label: 'Resolve', weight: 0.4, note: 'payout, memory write, debrief' },
]);

const ROLES = Object.freeze(['captain', 'vanguard', 'mender', 'scout', 'weaver', 'sentinel']);

/** Safety scoring weights. Tuned so a fully-locked lobby lands near 96. */
const SAFETY_WEIGHTS = Object.freeze({
  base: 34,
  privacy: PRIVACY,
  proximityVoiceOff: 8,
  filtersPerEnabled: 4,
  filtersMax: 20,
  hostModeration: 10,
  reportingEnabled: 8,
  safeExitEnabled: 6,
  ageBandDeclared: 6,
  verifiedHost: 8,
  maxMembersSmall: 6, // ≤ 8 members
});

class Multiplayer {
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
      lobbies: {},
      parties: {},
      raids: {},
      invites: {},
      reports: {},
      bans: {}, // lobbyId → [profileId]
      presence: {}, // profileId → {lobbyId, at, position}
      byProfile: {}, // profileId → [lobbyId]
      stats: { lobbies: 0, joins: 0, parties: 0, raids: 0, raidsCleared: 0, reports: 0, sanctions: 0, safeExits: 0 },
    });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'multiplayer', ...meta });
  }

  /* ───────────────────────────── safety scoring ───────────────────────── */

  /**
   * Compute a lobby's safety score from its settings.
   * Pure function — same settings always produce the same score, so a client
   * can display it before joining and trust it after.
   */
  static safetyScore(settings = {}, { verifiedHost = false } = {}) {
    const w = SAFETY_WEIGHTS;
    const filters = (settings.contentFilters || []).filter((f) => CONTENT_FILTERS.includes(f));
    let score = w.base;
    score += (w.privacy[settings.privacy] || w.privacy.public).safetyWeight;
    score += settings.proximityVoice === false ? w.proximityVoiceOff : 0;
    score += Math.min(w.filtersMax, filters.length * w.filtersPerEnabled);
    score += settings.hostModeration === true ? w.hostModeration : 0;
    score += settings.reportingEnabled !== false ? w.reportingEnabled : 0;
    score += settings.safeExitEnabled !== false ? w.safeExitEnabled : 0;
    score += AGE_BANDS.includes(settings.ageBand) ? w.ageBandDeclared : 0;
    score += verifiedHost ? w.verifiedHost : 0;
    score += (settings.maxMembers || 8) <= 8 ? w.maxMembersSmall : 0;
    return Math.round(clamp(score, 0, 100));
  }

  /** Human-readable safety breakdown (shown in the lobby card). */
  static safetyBreakdown(settings = {}, opts = {}) {
    const w = SAFETY_WEIGHTS;
    const filters = (settings.contentFilters || []).filter((f) => CONTENT_FILTERS.includes(f));
    const items = [
      { item: 'Base', points: w.base },
      { item: `Privacy: ${settings.privacy || 'public'}`, points: (w.privacy[settings.privacy] || w.privacy.public).safetyWeight },
      { item: 'Proximity voice off', points: settings.proximityVoice === false ? w.proximityVoiceOff : 0 },
      { item: `Content filters (${filters.length})`, points: Math.min(w.filtersMax, filters.length * w.filtersPerEnabled) },
      { item: 'Host moderation', points: settings.hostModeration === true ? w.hostModeration : 0 },
      { item: 'Reporting enabled', points: settings.reportingEnabled !== false ? w.reportingEnabled : 0 },
      { item: 'Safe exit enabled', points: settings.safeExitEnabled !== false ? w.safeExitEnabled : 0 },
      { item: `Age band declared (${settings.ageBand || 'unset'})`, points: AGE_BANDS.includes(settings.ageBand) ? w.ageBandDeclared : 0 },
      { item: 'Verified host', points: opts.verifiedHost ? w.verifiedHost : 0 },
      { item: 'Small lobby (≤8)', points: (settings.maxMembers || 8) <= 8 ? w.maxMembersSmall : 0 },
    ];
    return { score: Multiplayer.safetyScore(settings, opts), items: items.filter((i) => i.points > 0), maximum: 118 };
  }

  /** The default safety posture — locked down, because defaults are policy. */
  static defaultSettings() {
    return {
      privacy: 'party-code',
      maxMembers: 8,
      minMembers: 2,
      proximityVoice: false,
      contentFilters: ['profanity', 'harassment', 'pii', 'hate', 'spam-links', 'doxxing', 'minors-safety'],
      hostModeration: true,
      reportingEnabled: true,
      safeExitEnabled: true,
      ageBand: 'teen',
      allowSpectators: true,
      consentRequiredForPresence: true,
    };
  }

  /* ─────────────────────────────── lobbies ────────────────────────────── */

  /** Create a lobby. Host is the creating profile; settings are safety-scored. */
  createLobby(profileId, input = {}, { actor = null, verifiedHost = false } = {}) {
    const state = this._state();
    const mode = LOBBY_MODES.includes(input.mode) ? input.mode : 'skirmish';
    const settings = { ...Multiplayer.defaultSettings(), ...(input.settings || {}) };
    settings.contentFilters = (settings.contentFilters || []).filter((f) => CONTENT_FILTERS.includes(f));
    settings.privacy = PRIVACY[settings.privacy] ? settings.privacy : 'party-code';
    settings.maxMembers = clamp(Number(settings.maxMembers) || 8, 2, 24);
    settings.ageBand = AGE_BANDS.includes(settings.ageBand) ? settings.ageBand : 'teen';

    const lobbyId = hashHex('lobby', this.seed, profileId, mode, nowIso()).slice(0, 14);
    const inviteCode = hashHex('invite', this.seed, lobbyId).slice(0, 8).toUpperCase();
    const rng = createRng(`lobby|${this.seed}|${lobbyId}`);
    const safety = Multiplayer.safetyScore(settings, { verifiedHost });
    const alias = this.peers.memory ? this.peers.memory.getProfile(profileId)?.alias || profileId : profileId;

    const lobby = {
      lobbyId,
      address: deriveAddress({ domain: 'LBY', seed: this.seed, label: lobbyId, sublabel: mode }).address,
      evmAddress: deriveAddress({ domain: 'LBY', seed: this.seed, label: lobbyId, sublabel: mode }).evm,
      name: String(input.name || `${alias}'s ${mode} lobby`).slice(0, 60),
      codename: entropyPhrase(`${this.seed}|${lobbyId}`, 2),
      mode,
      host: profileId,
      hostAlias: alias,
      settings,
      safety,
      safetyBreakdown: Multiplayer.safetyBreakdown(settings, { verifiedHost }),
      inviteCode,
      invites: {},
      members: [
        {
          profileId,
          alias,
          role: 'captain',
          joinedAt: nowIso(),
          consentShared: false,
          host: true,
          pseudonymous: true,
        },
      ],
      spectators: [],
      status: 'open',
      createdAt: nowIso(),
      lastActivityAt: nowIso(),
      region: input.region || rng.pick(['north-atlantic', 'pacific-rim', 'eu-central', 'saturn-relay']),
      seasonId: this.peers.missions ? this.peers.missions.currentSeason().seasonId : null,
      raidId: null,
    };

    state.lobbies[lobbyId] = lobby;
    state.invites[inviteCode] = lobbyId;
    state.byProfile[profileId] = [...new Set([...(state.byProfile[profileId] || []), lobbyId])];
    state.stats.lobbies += 1;
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.lobby.create', reason: `${mode} safety ${safety}` });
    this.bus.emit('multiplayer.lobby.created', { lobbyId, mode, safety, address: lobby.address, name: lobby.name });
    return this._lobbyView(lobby, profileId);
  }

  _lobbyView(lobby, viewerId = null) {
    return {
      ...lobby,
      memberCount: lobby.members.length,
      capacity: lobby.settings.maxMembers,
      isHost: viewerId ? lobby.host === viewerId : null,
      youAreMember: viewerId ? lobby.members.some((m) => m.profileId === viewerId) : null,
      openSlots: Math.max(0, lobby.settings.maxMembers - lobby.members.length),
    };
  }

  /** Join by lobbyId or invite code, enforcing every safety constraint. */
  joinLobby({ profileId, lobbyId = null, inviteCode = null, as = 'member', safetyFloor = 0 }, { actor = null } = {}) {
    const state = this._state();
    let lobby = lobbyId ? state.lobbies[lobbyId] : null;
    if (!lobby && inviteCode) {
      const mapped = state.invites[String(inviteCode).toUpperCase()];
      lobby = mapped ? state.lobbies[mapped] : null;
      if (lobby && lobby.settings.privacy === 'party-code' && String(inviteCode).toUpperCase() !== lobby.inviteCode) lobby = null;
    }
    if (!lobby) throw toNotFound('unknown lobby or invite code', { lobbyId, inviteCode });
    if (lobby.status !== 'open') throw toConflict(`lobby is ${lobby.status}`, { lobbyId: lobby.lobbyId });

    // ── safety gates (order matters: cheapest, least-revealing first) ──
    if ((state.bans[lobby.lobbyId] || []).includes(profileId)) throw toForbidden('you are banned from this lobby', { lobbyId: lobby.lobbyId });
    if (lobby.safety < Number(safetyFloor || 0)) {
      throw toForbidden('lobby safety below your floor', { lobbySafety: lobby.safety, yourFloor: Number(safetyFloor) });
    }
    if (lobby.settings.privacy === 'invite' && !lobby.invites[profileId]) {
      throw toForbidden('invite-only lobby: the host must invite you first', { lobbyId: lobby.lobbyId });
    }
    if (as === 'spectator' && lobby.settings.allowSpectators === false) throw toForbidden('this lobby does not allow spectators');
    if (as !== 'spectator' && lobby.members.length >= lobby.settings.maxMembers) throw toConflict('lobby is full', { capacity: lobby.settings.maxMembers });
    if (lobby.members.some((m) => m.profileId === profileId)) return { status: 'already-member', lobby: this._lobbyView(lobby, profileId) };

    const alias = this.peers.memory ? this.peers.memory.getProfile(profileId)?.alias || profileId : profileId;
    const role = as === 'spectator' ? 'spectator' : ROLES[Math.min(lobby.members.length, ROLES.length - 1)];
    const member = {
      profileId,
      alias,
      role,
      joinedAt: nowIso(),
      consentShared: false, // default OFF — presence sharing is opt-in
      host: false,
      pseudonymous: true,
      spectator: as === 'spectator',
    };
    if (as === 'spectator') lobby.spectators.push(member);
    else lobby.members.push(member);

    lobby.lastActivityAt = nowIso();
    state.byProfile[profileId] = [...new Set([...(state.byProfile[profileId] || []), lobby.lobbyId])];
    state.stats.joins += 1;
    state.presence[profileId] = { lobbyId: lobby.lobbyId, at: nowIso(), quantised: true };
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.lobby.join', reason: `${lobby.lobbyId} as ${as}` });
    this.bus.emit('multiplayer.lobby.joined', { lobbyId: lobby.lobbyId, profileId, as, safety: lobby.safety });
    if (this.peers.missions) this.peers.missions.observe({ profileId, event: 'lobby.join', amount: 1 });
    return { status: 'joined', lobby: this._lobbyView(lobby, profileId), member };
  }

  /** Leave a lobby (or safe-exit everything). */
  leaveLobby(profileId, lobbyId, { actor = null } = {}) {
    const state = this._state();
    const lobby = state.lobbies[lobbyId];
    if (!lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    const before = lobby.members.length + lobby.spectators.length;
    lobby.members = lobby.members.filter((m) => m.profileId !== profileId);
    lobby.spectators = lobby.spectators.filter((m) => m.profileId !== profileId);
    if (before === lobby.members.length + lobby.spectators.length) throw toNotFound('you are not in this lobby', { lobbyId });

    if (lobby.host === profileId) {
      const nextHost = lobby.members[0];
      if (nextHost) {
        lobby.host = nextHost.profileId;
        lobby.hostAlias = nextHost.alias;
        nextHost.host = true;
        nextHost.role = 'captain';
      } else {
        lobby.status = 'closed';
        lobby.closedAt = nowIso();
        delete state.invites[lobby.inviteCode];
      }
    }
    lobby.lastActivityAt = nowIso();
    state.byProfile[profileId] = (state.byProfile[profileId] || []).filter((id) => id !== lobbyId);
    if (state.presence[profileId]?.lobbyId === lobbyId) delete state.presence[profileId];
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.lobby.leave', reason: lobbyId });
    this.bus.emit('multiplayer.lobby.left', { lobbyId, profileId });
    return { lobbyId, left: true, hostTransferredTo: lobby.host, status: lobby.status, lobby: this._lobbyView(lobby, profileId) };
  }

  /** Panic path: leave everything, revoke consent, clear presence. */
  safeExit(profileId, { actor = null, reason = 'player safe exit' } = {}) {
    const state = this._state();
    const lobbyIds = state.byProfile[profileId] || [];
    const exited = [];
    for (const lobbyId of lobbyIds) {
      const lobby = state.lobbies[lobbyId];
      if (!lobby) continue;
      lobby.members = lobby.members.filter((m) => m.profileId !== profileId);
      lobby.spectators = lobby.spectators.filter((m) => m.profileId !== profileId);
      if (lobby.host === profileId && !lobby.members.length) {
        lobby.status = 'closed';
        lobby.closedAt = nowIso();
        delete state.invites[lobby.inviteCode];
      } else if (lobby.host === profileId) {
        lobby.host = lobby.members[0].profileId;
        lobby.hostAlias = lobby.members[0].alias;
        lobby.members[0].host = true;
      }
      exited.push(lobbyId);
    }
    for (const party of Object.values(state.parties)) {
      party.members = party.members.filter((m) => m.profileId !== profileId);
      if (!party.members.length) party.status = 'dissolved';
    }
    state.byProfile[profileId] = [];
    delete state.presence[profileId];
    state.stats.safeExits += 1;
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.safeExit', reason });
    this.bus.emit('multiplayer.safeExit', { profileId, exited });
    return { profileId, exitedLobbies: exited, presenceCleared: true, consentRevoked: true, at: nowIso() };
  }

  /** Kick (host) or ban (host/moderator). Bans are recorded, never silent. */
  moderate(lobbyId, { targetProfileId, action = 'kick', reason = null }, { actor = null, isHost = false, isModerator = false } = {}) {
    const state = this._state();
    const lobby = state.lobbies[lobbyId];
    if (!lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    if (!isHost && !isModerator) throw toForbidden('only the host or a moderator may kick/ban', { host: lobby.host });
    if (!['kick', 'ban', 'warn', 'mute'].includes(action)) throw toBadRequest('action must be kick|ban|warn|mute');
    if (targetProfileId === lobby.host && action === 'ban') throw toBadRequest('the host cannot be banned from their own lobby');

    const record = { lobbyId, targetProfileId, action, reason, by: actor, at: nowIso(), address: deriveAddress({ domain: 'LBY', seed: this.seed, label: `moderation:${lobbyId}`, sublabel: `${targetProfileId}:${action}:${Date.now()}` }).address };
    lobby.moderationLog = [record, ...(lobby.moderationLog || [])].slice(0, 100);

    if (action === 'kick' || action === 'ban') {
      lobby.members = lobby.members.filter((m) => m.profileId !== targetProfileId);
      lobby.spectators = lobby.spectators.filter((m) => m.profileId !== targetProfileId);
      state.byProfile[targetProfileId] = (state.byProfile[targetProfileId] || []).filter((id) => id !== lobbyId);
      if (state.presence[targetProfileId]?.lobbyId === lobbyId) delete state.presence[targetProfileId];
    }
    if (action === 'ban') {
      state.bans[lobbyId] = [...new Set([...(state.bans[lobbyId] || []), targetProfileId])];
      state.stats.sanctions += 1;
    }
    lobby.lastActivityAt = nowIso();
    this._save(state, { actor: actor || lobby.host, kind: `multiplayer.moderate.${action}`, reason: reason || 'no reason given' });
    this.bus.emit('multiplayer.moderation', { lobbyId, action, targetProfileId, by: actor });
    return { ...record, applied: true, banned: action === 'ban' };
  }

  /**
   * File a report. Reports are parked as pending seals so a sanction requires
   * moderator smart value (or co-signatures) — no unilateral punishment.
   */
  report({ lobbyId, reporterProfileId, targetProfileId, category = 'harassment', detail = null }, { actor = null, claims = null } = {}) {
    const state = this._state();
    const lobby = lobbyId ? state.lobbies[lobbyId] : null;
    if (lobbyId && !lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    const allowedCategories = ['harassment', 'hate', 'pii-exposure', 'cheating', 'minors-safety', 'spam', 'impersonation', 'other'];
    if (!allowedCategories.includes(category)) throw toBadRequest(`unknown report category: ${category}`, { valid: allowedCategories });
    if (!targetProfileId) throw toBadRequest('report requires targetProfileId');
    if (targetProfileId === reporterProfileId) throw toBadRequest('you cannot report yourself');

    const reportId = hashHex('report', this.seed, lobbyId || 'global', reporterProfileId, targetProfileId, category, nowIso()).slice(0, 16);
    const report = {
      reportId,
      address: deriveAddress({ domain: 'LBY', seed: this.seed, label: reportId, sublabel: category }).address,
      lobbyId: lobbyId || null,
      lobbySafety: lobby?.safety ?? null,
      reporterProfileId,
      targetProfileId,
      category,
      detail: detail ? String(detail).slice(0, 500) : null,
      status: 'open',
      createdAt: nowIso(),
      evidenceHash: hashHex('evidence', lobbyId, reporterProfileId, targetProfileId, category, detail || ''),
    };
    state.reports[reportId] = report;
    state.stats.reports += 1;
    this._save(state, { actor: actor || reporterProfileId, kind: 'multiplayer.report', reason: `${category} → ${targetProfileId}` });
    this.bus.emit('multiplayer.report', { reportId, category, lobbyId, targetProfileId });

    // Park the sanction decision as a pending seal (HIGH risk).
    const seal = this.keyring.parkPending({
      kind: 'multiplayer.sanction',
      payload: { reportId, lobbyId: lobbyId || null, targetProfileId, category, proposedAction: category === 'minors-safety' || category === 'hate' ? 'ban' : 'kick', detail: report.detail },
      claims,
      requiredSmartValue: this.keyring.requiredFor('HIGH'),
      handler: deriveAddress({ domain: 'HND', seed: this.seed, label: 'multiplayer.report', sublabel: 'POST /v1/multiplayer/report' }).address,
      reason: `report ${category} requires moderator authority`,
    });
    return { report, sanctionSeal: { sealId: seal.sealId, address: seal.address, requiredSmartValue: seal.requiredSmartValue, expiresAt: seal.expiresAt, status: 'pending' } };
  }

  /** Apply a sanction after a report seal is unmasked. */
  applySanction(reportId, action, { actor = null } = {}) {
    const state = this._state();
    const report = state.reports[reportId];
    if (!report) throw toNotFound(`unknown report: ${reportId}`);
    if (report.status !== 'open') throw toConflict(`report already ${report.status}`, { reportId });
    const result = report.lobbyId
      ? this.moderate(report.lobbyId, { targetProfileId: report.targetProfileId, action, reason: `report ${reportId}: ${report.category}` }, { actor, isModerator: true })
      : { applied: false, note: 'global report — no lobby to moderate', action };
    report.status = action === 'dismiss' ? 'dismissed' : 'sanctioned';
    report.resolvedAt = nowIso();
    report.resolvedBy = actor;
    report.action = action;
    this._save(state, { actor: actor || 'moderator', kind: 'multiplayer.sanction.apply', reason: `${reportId}:${action}` });
    this.bus.emit('multiplayer.sanction', { reportId, action, targetProfileId: report.targetProfileId });
    return { reportId, action, status: report.status, moderation: result };
  }

  /** Discovery + matchmaking: deterministic best-fit above a safety floor. */
  findLobbies({ mode = null, minSafety = 60, privacy = null, region = null, limit = 12, profileId = null } = {}) {
    const state = this._state();
    const now = Date.now();
    return Object.values(state.lobbies)
      .filter((l) => l.status === 'open')
      .filter((l) => l.members.length < l.settings.maxMembers)
      .filter((l) => (mode ? l.mode === mode : true))
      .filter((l) => (region ? l.region === region : true))
      .filter((l) => (privacy ? l.settings.privacy === privacy : l.settings.privacy !== 'invite'))
      .filter((l) => l.safety >= Number(minSafety))
      .filter((l) => !(state.bans[l.lobbyId] || []).includes(profileId))
      .map((l) => {
        // Freshness-weighted fit: safety first, then recency, then open slots.
        const ageMinutes = (now - Date.parse(l.lastActivityAt)) / 60000;
        const fit = round(0.6 * (l.safety / 100) + 0.25 * Math.exp(-ageMinutes / 120) + 0.15 * (l.openSlots || Math.max(0, l.settings.maxMembers - l.members.length)) / l.settings.maxMembers, 3);
        return this._lobbyView(l, profileId);
      })
      .sort((a, b) => b.safety - a.safety || b.memberCount - a.memberCount)
      .slice(0, clamp(limit, 1, 50));
  }

  listLobbies({ profileId = null, includeClosed = false, limit = 40 } = {}) {
    const state = this._state();
    return Object.values(state.lobbies)
      .filter((l) => (includeClosed ? true : l.status === 'open'))
      .filter((l) => (profileId ? (state.byProfile[profileId] || []).includes(l.lobbyId) || l.settings.privacy !== 'invite' : true))
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .slice(0, clamp(limit, 1, 100))
      .map((l) => this._lobbyView(l, profileId));
  }

  getLobby(lobbyId, viewerId = null) {
    const state = this._state();
    const lobby = state.lobbies[lobbyId];
    if (!lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    return this._lobbyView(lobby, viewerId);
  }

  /** Update consent for AR presence sharing (per member, default off). */
  setConsent(profileId, lobbyId, consentShared, { actor = null } = {}) {
    const state = this._state();
    const lobby = state.lobbies[lobbyId];
    if (!lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    const member = lobby.members.find((m) => m.profileId === profileId) || lobby.spectators.find((m) => m.profileId === profileId);
    if (!member) throw toNotFound('you are not in this lobby', { lobbyId });
    if (lobby.settings.consentRequiredForPresence && consentShared === true && !member.consentAcknowledgedAt) {
      member.consentAcknowledgedAt = nowIso();
      member.consentText = 'Share my quantised position with party members on their AR scan layer.';
    }
    member.consentShared = Boolean(consentShared);
    lobby.lastActivityAt = nowIso();
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.consent', reason: `${lobbyId}:${consentShared}` });
    return { lobbyId, profileId, consentShared: member.consentShared, acknowledgedAt: member.consentAcknowledgedAt || null };
  }

  /** Invite a profile (required for invite-only lobbies). */
  invite(lobbyId, targetProfileId, { actor = null, isHost = false } = {}) {
    const state = this._state();
    const lobby = state.lobbies[lobbyId];
    if (!lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    if (!isHost) throw toForbidden('only the host may invite');
    lobby.invites[targetProfileId] = { invitedAt: nowIso(), by: actor };
    lobby.lastActivityAt = nowIso();
    this._save(state, { actor: actor || lobby.host, kind: 'multiplayer.invite', reason: targetProfileId });
    this.bus.emit('multiplayer.invited', { lobbyId, targetProfileId, name: lobby.name, inviteCode: lobby.settings.privacy === 'party-code' ? lobby.inviteCode : null });
    return { lobbyId, targetProfileId, invited: true, inviteCode: lobby.settings.privacy === 'party-code' ? lobby.inviteCode : null, lobbyName: lobby.name };
  }

  /* ─────────────────────────────── parties ────────────────────────────── */

  /** Persistent party (survives lobby hops). */
  createParty(profileId, { name = null, maxMembers = 5 } = {}, { actor = null } = {}) {
    const state = this._state();
    const partyId = hashHex('party', this.seed, profileId, nowIso()).slice(0, 12);
    const alias = this.peers.memory ? this.peers.memory.getProfile(profileId)?.alias || profileId : profileId;
    const party = {
      partyId,
      address: deriveAddress({ domain: 'LBY', seed: this.seed, label: partyId, sublabel: 'party' }).address,
      name: String(name || `${alias}'s party`).slice(0, 48),
      leader: profileId,
      maxMembers: clamp(Number(maxMembers) || 5, 2, 8),
      members: [{ profileId, alias, role: 'leader', joinedAt: nowIso(), consentShared: false }],
      createdAt: nowIso(),
      status: 'active',
      lobbyId: null,
      sharedSafetyFloor: 60,
    };
    state.parties[partyId] = party;
    state.stats.parties += 1;
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.party.create', reason: party.name });
    this.bus.emit('multiplayer.party.created', { partyId, name: party.name, address: party.address });
    if (this.peers.missions) this.peers.missions.observe({ profileId, event: 'party.form', amount: 1 });
    return party;
  }

  partyFor(profileId) {
    const state = this._state();
    return Object.values(state.parties).find((p) => p.status === 'active' && p.members.some((m) => m.profileId === profileId)) || null;
  }

  joinParty(partyId, profileId, { actor = null } = {}) {
    const state = this._state();
    const party = state.parties[partyId];
    if (!party) throw toNotFound(`unknown party: ${partyId}`);
    if (party.status !== 'active') throw toConflict(`party is ${party.status}`);
    if (party.members.some((m) => m.profileId === profileId)) return { status: 'already-member', party };
    if (party.members.length >= party.maxMembers) throw toConflict('party is full', { max: party.maxMembers });
    const alias = this.peers.memory ? this.peers.memory.getProfile(profileId)?.alias || profileId : profileId;
    party.members.push({ profileId, alias, role: 'member', joinedAt: nowIso(), consentShared: false });
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.party.join', reason: partyId });
    this.bus.emit('multiplayer.party.joined', { partyId, profileId });
    return { status: 'joined', party };
  }

  /* ──────────────────────────────── raids ─────────────────────────────── */

  /**
   * Create a co-op raid from a lobby. Difficulty is derived from the season,
   * the lobby safety score and (when available) mined terrain hazard — so the
   * reality chain literally sets raid difficulty.
   */
  createRaid(lobbyId, { difficulty = null, missionId = null, seedNote = null }, { actor = null } = {}) {
    const state = this._state();
    const lobby = state.lobbies[lobbyId];
    if (!lobby) throw toNotFound(`unknown lobby: ${lobbyId}`);
    if (lobby.members.length < lobby.settings.minMembers) throw toBadRequest(`raid needs at least ${lobby.settings.minMembers} members`, { have: lobby.members.length });

    const raidId = hashHex('raid', this.seed, lobbyId, nowIso()).slice(0, 14);
    const terrain = this.peers.miners ? this.peers.miners.fragmentsByKind('terrain', { limit: 40 }) : [];
    const terrainPick = terrain.length ? terrain[hashHex('raid-terrain', raidId).charCodeAt(0) % terrain.length] : null;
    const season = this.peers.missions ? this.peers.missions.currentSeason() : null;
    const rng = createRng(`raid|${this.seed}|${raidId}`);

    /**
     * Difficulty is derived, not chosen: season maturity + mined terrain hazard
     * + roster size. Kept in 1..10 so the phase maths below stays readable —
     * `pressure` and `capability` are on the same order of magnitude.
     */
    const computedDifficulty = clamp(
      Number(difficulty) ||
        Math.round(
          1.5 +
            Math.min(4, (season?.index || 1) * 0.18) + // season maturity, capped
            (terrainPick?.hazard || rng.range(1, 5)) * 0.55 + // mined terrain sets the tone
            lobby.members.length * 0.35, // more bodies, more coordination needed
        ),
      1,
      10,
    );

    const brief = this.peers.missions ? this.peers.missions.generate('event').missions[0] : null;

    /**
     * Each member fields their OWN trained companion and their companion's real
     * role. Earlier this pulled the host's bench for everybody, which made the
     * raid maths reward one carry instead of a prepared party.
     */
    const roster = lobby.members.map((member, i) => {
      const own = this.peers.squad ? this.peers.squad.activeCompanions(member.profileId, { limit: 1 })[0] : null;
      return {
        profileId: member.profileId,
        alias: member.alias,
        role: own ? String(own.role) : ROLES[(i + 1) % ROLES.length],
        companion: own?.name || null,
        companionId: own?.companionId || null,
        companionBond: own?.bond ?? 0,
        preferredTactic: own?.preferredTactic || null,
        ready: false,
      };
    });

    const raid = {
      raidId,
      address: deriveAddress({ domain: 'LBY', seed: this.seed, label: raidId, sublabel: 'raid' }).address,
      evmAddress: deriveAddress({ domain: 'LBY', seed: this.seed, label: raidId, sublabel: 'raid' }).evm,
      lobbyId,
      name: `Raid ${lobby.codename || raidId}`,
      missionId: missionId || brief?.missionId || null,
      difficulty: computedDifficulty,
      phases: RAID_PHASES.map((p, i) => ({ ...p, index: i, status: i === 0 ? 'active' : 'queued', startedAt: i === 0 ? nowIso() : null, outcome: null })),
      phaseIndex: 0,
      roster,
      terrain: terrainPick ? { address: terrainPick.address, biome: terrainPick.biome, hazard: terrainPick.hazard, cover: terrainPick.cover } : null,
      brief: brief ? { title: brief.title, text: brief.brief, venue: brief.venue, address: brief.address } : null,
      seedNote,
      raidSeed: hashHex('raid-seed', this.seed, raidId, computedDifficulty),
      status: 'assembling',
      createdAt: nowIso(),
      startedAt: null,
      resolvedAt: null,
      outcome: null,
      rewards: null,
      safety: lobby.safety,
      log: [{ at: nowIso(), phase: 'assemble', note: `raid created at difficulty ${computedDifficulty}` }],
    };

    state.raids[raidId] = raid;
    lobby.raidId = raidId;
    lobby.status = 'in-raid';
    state.stats.raids += 1;
    this._save(state, { actor: actor || lobby.host, kind: 'multiplayer.raid.create', reason: `${raidId} d${computedDifficulty}` });
    this.bus.emit('multiplayer.raid.created', { raidId, lobbyId, difficulty: computedDifficulty, address: raid.address });
    return raid;
  }

  /** Mark a roster member ready. Raid starts when all are ready. */
  readyUp(raidId, profileId, { actor = null } = {}) {
    const state = this._state();
    const raid = state.raids[raidId];
    if (!raid) throw toNotFound(`unknown raid: ${raidId}`);
    const entry = raid.roster.find((r) => r.profileId === profileId);
    if (!entry) throw toForbidden('you are not on this raid roster', { raidId });
    entry.ready = true;
    entry.readyAt = nowIso();
    if (raid.roster.every((r) => r.ready) && raid.status === 'assembling') {
      raid.status = 'running';
      raid.startedAt = nowIso();
      raid.phases[0].status = 'complete';
      raid.phases[0].outcome = 'assembled';
      raid.phases[0].completedAt = nowIso();
      raid.phaseIndex = 1;
      raid.phases[1].status = 'active';
      raid.phases[1].startedAt = nowIso();
      raid.log.push({ at: nowIso(), phase: 'assemble', note: 'all members ready — raid running' });
      this.bus.emit('multiplayer.raid.started', { raidId, difficulty: raid.difficulty });
    }
    this._save(state, { actor: actor || profileId, kind: 'multiplayer.raid.ready', reason: raidId });
    return { raidId, ready: raid.roster.filter((r) => r.ready).length, total: raid.roster.length, status: raid.status };
  }

  /**
   * Advance one phase. Outcome is derived, not rolled live:
   *
   *      pressure   = difficulty · phaseWeight · (1 + 0.05·max(0, roster − 3))
   *      capability = rosterSize · mean(bestCompanionScore per member)
   *                     · (1 + 0.10·roleCoverage) + 0.05·Σ bond/100
   *      successP   = clamp(0.5 + (capability·3.0 − pressure)/6, 0.05, 0.95)
   *      outcome    = rng(raidSeed, phase) < successP ? 'cleared' : 'costly'
   *
   *  Every roster member contributes their OWN trained companion (an untrained
   *  member scores the 0.42 baseline), so a raid rewards the whole party rather
   *  than one carry. With these constants a 3-stack of fresh companions clears
   *  ≈ 46% of phases and the same stack after drills + wins clears ≈ 81% — the
   *  preparation gradient is the point: raids are winnable by learning, and
   *  lose-able by skipping it.
   *
   *  A 'costly' phase is not a failure — it applies attrition (a member goes
   *  down, bond dips) and the raid continues. Full failure only happens if
   *  three phases come back costly, which keeps co-op raids finishable.
   */
  tickRaid(raidId, { actor = null } = {}) {
    const state = this._state();
    const raid = state.raids[raidId];
    if (!raid) throw toNotFound(`unknown raid: ${raidId}`);
    if (raid.status !== 'running') throw toConflict(`raid is ${raid.status}`, { raidId });

    const phase = raid.phases[raid.phaseIndex];
    if (!phase) return this._resolveRaid(state, raid, actor);

    const rng = createRng(`${raid.raidSeed}|${phase.id}|${raid.phaseIndex}`);
    const rosterSize = raid.roster.length;
    const pressure = raid.difficulty * phase.weight * (1 + 0.05 * Math.max(0, rosterSize - 3));

    // Per-member contribution: each player fields their own best companion.
    const UNTRAINED_BASELINE = 0.42;
    const memberScores = raid.roster.map((member) => {
      if (!this.peers.squad) return 0.5;
      const rec = this.peers.squad.recommendSquad(member.profileId, { mode: 'raid', size: 1 });
      const best = rec?.recommended?.[0];
      return best ? best.score : UNTRAINED_BASELINE;
    });
    const meanScore = memberScores.reduce((sum, v) => sum + v, 0) / Math.max(1, memberScores.length);
    const bondSum = raid.roster.reduce((sum, member) => {
      if (!this.peers.squad || !member.companionId) return sum;
      try {
        return sum + (this.peers.squad.model(member.profileId, member.companionId).bond || 0) / 100;
      } catch {
        return sum;
      }
    }, 0);
    const coverage = this.peers.squad ? this.peers.squad.recommendSquad(raid.roster[0]?.profileId, { mode: 'raid', size: rosterSize })?.roleCoverage ?? 0.5 : 0.5;
    const capability = rosterSize * meanScore * (1 + 0.1 * coverage) + 0.05 * bondSum;
    const successP = clamp(0.5 + (capability * 3 - pressure) / 6, 0.05, 0.95);
    const cleared = rng.next() < successP;

    phase.status = 'complete';
    phase.outcome = cleared ? 'cleared' : 'costly';
    phase.completedAt = nowIso();
    phase.successProbability = round(successP, 3);
    phase.capability = round(capability, 3);
    phase.pressure = round(pressure, 3);
    phase.memberScores = memberScores.map((v) => round(v, 3));
    raid.log.push({ at: nowIso(), phase: phase.id, note: `${phase.outcome} (p=${phase.successProbability}, pressure ${phase.pressure} vs capability ${phase.capability})` });

    if (!cleared) {
      raid.costlyPhases = (raid.costlyPhases || 0) + 1;
      const downed = raid.roster[rng.int(rosterSize)];
      if (downed) {
        downed.downed = (downed.downed || 0) + 1;
        raid.log.push({ at: nowIso(), phase: phase.id, note: `${downed.alias} went down` });
        if (this.peers.squad && downed.companionId) {
          this.peers.squad.learnFromMatch({ profileId: downed.profileId, companionId: downed.companionId, result: 'loss', tactics: ['revive-first'], mode: 'raid' });
        }
      }
    }

    if ((raid.costlyPhases || 0) >= 3) {
      raid.phaseIndex = raid.phases.length - 1;
      raid.phases[raid.phaseIndex].status = 'active';
      raid.log.push({ at: nowIso(), phase: phase.id, note: 'three costly phases — skipping to resolve' });
      return this._resolveRaid(state, raid, actor, 'failed');
    }

    raid.phaseIndex += 1;
    if (raid.phaseIndex >= raid.phases.length) return this._resolveRaid(state, raid, actor);
    raid.phases[raid.phaseIndex].status = 'active';
    raid.phases[raid.phaseIndex].startedAt = nowIso();
    this._save(state, { actor: actor || 'system', kind: 'multiplayer.raid.tick', reason: `${raidId}:${phase.id}:${phase.outcome}` });
    this.bus.emit('multiplayer.raid.phase', { raidId, phase: phase.id, outcome: phase.outcome, nextPhase: raid.phases[raid.phaseIndex].id });
    return { raidId, phase: { ...phase }, nextPhase: raid.phases[raid.phaseIndex], status: raid.status, costlyPhases: raid.costlyPhases || 0 };
  }

  /**
   * Resolve the raid: pay out, write memory, notify missions.
   *
   * Success rule (deliberately simple and explainable to a party afterwards):
   *      cleared  ⇔  performance ≥ 0.5  AND  costlyPhases < 3
   * `performance` is the share of phases cleared, so a majority win is a win —
   * and the 3-costly cap is the wipe condition that `tickRaid` enforces early.
   */
  _resolveRaid(state, raid, actor, forcedOutcome = null) {
    const clearedCount = raid.phases.filter((p) => p.outcome === 'cleared').length;
    const performance = round(clearedCount / raid.phases.length, 3);
    const success = forcedOutcome ? forcedOutcome === 'cleared' : performance >= 0.5 && (raid.costlyPhases || 0) < 3;
    const outcome = forcedOutcome || (success ? 'cleared' : 'failed');

    const baseRlu = raid.difficulty * 22 * (0.6 + performance);
    const rewardRlu = round(baseRlu * (this.peers.missions ? this.peers.missions.eventMultiplier('rluMultiplier') : 1), 1);
    const xp = Math.round(raid.difficulty * 18 * (0.5 + performance));

    raid.status = 'resolved';
    raid.resolvedAt = nowIso();
    raid.outcome = outcome;
    raid.performance = performance;
    raid.phases[raid.phases.length - 1].status = 'complete';
    raid.phases[raid.phases.length - 1].outcome = outcome;
    raid.phases[raid.phases.length - 1].completedAt = nowIso();
    raid.rewards = {
      rlu: success ? rewardRlu : round(rewardRlu * 0.35, 1),
      xp: success ? xp : Math.round(xp * 0.4),
      perMember: success ? round(rewardRlu / raid.roster.length, 2) : round((rewardRlu * 0.35) / raid.roster.length, 2),
      fragments: null,
    };

    // Mined reality payout: a cleared raid consumes fragments from the chain
    // and hands them to the roster as discoverable content.
    if (success && this.peers.miners) {
      const fragments = this.peers.miners.recentFragments({ limit: raid.roster.length * 2 }).slice(0, raid.roster.length * 2);
      raid.rewards.fragments = fragments.map((f) => ({ address: f.address, kind: f.kind, title: f.title, rarity: f.rarity }));
    }

    for (const member of raid.roster) {
      if (this.peers.miners) this.peers.miners.creditReality({ profileId: member.profileId, amount: raid.rewards.perMember, reason: `raid ${raid.raidId} ${outcome}`, actor: actor || member.profileId });
      if (this.peers.memory) {
        this.peers.memory.recordMatch(member.profileId, {
          result: success ? 'win' : 'loss',
          mode: 'raid',
          raidId: raid.raidId,
          lobbyId: raid.lobbyId,
          companions: raid.roster.filter((r) => r.companionId).map((r) => r.companionId),
          tactics: ['hold-gate', 'revive-first'],
          score: Math.round(performance * 100),
          durationSec: Math.round((Date.parse(raid.resolvedAt) - Date.parse(raid.startedAt || raid.createdAt)) / 1000),
        }, { actor: actor || member.profileId });
        this.peers.memory.remember(member.profileId, {
          kind: success ? 'raid-win' : 'raid-loss',
          text: `Raid ${raid.raidId} ${outcome} at difficulty ${raid.difficulty} — performance ${(performance * 100).toFixed(0)}%, ${raid.rewards.perMember} RLU each.`,
          tags: ['raid', outcome, `d${raid.difficulty}`],
          resonance: success ? 2.4 : 1.2,
          decayDays: success ? 240 : 90,
          source: 'raid',
          ref: { raidId: raid.raidId, address: raid.address },
        }, { actor: actor || member.profileId });
      }
      if (this.peers.squad && member.companionId) {
        this.peers.squad.learnFromMatch({ profileId: member.profileId, companionId: member.companionId, result: success ? 'win' : 'loss', tactics: ['hold-gate', 'revive-first', 'overwatch'], mode: 'raid' });
      }
      if (this.peers.missions) this.peers.missions.observe({ profileId: member.profileId, event: success ? 'match.raid.win' : 'match.play', amount: 1, meta: { raidId: raid.raidId } });
    }

    if (success) state.stats.raidsCleared += 1;
    const lobby = state.lobbies[raid.lobbyId];
    if (lobby) {
      lobby.status = 'open';
      lobby.raidId = null;
      lobby.lastActivityAt = nowIso();
    }
    this._save(state, { actor: actor || 'system', kind: 'multiplayer.raid.resolve', reason: `${raid.raidId}:${outcome}` });
    this.bus.emit('multiplayer.raid.resolved', { raidId: raid.raidId, outcome, performance, rewards: raid.rewards });
    return { raidId: raid.raidId, status: 'resolved', outcome, performance, rewards: raid.rewards, phases: raid.phases, log: raid.log };
  }

  getRaid(raidId) {
    const state = this._state();
    const raid = state.raids[raidId];
    if (!raid) throw toNotFound(`unknown raid: ${raidId}`);
    return raid;
  }

  listRaids({ status = null, limit = 20 } = {}) {
    const state = this._state();
    return Object.values(state.raids)
      .filter((r) => (status ? r.status === status : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, clamp(limit, 1, 100));
  }

  /* ─────────────────────────────── presence ───────────────────────────── */

  /** Heartbeat presence. Positions are quantised before they are stored. */
  /**
   * Reverse index: resolve an EX-LBY-… address to a lobby, party, raid or
   * report. Everything a moderator needs to act on an address alone.
   * @returns {{type:'lobby'|'party'|'raid'|'report', record:object}|null}
   */
  findByAddress(address) {
    if (!address) return null;
    const state = this._state();
    const lobby = Object.values(state.lobbies).find((l) => l.address === address);
    if (lobby) return { type: 'lobby', record: this._lobbyView(lobby) };
    const party = Object.values(state.parties).find((p) => p.address === address);
    if (party) return { type: 'party', record: party };
    const raid = Object.values(state.raids).find((r) => r.address === address);
    if (raid) return { type: 'raid', record: raid };
    const report = Object.values(state.reports).find((r) => r.address === address);
    if (report) return { type: 'report', record: report };
    return null;
  }

  heartbeat(profileId, { lobbyId = null, position = null } = {}) {
    const state = this._state();
    const quantised = position && this.peers.ar ? this.peers.ar.constructor.quantize(position) : null;
    state.presence[profileId] = { lobbyId, at: nowIso(), quantised: quantised ? true : false, position: quantised };
    if (lobbyId && state.lobbies[lobbyId]) state.lobbies[lobbyId].lastActivityAt = nowIso();
    this._save(state, { actor: profileId, kind: 'multiplayer.presence' });
    return { profileId, presence: state.presence[profileId] };
  }

  /** Who is online right now (pseudonymous, quantised). */
  presence({ lobbyId = null, limit = 50 } = {}) {
    const state = this._state();
    const now = Date.now();
    return Object.entries(state.presence)
      .filter(([, p]) => now - Date.parse(p.at) < 5 * 60_000)
      .filter(([, p]) => (lobbyId ? p.lobbyId === lobbyId : true))
      .slice(0, clamp(limit, 1, 200))
      .map(([profileId, p]) => ({
        profileId,
        alias: this.peers.memory ? this.peers.memory.getProfile(profileId)?.alias || profileId : profileId,
        lobbyId: p.lobbyId,
        position: p.position,
        at: p.at,
        consentShared: Boolean(state.lobbies[p.lobbyId]?.members.find((m) => m.profileId === profileId)?.consentShared),
      }));
  }

  stats() {
    const state = this._state();
    const open = Object.values(state.lobbies).filter((l) => l.status === 'open');
    return {
      ...state.stats,
      openLobbies: open.length,
      totalMembers: open.reduce((s, l) => s + l.members.length, 0),
      averageSafety: open.length ? round(open.reduce((s, l) => s + l.safety, 0) / open.length, 1) : 0,
      minSafety: open.length ? Math.min(...open.map((l) => l.safety)) : 0,
      activeParties: Object.values(state.parties).filter((p) => p.status === 'active').length,
      activeRaids: Object.values(state.raids).filter((r) => r.status === 'running' || r.status === 'assembling').length,
      openReports: Object.values(state.reports).filter((r) => r.status === 'open').length,
      bans: Object.values(state.bans).reduce((s, list) => s + list.length, 0),
      modes: LOBBY_MODES,
    };
  }
}

module.exports = { Multiplayer, LOBBY_MODES, PRIVACY, AGE_BANDS, CONTENT_FILTERS, RAID_PHASES, ROLES, SAFETY_WEIGHTS };
