'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY SDK  —  the integration client for custom integrations
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Zero dependencies. Works in Node 18+ (global fetch) and in the browser.
 *
 *  What it gives an integrator:
 *
 *   • one place for the key auth token (auto-refresh before expiry)
 *   • typed-ish namespaces mirroring the API groups:
 *       entropy.system / .auth / .pending / .memory / .weave / .ar / .squad
 *       entropy.missions / .multiplayer / .miners / .chromium
 *   • automatic handling of the pending envelope: a 202 "parked seal" is
 *     surfaced through `onPending` (and optionally auto-co-signed/unmasked),
 *     so your code never has to special-case smart-value gating
 *   • SSE subscription helper with reconnect + exponential backoff
 *   • every response keeps `meta.entropyAddress` on `result.__meta` so you can
 *     log which content handler produced what
 *
 *  Quick start:
 *
 *      const { EntropyClient } = require('./entropy/src/sdk/client.js');
 *      const entropy = new EntropyClient({ baseUrl: 'http://localhost:8080', token });
 *      await entropy.memory.ensureProfile({ subject: 'player-42' });
 *      const mined = await entropy.miners.mine({ seconds: 3, blocks: 2 });
 *
 *  ESM users: `import pkg from './client.js'; const { EntropyClient } = pkg;`
 *  (or use client.mjs, which re-exports it).
 */

const DEFAULT_BASE_URL = 'http://localhost:8080';

class EntropyApiError extends Error {
  constructor(message, { code = null, detail = null, status = 0, meta = null } = {}) {
    super(message);
    this.name = 'EntropyApiError';
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.meta = meta;
  }
}

class EntropyClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]
   * @param {string} [options.token]                entk.v1.…
   * @param {string} [options.subject]              used for auto token issuance in dev
   * @param {string} [options.tier]
   * @param {string[]} [options.scopes]
   * @param {(seal:object)=>void} [options.onPending]      called on every parked seal
   * @param {boolean} [options.autoUnmask]                 try to unmask parked seals immediately
   * @param {string} [options.pendingMode]  'auto'|'force'|'never' → x-entropy-pending header
   * @param {number} [options.timeoutMs]
   * @param {number} [options.autoRefreshSec]               refresh token this long before expiry
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process?.env?.ENTROPY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token || process?.env?.ENTROPY_TOKEN || null;
    this.subject = options.subject || null;
    this.tier = options.tier || 'operator';
    this.scopes = options.scopes || null;
    this.onPending = options.onPending || null;
    this.autoUnmask = Boolean(options.autoUnmask);
    this.pendingMode = options.pendingMode || 'auto';
    this.timeoutMs = Number(options.timeoutMs) || 120_000;
    this.autoRefreshSec = Number(options.autoRefreshSec) || 300;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.claims = null;
    this.expiresAt = 0;
    this.lastMeta = null;
    this.stats = { calls: 0, pending: 0, errors: 0, unmasked: 0 };
    if (!this.fetchImpl) throw new Error('EntropyClient needs fetch (Node 18+ or a fetchImpl)');

    /* namespaced surfaces */
    this.system = {
      index: () => this.get('/v1'),
      health: () => this.get('/v1/health'),
      status: () => this.get('/v1/status'),
      journal: (limit = 50) => this.get(`/v1/journal?limit=${limit}`),
      handlers: (group = null) => this.get(`/v1/handlers${group ? `?group=${encodeURIComponent(group)}` : ''}`),
      handler: (id) => this.get(`/v1/handlers/${encodeURIComponent(id)}`),
      openapi: () => this.get('/v1/openapi.json'),
      resolveAddress: (address) => this.get(`/v1/addresses/${encodeURIComponent(address)}`),
    };

    this.auth = {
      issue: (body = {}) => this.post('/v1/auth/token', { subject: this.subject, tier: this.tier, scopes: this.scopes, ...body }),
      verify: (token = this.token, opScopes = []) => this.post('/v1/auth/verify', { token, opScopes }),
      me: () => this.get('/v1/auth/me'),
      refresh: (body = {}) => this.post('/v1/auth/refresh', body),
      catalog: () => this.get('/v1/auth/catalog'),
    };

    this.pending = {
      list: (params = {}) => this.get(`/v1/pending?${qs(params)}`),
      get: (sealId) => this.get(`/v1/pending/${encodeURIComponent(sealId)}`),
      cosign: (sealId, note = null) => this.post(`/v1/pending/${encodeURIComponent(sealId)}/cosign`, { note }),
      unmask: (sealId, note = null) => this.post(`/v1/pending/${encodeURIComponent(sealId)}/unmask`, { note }),
      void: (sealId, reason = null) => this.post(`/v1/pending/${encodeURIComponent(sealId)}/void`, { reason }),
      stats: () => this.get('/v1/pending/stats'),
    };

    this.memory = {
      ensureProfile: ({ subject, alias = null }) => this.post('/v1/memory/profiles', { subject, alias }),
      listProfiles: (params = {}) => this.get(`/v1/memory/profiles?${qs(params)}`),
      profile: (id) => this.get(`/v1/memory/${enc(id)}`),
      skills: (id) => this.get(`/v1/memory/${enc(id)}/skills`),
      useSkill: (id, skillId, outcome = 'use') => this.post(`/v1/memory/${enc(id)}/skills/${enc(skillId)}/use`, { outcome }),
      remember: (id, trace) => this.post(`/v1/memory/${enc(id)}/remember`, trace),
      recall: (id, query = {}) => this.post(`/v1/memory/${enc(id)}/recall`, query),
      forget: (id, traceId, reason = null) => this.post(`/v1/memory/${enc(id)}/forget/${enc(traceId)}`, { reason }),
      consolidate: (id) => this.post(`/v1/memory/${enc(id)}/consolidate`, {}),
      graph: (id, limit = 40) => this.get(`/v1/memory/${enc(id)}/graph?limit=${limit}`),
      saveLoadout: (id, loadout) => this.post(`/v1/memory/${enc(id)}/loadouts`, loadout),
      loadouts: (id) => this.get(`/v1/memory/${enc(id)}/loadouts`),
      equipLoadout: (id, loadoutId) => this.post(`/v1/memory/${enc(id)}/loadouts/${enc(loadoutId)}/equip`, {}),
      recordMatch: (id, match) => this.post(`/v1/memory/${enc(id)}/matches`, match),
      companionBehaviors: (id) => this.get(`/v1/memory/${enc(id)}/companions`),
      exportProfile: (id, traces = true) => this.get(`/v1/memory/${enc(id)}/export?traces=${traces}`),
      importProfile: (bundle) => this.post('/v1/memory/import', bundle),
      stats: () => this.get('/v1/memory/stats'),
    };

    this.weave = {
      catalog: (params = {}) => this.get(`/v1/weave/catalog?${qs(params)}`),
      schools: () => this.get('/v1/weave/schools'),
      ability: (id) => this.get(`/v1/weave/abilities/${enc(id)}`),
      unlock: (profileId, abilityId, payWith = 'rlu') => this.post('/v1/weave/unlock', { profileId, abilityId, payWith }),
      analyze: (profileId, abilityIds) => this.post('/v1/weave/analyze', { profileId, abilityIds }),
      fuse: (profileId, abilityIds) => this.post('/v1/weave/fuse', { profileId, abilityIds }),
      useFusion: (fusionId, profileId, outcome = 'use') => this.post(`/v1/weave/fusions/${enc(fusionId)}/use`, { profileId, outcome }),
      unweave: (fusionId, profileId) => this.post(`/v1/weave/fusions/${enc(fusionId)}/unweave`, { profileId }),
      holdings: (profileId) => this.get(`/v1/weave/holdings/${enc(profileId)}`),
      recipes: (params = {}) => this.get(`/v1/weave/recipes?${qs(params)}`),
      leaderboard: (params = {}) => this.get(`/v1/weave/leaderboard?${qs(params)}`),
      stats: () => this.get('/v1/weave/stats'),
    };

    this.ar = {
      layers: () => this.get('/v1/ar/layers'),
      scan: (body = {}) => this.post('/v1/ar/scan', body),
      history: (profileId, limit = 20) => this.get(`/v1/ar/history/${enc(profileId)}?limit=${limit}`),
      tile: (z, x, y) => this.get(`/v1/ar/map/${z}/${x}/${y}`),
      overlayUrl: ({ mode = 'sweep', layers = null, w = 960, h = 540, title = 'ENTROPY SCAN' } = {}) =>
        `${this.baseUrl}/v1/ar/overlay.svg?mode=${encodeURIComponent(mode)}${layers ? `&layers=${encodeURIComponent(layers.join(','))}` : ''}&w=${w}&h=${h}&title=${encodeURIComponent(title)}`,
      overlaySvg: async (opts = {}) => (await this.raw('GET', this.ar.overlayUrl(opts).replace(this.baseUrl, ''))).text,
      anchors: (params = {}) => this.get(`/v1/ar/anchors?${qs(params)}`),
      createAnchor: (anchor) => this.post('/v1/ar/anchors', anchor),
      removeAnchor: (anchorId) => this.request('DELETE', `/v1/ar/anchors/${enc(anchorId)}`),
      stats: () => this.get('/v1/ar/stats'),
    };

    this.squad = {
      roster: () => this.get('/v1/squad/roster'),
      tactics: () => this.get('/v1/squad/tactics'),
      recruit: (profileId, companionId) => this.post(`/v1/squad/${enc(profileId)}/recruit`, { companionId }),
      companions: (profileId) => this.get(`/v1/squad/${enc(profileId)}/companions`),
      model: (profileId, companionId) => this.get(`/v1/squad/${enc(profileId)}/companions/${enc(companionId)}`),
      drill: (profileId, companionId, tactic, intensity = 1) => this.post(`/v1/squad/${enc(profileId)}/companions/${enc(companionId)}/drill`, { tactic, intensity }),
      learn: (profileId, body) => this.post(`/v1/squad/${enc(profileId)}/learn`, body),
      recommend: (profileId, mode = 'skirmish', size = 3) => this.get(`/v1/squad/${enc(profileId)}/recommend?mode=${mode}&size=${size}`),
      briefing: (profileId) => this.get(`/v1/squad/${enc(profileId)}/briefing`),
      banter: (profileId, { companionId = null, context = 'lobby', turns = 4 } = {}) =>
        this.get(`/v1/squad/${enc(profileId)}/banter?context=${context}&turns=${turns}${companionId ? `&companionId=${enc(companionId)}` : ''}`),
      dismiss: (profileId, companionId) => this.post(`/v1/squad/${enc(profileId)}/companions/${enc(companionId)}/dismiss`, {}),
      stats: () => this.get('/v1/squad/stats'),
    };

    this.missions = {
      board: (profileId) => this.get(`/v1/missions/board/${enc(profileId)}`),
      generate: (cadence, params = {}) => this.get(`/v1/missions/cadence/${enc(cadence)}?${qs(params)}`),
      accept: (missionId, profileId) => this.post(`/v1/missions/${enc(missionId)}/accept`, { profileId }),
      complete: (missionId, profileId) => this.post(`/v1/missions/${enc(missionId)}/complete`, { profileId }),
      observe: (event, { profileId, amount = 1, meta = {} } = {}) => this.post('/v1/missions/observe', { profileId, event, amount, meta }),
      worldEvents: () => this.get('/v1/missions/events'),
      triggerEvent: (kind, { durationHours = 4, intensity = 0.8, reason = null } = {}) => this.post('/v1/missions/events', { kind, durationHours, intensity, reason }),
      season: () => this.get('/v1/missions/season'),
      seasonProgress: (profileId, claim = false) => this.get(`/v1/missions/season/${enc(profileId)}${claim ? '?claim=true' : ''}`),
      leaderboard: (params = {}) => this.get(`/v1/missions/leaderboard?${qs(params)}`),
      stats: () => this.get('/v1/missions/stats'),
    };

    this.multiplayer = {
      safetyModel: () => this.get('/v1/multiplayer/safety'),
      createLobby: (body = {}) => this.post('/v1/multiplayer/lobbies', body),
      lobbies: (params = {}) => this.get(`/v1/multiplayer/lobbies?${qs(params)}`),
      find: (params = {}) => this.get(`/v1/multiplayer/find?${qs(params)}`),
      lobby: (lobbyId) => this.get(`/v1/multiplayer/lobbies/${enc(lobbyId)}`),
      join: (lobbyId, body = {}) => this.post(`/v1/multiplayer/lobbies/${enc(lobbyId)}/join`, body),
      leave: (lobbyId, body = {}) => this.post(`/v1/multiplayer/lobbies/${enc(lobbyId)}/leave`, body),
      invite: (lobbyId, targetProfileId) => this.post(`/v1/multiplayer/lobbies/${enc(lobbyId)}/invite`, { targetProfileId }),
      moderate: (lobbyId, body) => this.post(`/v1/multiplayer/lobbies/${enc(lobbyId)}/moderate`, body),
      consent: (lobbyId, consentShared, profileId) => this.post(`/v1/multiplayer/lobbies/${enc(lobbyId)}/consent`, { consentShared, profileId }),
      report: (body) => this.post('/v1/multiplayer/report', body),
      safeExit: (body = {}) => this.post('/v1/multiplayer/safe-exit', body),
      createParty: (body = {}) => this.post('/v1/multiplayer/parties', body),
      joinParty: (partyId, profileId) => this.post(`/v1/multiplayer/parties/${enc(partyId)}/join`, { profileId }),
      party: (profileId) => this.get(`/v1/multiplayer/parties/${enc(profileId)}`),
      createRaid: (lobbyId, body = {}) => this.post('/v1/multiplayer/raids', { lobbyId, ...body }),
      raids: (params = {}) => this.get(`/v1/multiplayer/raids?${qs(params)}`),
      raid: (raidId) => this.get(`/v1/multiplayer/raids/${enc(raidId)}`),
      ready: (raidId, profileId) => this.post(`/v1/multiplayer/raids/${enc(raidId)}/ready`, { profileId }),
      tick: (raidId) => this.post(`/v1/multiplayer/raids/${enc(raidId)}/tick`, {}),
      heartbeat: (body = {}) => this.post('/v1/multiplayer/presence', body),
      presence: (params = {}) => this.get(`/v1/multiplayer/presence?${qs(params)}`),
      stats: () => this.get('/v1/multiplayer/stats'),
    };

    this.miners = {
      consensus: () => this.get('/v1/miners/consensus'),
      chain: (params = {}) => this.get(`/v1/miners/chain?${qs(params)}`),
      block: (heightOrHash) => this.get(`/v1/miners/blocks/${enc(heightOrHash)}`),
      verify: (sampleReality = 8) => this.post('/v1/miners/verify', { sampleReality }),
      pool: (params = {}) => this.get(`/v1/miners/pool?${qs(params)}`),
      registerWorker: (body = {}) => this.post('/v1/miners/workers', body),
      work: (params = {}) => this.get(`/v1/miners/work?${qs(params)}`),
      submit: (body) => this.post('/v1/miners/submit', body),
      mine: (body = {}) => this.post('/v1/miners/mine', body),
      wallet: (profileId, ledgerLimit = 25) => this.get(`/v1/miners/wallet/${enc(profileId)}?ledgerLimit=${ledgerLimit}`),
      reality: (params = {}) => this.get(`/v1/miners/reality?${qs(params)}`),
      fragment: (address) => this.get(`/v1/miners/fragments/${enc(address)}`),
      deriveFragment: (body = {}) => this.post('/v1/miners/fragments/derive', body),
      stats: () => this.get('/v1/miners/stats'),
    };

    this.chromium = {
      alloy: (params = {}) => this.get(`/v1/chromium/alloy?${qs(params)}`),
      cssUrl: (params = {}) => `${this.baseUrl}/v1/chromium/css?${qs(params)}`,
      css: async (params = {}) => (await this.raw('GET', `/v1/chromium/css?${qs(params)}`)).text,
      plate: (payload, kind = 'payload') => this.post('/v1/chromium/plate', { payload, kind }),
      verifyPlate: (plateString, payload, kind = 'payload') => this.post('/v1/chromium/verify-plate', { plate: plateString, payload, kind }),
      deriveAddress: (domain, label, sublabel = '') => this.post('/v1/chromium/derive-address', { domain, label, sublabel }),
    };
  }

  /* ── transport ─────────────────────────────────────────────────────── */

  async raw(method, path, body = null, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { accept: 'application/json', ...extraHeaders };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== null && body !== undefined) headers['content-type'] = 'application/json';
    if (this.pendingMode && this.pendingMode !== 'auto') headers['x-entropy-pending'] = this.pendingMode;
    try {
      this.stats.calls += 1;
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, path, body = null) {
    await this.maybeRefreshToken();
    const res = await this.raw(method, path, body);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new EntropyApiError(`non-JSON response from ${method} ${path}`, { status: res.status });
    }
    this.lastMeta = json?.meta || null;
    if (!res.ok || json?.ok === false) {
      this.stats.errors += 1;
      const err = json?.error || { code: `http_${res.status}`, message: res.statusText };
      throw new EntropyApiError(err.message, { code: err.code, detail: err.detail, status: res.status, meta: json?.meta });
    }
    const data = json.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      try {
        Object.defineProperty(data, '__meta', { value: json.meta, enumerable: false });
      } catch {
        /* frozen payload */
      }
    }
    if (data?.status === 'pending') await this.handlePending(data);
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body = {}) { return this.request('POST', path, body); }
  patch(path, body = {}) { return this.request('PATCH', path, body); }
  delete(path) { return this.request('DELETE', path); }

  /** Parked seal handling: notify, and optionally unmask straight away. */
  async handlePending(seal) {
    this.stats.pending += 1;
    if (this.onPending) {
      try {
        this.onPending(seal);
      } catch {
        /* listener errors must not break the call */
      }
    }
    if (this.autoUnmask) {
      try {
        await this.pending.cosign(seal.sealId, 'sdk auto co-sign');
        const unmasked = await this.pending.unmask(seal.sealId, 'sdk auto unmask');
        this.stats.unmasked += 1;
        return unmasked;
      } catch (err) {
        if (this.onPendingError) this.onPendingError(err, seal);
        return seal;
      }
    }
    return seal;
  }

  /** Refresh the token before it expires (keeps smart value at full freshness). */
  async maybeRefreshToken() {
    if (!this.token || !this.expiresAt) return;
    if (Date.now() < this.expiresAt - this.autoRefreshSec * 1000) return;
    try {
      const refreshed = await this.post('/v1/auth/refresh', {});
      if (refreshed?.status !== 'pending' && refreshed?.token) {
        this.token = refreshed.token;
        this.claims = refreshed.claims;
        this.expiresAt = Date.parse(refreshed.expiresAt);
      }
    } catch {
      /* keep going with the current token; the server will 401 if it is dead */
    }
  }

  /** Decode the local token claims without a round trip. */
  decodeToken(token = this.token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    try {
      const b64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      this.claims = claims;
      this.expiresAt = Number(claims.exp) || 0;
      return claims;
    } catch {
      return null;
    }
  }

  /** Issue + adopt a token in one call (dev networks with open issuance). */
  async login({ subject = this.subject, tier = this.tier, scopes = this.scopes, ttlSeconds = 3600 } = {}) {
    const issued = await this.post('/v1/auth/token', { subject, tier, scopes, ttlSeconds });
    this.token = issued.token;
    this.subject = issued.claims.sub;
    this.claims = issued.claims;
    this.expiresAt = Date.parse(issued.expiresAt);
    return issued;
  }

  /**
   * Subscribe to the SSE stream.
   * @param {(event:{type:string,payload:object,at:string})=>void} onEvent
   * @param {object} [opts] {types: string[]|null, EventSource: ctor}
   * @returns {{close:()=>void}}
   */
  stream(onEvent, { types = null, EventSource: ES = null } = {}) {
    const Ctor = ES || globalThis.EventSource;
    if (!Ctor) throw new Error('EventSource is unavailable in this runtime (pass { EventSource } explicitly)');
    let es = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      es = new Ctor(`${this.baseUrl}/v1/stream`);
      const wanted = types || ['miners.block', 'miners.retarget', 'weave.fused', 'pending.parked', 'pending.unmasked', 'memory.match', 'missions.completed', 'multiplayer.raid.resolved', 'squad.quirk', 'ar.scan'];
      for (const type of wanted) {
        es.addEventListener(type, (e) => {
          try {
            const parsed = JSON.parse(e.data);
            onEvent({ type, payload: parsed.payload || {}, at: parsed.at });
          } catch {
            /* ignore malformed frames */
          }
        });
      }
      es.onopen = () => {
        attempt = 0;
      };
      es.onerror = () => {
        es.close();
        if (closed) return;
        attempt += 1;
        setTimeout(connect, Math.min(30_000, 500 * 2 ** attempt)); // exponential backoff
      };
    };
    connect();
    return {
      close() {
        closed = true;
        es?.close();
      },
    };
  }

  /** One-shot convenience: the whole "new player" flow. */
  async bootstrapPlayer(subject, { alias = null, recruitCompanions = 1 } = {}) {
    const profile = await this.memory.ensureProfile({ subject, alias });
    const pid = profile.profile?.profileId || subject;
    const roster = await this.squad.roster();
    const recruited = [];
    for (const companion of roster.companions.slice(0, recruitCompanions)) {
      const res = await this.squad.recruit(pid, companion.companionId).catch((e) => ({ error: e.message }));
      recruited.push(res);
    }
    const board = await this.missions.board(pid);
    for (const mission of [...board.daily, ...board.weekly].slice(0, 3)) {
      await this.missions.accept(mission.missionId, pid).catch(() => null);
    }
    return { profileId: pid, address: profile.address, recruited, missions: board.daily.length + board.weekly.length };
  }
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

module.exports = { EntropyClient, EntropyApiError, qs, enc };
