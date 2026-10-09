'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY API ROUTES  —  every content handler, wired to a system
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Conventions used by every route below (this is the integration contract):
 *
 *  • Envelope      { ok:true, data, meta:{ handler, entropyAddress, sealed,
 *                  smartValue, tookMs, requestId } }
 *  • Errors        { ok:false, error:{ code, message, detail }, meta }
 *  • Pending       HTTP 202 + { ok:true, data:{ status:'pending', sealId,
 *                  sealAddress, requiredSmartValue, offeredSmartValue,
 *                  nextSteps[] } }  ← produced automatically by ctx.gate()
 *                  whenever the caller's live smart value is below the
 *                  operation's requirement.
 *  • Risk          each mutating route declares risk NONE…GENESIS which maps to
 *                  a requiredSmartValue (see core/keyring.js RISK ladder).
 *  • Scopes        each route declares the scopes it needs; missing scopes are
 *                  a 403, never a silent no-op.
 *  • Addresses     every handler has EX-HND-…, every record has its own domain
 *                  address (EX-MEM, EX-WEA, EX-ARX, EX-SQD, EX-MSN, EX-LBY,
 *                  EX-MIN, EX-BLK, EX-RLT, EX-PND, EX-CHR).
 *
 *  Read the file top-to-bottom and you have the whole product surface: system,
 *  keyring, unmask pool, memory, weave, AR, squad, missions, multiplayer,
 *  miners, chromium.
 */

const { Router, toBadRequest, toNotFound, toForbidden, toConflict } = require('../core/http');
const { deriveAddress, hashHex, nowIso, clamp, round, entropyPhrase, parseAddress, isAddress, PROTOCOL_VERSION } = require('../core/entropy-core');
const { SCOPES, TIERS, RISK, ALL_SCOPES } = require('../core/keyring');
const { SURFACES, GRADES } = require('../core/chromium');
const { LOBBY_MODES, CONTENT_FILTERS, AGE_BANDS, RAID_PHASES } = require('../systems/multiplayer');
const { TACTICS, ROLES: SQUAD_ROLES, LEARNING } = require('../systems/squad');
const { OBJECTIVE_EVENTS, SEASON_TIERS, WORLD_EVENT_KINDS } = require('../systems/missions');
const { LAYERS, SCAN_MODES } = require('../systems/ar');
const { CONSENSUS } = require('../systems/miners');
const { BASE_SKILLS, LOADOUT_SLOTS } = require('../systems/memory');
const { SCHOOLS, OUTCOMES } = require('../systems/weave');
const { buildUnmaskDispatch } = require('./handlers');

/**
 * @param {object} deps
 * @param {import('../core/vault').Vault} deps.vault
 * @param {import('../core/keyring').Keyring} deps.keyring
 * @param {import('../core/http').EventBus} deps.bus
 * @param {object} deps.systems   {memory, weave, ar, squad, missions, multiplayer, miners}
 * @param {object} deps.config    {seed, mode, baseUrl, alloy, allowOpenTokenIssue}
 */
function buildRouter(deps) {
  const { vault, keyring, bus, systems, config } = deps;
  const { memory, weave, ar, squad, missions, multiplayer, miners } = systems;
  const router = new Router();
  const seed = config.seed;
  /** seal.kind → applier, so one generic unmask route serves every gated write. */
  const unmaskDispatch = buildUnmaskDispatch(systems);

  /* ── helpers ─────────────────────────────────────────────────────────── */

  /** Turn a parked seal into the standard pending payload. */
  const pending = (seal, extra = {}) => ({
    status: 'pending',
    sealId: seal.sealId,
    sealAddress: seal.address,
    kind: seal.kind,
    requiredSmartValue: seal.requiredSmartValue,
    offeredSmartValue: seal.offeredSmartValue,
    aggregateSmartValue: seal.aggregateSmartValue || seal.offeredSmartValue,
    coSignRequired: seal.coSignRequired,
    coSignatures: seal.coSignatures,
    createdAt: seal.createdAt,
    expiresAt: seal.expiresAt,
    nextSteps: [
      `POST /v1/pending/${seal.sealId}/cosign — add authority (needs ${seal.coSignRequired} signature(s) and ${seal.requiredSmartValue} aggregate smart value)`,
      `POST /v1/pending/${seal.sealId}/unmask — resolve with a token whose smart value ≥ ${seal.requiredSmartValue} and scope unmask:seal`,
      `POST /v1/auth/token { subject, tier:"architect"|"sovereign" } — re-issue a stronger key auth token`,
      `POST /v1/pending/${seal.sealId}/void — cancel the parked effect`,
    ],
    ...extra,
  });

  /** Run a gated mutation: apply now, or park it. */
  const gated = async (ctx, opts) => {
    const result = await ctx.gate(opts);
    if (result.sealed) return result.data;
    return pending(result.seal, opts.pendingExtra || {});
  };

  /** Resolve `:profileId` (accepts profileId, subject or a memory address). */
  const resolveProfile = (value, { create = false } = {}) => {
    if (!value) throw toBadRequest('profileId is required');
    if (isAddress(value)) {
      const parsed = parseAddress(value);
      const found = memory.listProfiles({ limit: 500 }).find((p) => p.address === value);
      if (found) return found.profileId;
      throw toNotFound(`no profile for address ${value}`, { domain: parsed.domain });
    }
    const profile = memory.getProfile(value);
    if (profile) return profile.profileId;
    if (create) return memory.ensureProfile(value).profileId;
    throw toNotFound(`unknown profile: ${value}`, { hint: 'POST /v1/memory/profiles { subject } to create it' });
  };

  /* ═════════════════════════ 1. SYSTEM & DISCOVERY ══════════════════════ */

  router.get('/v1', {
    handler: 'system.index',
    group: 'system',
    domain: 'system',
    title: 'Entropy API index',
    summary: 'Protocol card: version, genesis fingerprint, chromium alloy, handler groups and the live stats of every system.',
    auth: false,
  }, () => {
    const alloy = config.alloy();
    return {
      protocol: 'ENTROPY',
      version: PROTOCOL_VERSION,
      name: 'Genesis Unmask',
      mode: config.mode,
      baseUrl: config.baseUrl,
      genesis: {
        seedFingerprint: vault.genesis({ seed })?.seedFingerprint || null,
        network: config.network,
        entropyPhrase: entropyPhrase(seed, 6),
        createdAt: vault.genesis({ seed })?.createdAt || null,
      },
      chromium: {
        alloy: alloy.label,
        address: alloy.address,
        grade: alloy.grade.grade,
        surface: alloy.surface.id,
        cssUrl: '/ui/chromium.css',
        surfaces: Object.keys(SURFACES),
        grades: GRADES.map((g) => g.grade),
        contrast: alloy.contrast,
      },
      systems: {
        memory: memory.stats(),
        weave: weave.stats(),
        ar: ar.stats(),
        squad: squad.stats(),
        missions: missions.stats(),
        multiplayer: multiplayer.stats(),
        miners: miners.stats(),
        pending: keyring.stats(),
      },
      auth: {
        tokenFormat: 'entk.v1.<base64url(claims)>.<base64url(hmac)>',
        scopes: Object.keys(SCOPES),
        tiers: TIERS.map((t) => ({ id: t.id, label: t.label, multiplier: t.smartMultiplier })),
        riskLadder: Object.fromEntries(Object.entries(RISK).map(([k, v]) => [k, { level: v.level, requiredSmartValue: v.required, label: v.label }])),
        openTokenIssue: config.allowOpenTokenIssue,
      },
      links: {
        handlers: '/v1/handlers',
        openapi: '/v1/openapi.json',
        health: '/v1/health',
        status: '/v1/status',
        stream: '/v1/stream (server-sent events)',
        ui: '/ui/',
        docs: '/entropy/README.md',
      },
      contentAddressing: {
        domains: Object.keys(require('../core/entropy-core').DOMAINS),
        note: 'Every record, handler and fragment carries a checksummed EX-<DOMAIN>-… address plus an EVM form for contract binding.',
      },
      unit: { symbol: 'RLU', name: 'Reality Unit', monetary: false, note: 'Mining produces world content, not currency.' },
    };
  });

  router.get('/v1/health', {
    handler: 'system.health',
    group: 'system',
    domain: 'system',
    title: 'Health',
    summary: 'Liveness + chain/pool/pending vitals in one cheap call.',
    auth: false,
  }, () => ({
    status: 'ok',
    uptimeSec: round(process.uptime(), 1),
    at: nowIso(),
    vault: vault.inspect(),
    chain: { height: miners.stats().height, tip: miners.stats().tip, difficultyBits: miners.stats().difficultyBits, valid: true },
    pending: keyring.stats(),
    bus: { subscribers: bus.snapshot().subscribers, events: bus.snapshot().counters },
    memoryMb: round(process.memoryUsage().rss / 1048576, 1),
  }));

  router.get('/v1/status', {
    handler: 'system.status',
    group: 'system',
    domain: 'system',
    title: 'Network status',
    summary: 'Aggregate counters for the HUD status strip.',
    scopes: ['entropy:read'],
  }, (ctx) => ({
    at: nowIso(),
    subject: ctx.subject,
    smartValue: ctx.smartValue,
    alloy: config.alloy().label,
    systems: {
      memory: memory.stats(),
      weave: weave.stats(),
      ar: ar.stats(),
      squad: squad.stats(),
      missions: missions.stats(),
      multiplayer: multiplayer.stats(),
      miners: miners.stats(),
    },
    pending: keyring.stats(),
    liveWorldEvents: missions.liveWorldEvents(),
    season: missions.currentSeason(),
  }));

  router.get('/v1/journal', {
    handler: 'system.journal',
    group: 'system',
    domain: 'system',
    title: 'Audit journal tail',
    summary: 'Append-only vault journal — who mutated what, when, and why.',
    scopes: ['entropy:read'],
    query: [{ name: 'limit', type: 'integer', note: 'max events (default 50)' }],
  }, (ctx) => ({ events: vault.tail(clamp(Number(ctx.query.limit) || 50, 1, 500)), path: vault.journalPath }));

  router.get('/v1/handlers', {
    handler: 'system.handlers',
    group: 'system',
    domain: 'system',
    title: 'Content handler registry',
    summary: 'Every handler with its entropy-generated address (EX-HND-…), EVM form, risk, scopes and pending capability.',
    auth: false,
    query: [{ name: 'group', type: 'string', note: 'filter by group: memory|weave|ar|squad|missions|multiplayer|miners|chromium|auth|pending|system' }],
  }, (ctx) => {
    const registry = config.registry ? config.registry() : { count: 0, groups: [], handlers: [] };
    if (!ctx.query.group) return registry;
    return { ...registry, groups: registry.groups.filter((g) => g.group === ctx.query.group), handlers: registry.handlers.filter((h) => h.group === ctx.query.group) };
  });

  router.get('/v1/handlers/:handlerId', {
    handler: 'system.handler.get',
    group: 'system',
    domain: 'system',
    title: 'Handler detail',
    summary: 'One content handler: address, method, path, risk, required smart value, scopes.',
    auth: false,
  }, (ctx) => {
    const registry = config.registry ? config.registry() : { handlers: [] };
    const found = registry.handlers.find((h) => h.handler === ctx.params.handlerId);
    if (!found) throw toNotFound(`unknown handler: ${ctx.params.handlerId}`, { hint: 'GET /v1/handlers for the full registry' });
    return found;
  });

  router.get('/v1/openapi.json', {
    handler: 'system.openapi',
    group: 'system',
    domain: 'system',
    title: 'OpenAPI document',
    summary: 'Generated from the live route table — includes x-entropy-address on every operation.',
    auth: false,
  }, () => (config.openapi ? config.openapi() : { openapi: '3.1.0', info: { title: 'Entropy API', version: PROTOCOL_VERSION }, paths: {} }));

  router.get('/v1/addresses/:address', {
    handler: 'system.address.lookup',
    group: 'system',
    domain: 'system',
    title: 'Resolve an entropy address',
    summary: 'Reverse index for the whole platform: decode any EX-… address, verify its checksum, and return the record that owns it (profile, ability, fusion, companion, mission, world event, season, lobby, party, raid, report, block, fragment, wallet, worker, job, pool, scan, anchor, layer, handler, alloy, key or genesis).',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const parsed = parseAddress(ctx.params.address);
    if (!parsed) throw toBadRequest('not a valid entropy address', { got: ctx.params.address, format: 'EX-<DOMAIN>-<base58(payload20||checksum4)>' });

    const registry = config.registry ? config.registry() : { handlers: [] };
    const alloy = config.alloy();
    const genesisAddress = deriveAddress({ domain: 'GEN', seed, label: 'genesis' }).address;

    const LOOKUP = {
      MEM: () => {
        const profile = memory.listProfiles({ limit: 500 }).find((p) => p.address === parsed.address);
        return profile ? { type: 'profile', record: memory.summary(memory.getProfile(profile.profileId)) } : null;
      },
      WEA: () => weave.findByAddress(parsed.address),
      SQD: () => squad.findByAddress(parsed.address),
      MSN: () => missions.findByAddress(parsed.address),
      LBY: () => multiplayer.findByAddress(parsed.address),
      BLK: () => miners.findByAddress(parsed.address),
      RLT: () => miners.findByAddress(parsed.address),
      MIN: () => miners.findByAddress(parsed.address),
      ARX: () => ar.findByAddress(parsed.address),
      PND: () => {
        const seal = keyring.listPending({ limit: 500 }).find((s) => s.address === parsed.address);
        return seal ? { type: 'seal', record: seal } : null;
      },
      HND: () => {
        const handler = registry.handlers.find((h) => h.entropyAddress === parsed.address);
        return handler ? { type: 'handler', record: handler } : null;
      },
      CHR: () => (alloy.address === parsed.address ? { type: 'alloy', record: { id: alloy.id, label: alloy.label, address: alloy.address, grade: alloy.grade.grade, surface: alloy.surface.id, contrast: alloy.contrast } } : null),
      KEY: () => (keyring.subjectAddress.address === parsed.address ? { type: 'root-key', record: { address: keyring.subjectAddress.address, keyId: keyring.keyId, note: 'network root signing key' } } : null),
      GEN: () => (genesisAddress === parsed.address ? { type: 'genesis', record: { address: genesisAddress, seedFingerprint: vault.genesis({ seed }).seedFingerprint, network: config.network, entropyPhrase: entropyPhrase(seed, 4) } } : null),
    };

    const found = LOOKUP[parsed.domain] ? LOOKUP[parsed.domain]() : null;
    return {
      parsed,
      recordType: found?.type || null,
      record: found?.record || null,
      resolved: Boolean(found),
      domainLabel: parsed.domainLabel,
      hint: found ? null : `no ${parsed.domainLabel.toLowerCase()} record holds this address on this network (addresses are seed-derived: a different genesis seed yields different records)`,
    };
  });

  /* ═════════════════════ 2. KEYRING & AUTH TOKENS ═══════════════════════ */

  router.post('/v1/auth/token', {
    handler: 'auth.token.issue',
    group: 'auth',
    domain: 'auth',
    title: 'Issue a key auth token',
    summary: 'Mint an entk.v1 token carrying tier, scopes, entropyCredits and a decaying smart value. Open in dev mode; in prod it requires admin:root.',
    risk: null,
    // dev: open bootstrap (the banner says so). prod: admin:root or nothing.
    auth: config.mode === 'prod',
    scopes: config.mode === 'prod' ? ['admin:root'] : [],
    body: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'player / integration id' },
        tier: { type: 'string', enum: TIERS.map((t) => t.id) },
        scopes: { type: 'array', items: { type: 'string', enum: ALL_SCOPES } },
        ttlSeconds: { type: 'integer' },
        entropyCredits: { type: 'integer', description: 'standing; lifted automatically from the RLU wallet when omitted' },
        pendingBudget: { type: 'integer' },
        meta: { type: 'object' },
      },
      required: ['subject'],
    },
    example: { subject: 'commander', tier: 'operator', scopes: ['entropy:read', 'memory:write', 'weave:write', 'miner:work'], ttlSeconds: 3600 },
  }, (ctx) => {
    const subject = String(ctx.body.subject || '').trim();
    if (!subject) throw toBadRequest('subject is required');
    const tier = TIERS.some((t) => t.id === ctx.body.tier) ? ctx.body.tier : 'operator';
    const scopes = Array.isArray(ctx.body.scopes) && ctx.body.scopes.length ? ctx.body.scopes.filter((s) => SCOPES[s]) : ['entropy:read'];

    // Smart value is grounded in real standing: mined reality + wins.
    let credits = Number(ctx.body.entropyCredits);
    if (!Number.isFinite(credits)) {
      let walletRlu = 0;
      try {
        walletRlu = miners.walletView(subject, { ledgerLimit: 1 }).rlu;
      } catch {
        walletRlu = 0;
      }
      const profile = memory.getProfile(subject);
      credits = Math.round(walletRlu / 4 + (profile?.record?.wins || 0) * 6 + (profile?.record?.sealsUnmasked || 0) * 4);
    }
    const pendingBudget = Number.isFinite(Number(ctx.body.pendingBudget)) ? clamp(Number(ctx.body.pendingBudget), 0, 50) : { guest: 0, observer: 1, operator: 3, weaver: 5, architect: 8, sovereign: 16 }[tier];

    const issued = keyring.issueToken({
      subject,
      scopes,
      tier,
      ttlSeconds: clamp(Number(ctx.body.ttlSeconds) || 3600, 60, 60 * 60 * 24 * 7),
      entropyCredits: clamp(credits, 0, 100_000),
      pendingBudget,
      meta: ctx.body.meta || { issuedBy: ctx.subject, mode: config.mode },
      root: ctx.claims?.root && tier === 'sovereign' ? true : false,
    });
    bus.emit('auth.token.issued', { subject, tier, address: issued.address, smartValue: issued.smartValue });
    vault.journal({ kind: 'auth.token.issue', subject, tier, address: issued.address, smartValue: issued.smartValue, by: ctx.subject });
    return { ...issued, warning: config.allowOpenTokenIssue ? 'Open token issuance is enabled (dev). Set ENTROPY_MODE=prod to require admin:root.' : null };
  });

  router.post('/v1/auth/verify', {
    handler: 'auth.token.verify',
    group: 'auth',
    domain: 'auth',
    title: 'Verify a token',
    summary: 'Offline verification: signature, expiry, scopes, base vs live smart value and freshness decay.',
    scopes: ['entropy:read'],
    body: { type: 'object', properties: { token: { type: 'string' }, opScopes: { type: 'array', items: { type: 'string' } } } },
  }, (ctx) => {
    const token = String(ctx.body.token || ctx.query.token || '');
    const opScopes = Array.isArray(ctx.body.opScopes) ? ctx.body.opScopes.filter((s) => SCOPES[s]) : [];
    const result = keyring.verifyToken(token, opScopes);
    return {
      valid: result.valid,
      code: result.code || null,
      reason: result.reason || null,
      smartValue: result.smartValue ?? null,
      baseSmartValue: result.baseValue ?? null,
      fresh: result.fresh ?? null,
      expiresInMs: result.expiresInMs ?? null,
      claims: result.claims ? { ...result.claims, svLive: result.smartValue } : null,
      formula: 'base = 120·tierIndex·tierMultiplier + 45·matchedScopes + 8·pendingBudget + 3·entropyCredits + 250·root + 400·rootAdmin; live = floor(base·(0.55 + 0.45·freshness))',
    };
  });

  router.get('/v1/auth/me', {
    handler: 'auth.me',
    group: 'auth',
    domain: 'auth',
    title: 'Current authority',
    summary: 'Your claims, live smart value, wallet balance and what you can currently do without parking a seal.',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const claims = ctx.claims;
    const live = ctx.smartValue;
    const base = keyring.baseSmartValue(claims);
    const canAutoSeal = Object.fromEntries(Object.entries(RISK).map(([k, v]) => [k, { required: v.required, autoSeals: live >= v.required }]));
    let wallet = null;
    try {
      wallet = miners.walletView(claims.sub, { ledgerLimit: 5 });
    } catch {
      wallet = null;
    }
    return {
      subject: claims.sub,
      address: claims.addr,
      tier: claims.tier,
      tierLabel: TIERS.find((t) => t.id === claims.tier)?.label || claims.tier,
      scopes: claims.scopes,
      root: Boolean(claims.root),
      smartValue: { live, base, decay: round(1 - live / Math.max(1, base), 3) },
      issuedAt: new Date(claims.iat).toISOString(),
      expiresAt: new Date(claims.exp).toISOString(),
      expiresInMs: claims.exp - Date.now(),
      entropyCredits: claims.entropyCredits,
      pendingBudget: claims.pendingBudget,
      entropyPhrase: entropyPhrase(`${seed}|${claims.sub}|${claims.jti}`, 3),
      authority: canAutoSeal,
      wallet: wallet ? { rlu: wallet.rlu, lifetimeRlu: wallet.lifetimeRlu, address: wallet.address, blocksMined: wallet.blocksMined } : null,
      pendingSeals: keyring.listPending({ subject: claims.sub, status: 'pending', limit: 10 }),
    };
  });

  router.post('/v1/auth/refresh', {
    handler: 'auth.token.refresh',
    group: 'auth',
    domain: 'auth',
    title: 'Refresh a token',
    summary: 'Re-issue for the same subject with recomputed smart value (freshness resets, credits are re-read from the wallet).',
    scopes: ['entropy:read'],
    risk: 'LOW',
    body: { type: 'object', properties: { ttlSeconds: { type: 'integer' }, tier: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'auth.refresh',
      payload: { subject: ctx.claims.sub, tier: ctx.body.tier || ctx.claims.tier },
      apply: () => {
        const tier = TIERS.some((t) => t.id === ctx.body.tier) ? ctx.body.tier : ctx.claims.tier;
        let walletRlu = 0;
        try {
          walletRlu = miners.walletView(ctx.claims.sub, { ledgerLimit: 1 }).rlu;
        } catch {
          walletRlu = 0;
        }
        const profile = memory.getProfile(ctx.claims.sub);
        const credits = Math.round(walletRlu / 4 + (profile?.record?.wins || 0) * 6);
        const issued = keyring.issueToken({
          subject: ctx.claims.sub,
          scopes: ctx.claims.scopes,
          tier,
          ttlSeconds: clamp(Number(ctx.body.ttlSeconds) || 3600, 60, 60 * 60 * 24 * 7),
          entropyCredits: credits,
          pendingBudget: ctx.claims.pendingBudget,
          root: Boolean(ctx.claims.root),
          meta: { refreshedFrom: ctx.claims.jti },
        });
        return { ...issued, refreshedFrom: ctx.claims.jti };
      },
    }));

  router.get('/v1/auth/catalog', {
    handler: 'auth.catalog',
    group: 'auth',
    domain: 'auth',
    title: 'Scope, tier and risk catalogue',
    summary: 'Everything an integrator needs to reason about authority.',
    auth: false,
  }, () => ({
    scopes: Object.entries(SCOPES).map(([id, s]) => ({ id, ...s })),
    tiers: TIERS.map((t) => ({ ...t })),
    risk: Object.entries(RISK).map(([key, r]) => ({ key, ...r })),
    smartValueFormula: {
      base: '120·tierIndex·tierMultiplier + 45·matchedScopes + 8·pendingBudget + 3·entropyCredits + 250·adminRoot + 400·root',
      live: 'floor(base · (0.55 + 0.45 · clamp((exp − now)/ttl, 0, 1)))',
      notes: [
        'Freshness decay bounds the blast radius of a leaked token without a revocation round-trip.',
        'entropyCredits are recomputed from your RLU wallet and win record on every issue/refresh, so authority tracks real standing.',
        'A seal clears when aggregate co-signature smart value ≥ requiredSmartValue AND the signature threshold is met, or when a root unmask:seal token overrides.',
      ],
    },
    tokenFormat: 'entk.v1.<base64url(claims)>.<base64url(HMAC-SHA256)>',
  }));

  /* ════════════════════════ 3. UNMASK POOL (PENDING) ════════════════════ */

  router.get('/v1/pending', {
    handler: 'pending.list',
    group: 'pending',
    domain: 'pending',
    title: 'List pending seals',
    summary: 'Everything parked by smart-value gating: kind, required vs offered value, co-signatures and expiry.',
    scopes: ['entropy:read'],
    query: [
      { name: 'subject', type: 'string' },
      { name: 'status', type: 'string', note: 'pending|unmasked|expired|voided|failed' },
      { name: 'limit', type: 'integer' },
    ],
  }, (ctx) => ({
    pool: keyring.stats(),
    seals: keyring.listPending({ subject: ctx.query.subject || null, status: ctx.query.status || null, limit: clamp(Number(ctx.query.limit) || 50, 1, 500) }),
    yourSeals: keyring.listPending({ subject: ctx.subject, limit: 20 }),
    riskLadder: Object.entries(RISK).map(([k, v]) => ({ key: k, required: v.required })),
  }));

  router.get('/v1/pending/:sealId', {
    handler: 'pending.get',
    group: 'pending',
    domain: 'pending',
    title: 'Inspect a seal',
    summary: 'Full seal record including payload, co-signatures and the exact unmask requirement.',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const seal = keyring.getPending(ctx.params.sealId);
    if (!seal) throw toNotFound(`unknown seal: ${ctx.params.sealId}`);
    return { ...seal, canUnmask: ctx.smartValue >= seal.requiredSmartValue && (ctx.claims.scopes || []).includes('unmask:seal'), yourSmartValue: ctx.smartValue };
  });

  router.post('/v1/pending/:sealId/cosign', {
    handler: 'pending.cosign',
    group: 'pending',
    domain: 'pending',
    title: 'Co-sign a seal',
    summary: 'Add your smart value to a parked seal. Auto-unmasks when the signature threshold and aggregate value are both met.',
    scopes: ['entropy:read', 'unmask:seal'],
    risk: 'MEDIUM',
    body: { type: 'object', properties: { note: { type: 'string' } } },
  }, async (ctx) => {
    const result = keyring.coSign(ctx.params.sealId, ctx.claims, ctx.body.note || null);
    if (!result.ok) throw toConflict(`co-signature rejected: ${result.code}`, result.detail || null);
    if (result.ready) {
      // Threshold reached — apply through the generic unmask path.
      const applied = await applySeal(ctx, ctx.params.sealId);
      return { coSigned: true, autoUnmasked: true, ...applied };
    }
    return { coSigned: true, autoUnmasked: false, ...result };
  });

  router.post('/v1/pending/:sealId/unmask', {
    handler: 'pending.unmask',
    group: 'pending',
    domain: 'pending',
    title: 'Genesis unmask',
    summary: 'Resolve a parked seal and apply its effect. Requires unmask:seal plus sufficient live smart value (or a root override).',
    scopes: ['unmask:seal'],
    risk: 'HIGH',
    body: { type: 'object', properties: { note: { type: 'string' } } },
  }, async (ctx) => applySeal(ctx, ctx.params.sealId, ctx.body.note || null));

  router.post('/v1/pending/:sealId/void', {
    handler: 'pending.void',
    group: 'pending',
    domain: 'pending',
    title: 'Void a seal',
    summary: 'Cancel a parked effect. Allowed for the requester or any unmask authority.',
    scopes: ['entropy:read'],
    risk: 'LOW',
    body: { type: 'object', properties: { reason: { type: 'string' } } },
  }, (ctx) => {
    const seal = keyring.getPending(ctx.params.sealId);
    if (!seal) throw toNotFound(`unknown seal: ${ctx.params.sealId}`);
    const isRequester = seal.subject === ctx.subject;
    const isAuthority = ctx.smartValue >= seal.requiredSmartValue && (ctx.claims.scopes || []).includes('unmask:seal');
    if (!isRequester && !isAuthority) throw toForbidden('only the requester or an unmask authority may void a seal', { subject: seal.subject });
    const result = keyring.voidPending(ctx.params.sealId, ctx.claims, ctx.body.reason || 'voided by caller');
    if (!result.ok) throw toConflict(`void rejected: ${result.code}`, result.detail || null);
    return result;
  });

  router.get('/v1/pending/stats', {
    handler: 'pending.stats',
    group: 'pending',
    domain: 'pending',
    title: 'Unmask pool stats',
    summary: 'Pool depth, outstanding smart value and sweep counts.',
    auth: false,
  }, () => ({ ...keyring.stats(), swept: keyring.sweepExpired(), at: nowIso() }));

  /**
   * Generic seal application. Dispatch on seal.kind, then record the unmask in
   * memory + missions so progression reacts to authority being exercised.
   */
  async function applySeal(ctx, sealId, note = null) {
    const dispatch = unmaskDispatch;
    const seal = keyring.getPending(sealId);
    if (!seal) throw toNotFound(`unknown seal: ${sealId}`);
    const applier = dispatch[seal.kind];
    if (!applier) throw toBadRequest(`no unmask dispatcher for kind: ${seal.kind}`, { knownKinds: Object.keys(dispatch) });

    const outcome = keyring.unmask(sealId, ctx.claims, (s) => applier(s, ctx), { note });
    if (!outcome.ok) {
      if (outcome.code === 'unmask_insufficient') {
        throw toForbidden('insufficient authority to unmask', outcome.detail);
      }
      throw toConflict(`unmask failed: ${outcome.code}`, outcome.detail || null);
    }

    const profile = memory.getProfile(ctx.subject);
    if (profile) {
      profile.record.sealsUnmasked = (profile.record.sealsUnmasked || 0) + 1;
      missions.observe({ profileId: profile.profileId, event: 'unmask.seal', amount: 1, meta: { sealId } });
      memory.remember(profile.profileId, {
        kind: 'unmask',
        text: `Unmasked seal ${sealId} (${seal.kind})${note ? ` — ${note}` : ''}.`,
        tags: ['unmask', seal.kind],
        resonance: 1.5,
        decayDays: 120,
        source: 'pending',
        ref: { sealId, address: seal.sealAddress },
      }, { actor: ctx.subject });
    }
    return {
      status: 'unmasked',
      sealId,
      kind: seal.kind,
      sealAddress: seal.sealAddress || seal.address,
      unmaskedBy: ctx.subject,
      authority: ctx.smartValue,
      required: seal.requiredSmartValue,
      coSignatures: seal.coSignatures?.length || 0,
      result: outcome.result,
      note,
      at: nowIso(),
    };
  }

  /* ══════════════════════════ 4. ENTROPY MEMORY ═════════════════════════ */

  router.post('/v1/memory/profiles', {
    handler: 'memory.profile.create',
    group: 'memory',
    domain: 'memory',
    title: 'Create or fetch a memory profile',
    summary: 'Idempotent by subject: returns the existing profile if it already exists.',
    scopes: ['memory:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { subject: { type: 'string' }, alias: { type: 'string' } }, required: ['subject'] },
    example: { subject: 'commander', alias: 'Commander Bleu' },
  }, (ctx) => {
    const subject = String(ctx.body.subject || ctx.subject).trim();
    if (!subject) throw toBadRequest('subject is required');
    const profile = memory.ensureProfile(subject, { alias: ctx.body.alias || null });
    return { profile: memory.summary(profile), created: profile.createdAt === profile.updatedAt, address: profile.address, evmAddress: profile.evmAddress, signature: profile.memorySignature };
  });

  router.get('/v1/memory/profiles', {
    handler: 'memory.profile.list',
    group: 'memory',
    domain: 'memory',
    title: 'List profiles',
    summary: 'Sortable directory of memory profiles (recent, wins, rlu).',
    scopes: ['entropy:read'],
    query: [{ name: 'sort', type: 'string', note: 'recent|wins|rlu' }, { name: 'limit', type: 'integer' }],
  }, (ctx) => ({ count: memory.listProfiles({ limit: clamp(Number(ctx.query.limit) || 50, 1, 200), sort: ctx.query.sort || 'recent' }).length, profiles: memory.listProfiles({ limit: clamp(Number(ctx.query.limit) || 50, 1, 200), sort: ctx.query.sort || 'recent' }), stats: memory.stats() }));

  router.get('/v1/memory/:profileId', {
    handler: 'memory.profile.get',
    group: 'memory',
    domain: 'memory',
    title: 'Profile summary',
    summary: 'Skills, loadouts, wins and companion behaviours in one compact view.',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId);
    const profile = memory.requireProfile(profileId);
    return {
      summary: memory.summary(profile),
      skills: Object.values(profile.skills).sort((a, b) => b.xp - a.xp),
      loadouts: Object.values(profile.loadouts),
      equippedLoadout: profile.equippedLoadout ? profile.loadouts[profile.equippedLoadout] : null,
      record: profile.record,
      habits: profile.habits,
      preferences: profile.preferences,
      companionBehaviors: Object.values(profile.companionBehaviors),
      recentTraces: profile.traceIndex.slice(0, 12).map((id) => profile.traces[id]).filter(Boolean),
      pressure: memory.memoryPressure(profile),
      signature: profile.memorySignature,
    };
  });

  router.get('/v1/memory/:profileId/skills', {
    handler: 'memory.skills.get',
    group: 'memory',
    domain: 'memory',
    title: 'Skill tree',
    summary: 'Skills grouped by school with xp, level and the next-level threshold.',
    scopes: ['entropy:read'],
  }, (ctx) => ({ ...memory.skillTree(resolveProfile(ctx.params.profileId)), baseSkills: BASE_SKILLS, levelCurve: Array.from({ length: 12 }, (_, i) => ({ level: i + 1, xpRequired: require('../systems/memory').xpForLevel(i + 2) })) }));

  router.post('/v1/memory/:profileId/skills/:skillId/use', {
    handler: 'memory.skill.use',
    group: 'memory',
    domain: 'memory',
    title: 'Record skill use',
    summary: 'Outcome-weighted xp: win 45, raid 60, teach 30, draw 22, loss 14, use 8, fail 5.',
    scopes: ['memory:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { outcome: { type: 'string', enum: ['win', 'loss', 'draw', 'use', 'teach', 'fail', 'raid'] }, notes: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'memory.skill.use',
      payload: { profileId: ctx.params.profileId, skillId: ctx.params.skillId, outcome: ctx.body.outcome || 'use' },
      apply: () => memory.recordSkillUse(resolveProfile(ctx.params.profileId), ctx.params.skillId, { outcome: ctx.body.outcome || 'use', notes: ctx.body.notes || null, actor: ctx.subject }),
    }));

  router.post('/v1/memory/:profileId/remember', {
    handler: 'memory.remember',
    group: 'memory',
    domain: 'memory',
    title: 'Remember a trace',
    summary: 'Add a memory trace with resonance and decay. Traces are the atomic unit of Entropy Memory.',
    scopes: ['memory:write'],
    risk: 'LOW',
    body: {
      type: 'object',
      properties: {
        kind: { type: 'string', note: 'free-form; e.g. win, loadout, companion, scan' },
        text: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        resonance: { type: 'number' },
        decayDays: { type: 'integer' },
        source: { type: 'string' },
        ref: { type: 'object' },
      },
      required: ['text'],
    },
    example: { kind: 'loadout', text: 'Switched to the tidal-step / gate-seal build for night raids.', tags: ['loadout', 'tidal'], resonance: 1.4, decayDays: 90 },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'memory.remember',
      payload: { profileId: resolveProfile(ctx.params.profileId, { create: true }), trace: ctx.body },
      apply: () => memory.remember(resolveProfile(ctx.params.profileId, { create: true }), ctx.body, { actor: ctx.subject }),
    }));

  router.post('/v1/memory/:profileId/recall', {
    handler: 'memory.recall',
    group: 'memory',
    domain: 'memory',
    title: 'Recall',
    summary: 'Scored retrieval: 0.45·keyword + 0.25·recency + 0.20·resonance + 0.10·access. Recalling strengthens the trace.',
    scopes: ['entropy:read'],
    risk: null,
    body: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' } } },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId);
    return memory.recall(profileId, { query: ctx.body.query || ctx.query.q || '', kind: ctx.body.kind || null, tags: ctx.body.tags || null, limit: clamp(Number(ctx.body.limit) || 8, 1, 50) });
  });

  router.post('/v1/memory/:profileId/forget/:traceId', {
    handler: 'memory.forget',
    group: 'memory',
    domain: 'memory',
    title: 'Forget a trace',
    summary: 'Soft erasure: the text is redacted and excluded from recall, the journal keeps the fact.',
    scopes: ['memory:write'],
    risk: 'MEDIUM',
    body: { type: 'object', properties: { reason: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'MEDIUM',
      kind: 'memory.forget',
      payload: { profileId: ctx.params.profileId, traceId: ctx.params.traceId, reason: ctx.body.reason || 'player-requested erasure' },
      apply: () => memory.forget(resolveProfile(ctx.params.profileId), ctx.params.traceId, { actor: ctx.subject, reason: ctx.body.reason || 'player-requested erasure' }),
    }));

  router.post('/v1/memory/:profileId/consolidate', {
    handler: 'memory.consolidate',
    group: 'memory',
    domain: 'memory',
    title: 'Consolidate memory',
    summary: 'Decay old traces, promote repetition into habits and skill xp, re-sign the profile.',
    scopes: ['memory:write'],
    risk: 'MEDIUM',
    body: { type: 'object', properties: {} },
  }, (ctx) =>
    gated(ctx, {
      risk: 'MEDIUM',
      kind: 'memory.consolidate',
      payload: { profileId: ctx.params.profileId },
      apply: () => memory.consolidate(resolveProfile(ctx.params.profileId), { actor: ctx.subject }),
    }));

  router.get('/v1/memory/:profileId/graph', {
    handler: 'memory.graph',
    group: 'memory',
    domain: 'memory',
    title: 'Memory constellation',
    summary: 'Nodes + edges for the HUD: profile → skills, loadouts, companions, traces.',
    scopes: ['entropy:read'],
  }, (ctx) => memory.graph(resolveProfile(ctx.params.profileId), { limit: clamp(Number(ctx.query.limit) || 40, 5, 120) }));

  router.post('/v1/memory/:profileId/loadouts', {
    handler: 'memory.loadout.save',
    group: 'memory',
    domain: 'memory',
    title: 'Save a loadout',
    summary: `Socket artifacts / woven abilities into ${LOADOUT_SLOTS.join(', ')}. Versioned; the record follows the build.`,
    scopes: ['memory:write'],
    risk: 'LOW',
    body: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        loadoutId: { type: 'string' },
        slots: { type: 'object', properties: Object.fromEntries(LOADOUT_SLOTS.map((s) => [s, { type: 'string' }])) },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
    example: { name: 'Night Gate', slots: { core: 'aegis-lattice', visor: 'prism-lash', tether: 'EX-ART-…' } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'memory.loadout',
      payload: { profileId: resolveProfile(ctx.params.profileId, { create: true }), loadout: { ...ctx.body, actor: ctx.subject } },
      apply: () => memory.saveLoadout(resolveProfile(ctx.params.profileId, { create: true }), { ...ctx.body, actor: ctx.subject }),
    }));

  router.get('/v1/memory/:profileId/loadouts', {
    handler: 'memory.loadout.list',
    group: 'memory',
    domain: 'memory',
    title: 'List loadouts',
    summary: 'Every saved build with its win/loss record and socket map.',
    scopes: ['entropy:read'],
  }, (ctx) => memory.listLoadouts(resolveProfile(ctx.params.profileId)));

  router.post('/v1/memory/:profileId/loadouts/:loadoutId/equip', {
    handler: 'memory.loadout.equip',
    group: 'memory',
    domain: 'memory',
    title: 'Equip a loadout',
    summary: 'Sets the active build used by match recording and raid rosters.',
    scopes: ['memory:write'],
    risk: 'LOW',
    body: { type: 'object', properties: {} },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'memory.loadout.equip',
      payload: { profileId: ctx.params.profileId, loadoutId: ctx.params.loadoutId },
      apply: () => memory.equipLoadout(resolveProfile(ctx.params.profileId), ctx.params.loadoutId, { actor: ctx.subject }),
    }));

  router.post('/v1/memory/:profileId/matches', {
    handler: 'memory.match.record',
    group: 'memory',
    domain: 'memory',
    title: 'Record a match',
    summary: 'The fan-out point: updates wins, loadout record, skill xp, companion tactic learning, play-window preference and writes an explanatory trace.',
    scopes: ['memory:write'],
    risk: 'MEDIUM',
    body: {
      type: 'object',
      properties: {
        result: { type: 'string', enum: ['win', 'loss', 'draw'] },
        mode: { type: 'string', enum: ['skirmish', 'raid', 'scan', 'defense', 'escort', 'weave-duel', 'social'] },
        loadoutId: { type: 'string' },
        companions: { type: 'array', items: { type: 'string' } },
        tactics: { type: 'array', items: { type: 'string', enum: TACTICS.map((t) => t.id) } },
        score: { type: 'integer' },
        lobbyId: { type: 'string' },
        raidId: { type: 'string' },
        durationSec: { type: 'integer' },
      },
      required: ['result'],
    },
    example: { result: 'win', mode: 'skirmish', tactics: ['flank-left', 'overwatch'], companions: ['cmp-abc123'], score: 78 },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId, { create: true });
    return gated(ctx, {
      risk: 'MEDIUM',
      kind: 'memory.match',
      payload: { profileId, match: ctx.body },
      // Entropy Memory owns the cadence fan-out for a match, so the route stays
      // a thin adapter: no duplicated observe() calls here.
      apply: () => memory.recordMatch(profileId, ctx.body, { actor: ctx.subject }),
    });
  });

  router.get('/v1/memory/:profileId/companions', {
    handler: 'memory.companions.get',
    group: 'memory',
    domain: 'memory',
    title: 'Companion behaviours',
    summary: 'What memory holds about each companion: tactic weights, bond, win rate, quirks.',
    scopes: ['entropy:read'],
  }, (ctx) => memory.companionBehaviors(resolveProfile(ctx.params.profileId)));

  router.get('/v1/memory/:profileId/export', {
    handler: 'memory.profile.export',
    group: 'memory',
    domain: 'memory',
    title: 'Export profile bundle',
    summary: 'Portable ENTROPY-MEMORY bundle with a memory signature for cross-network import.',
    scopes: ['entropy:read'],
    query: [{ name: 'traces', type: 'boolean', note: 'include raw traces (default true)' }],
  }, (ctx) => memory.exportProfile(resolveProfile(ctx.params.profileId), { includeTraces: ctx.query.traces !== 'false' }));

  router.post('/v1/memory/import', {
    handler: 'memory.profile.import',
    group: 'memory',
    domain: 'memory',
    title: 'Import profile bundle',
    summary: 'Idempotent by (subject, signature). Merges durable numbers upward and unions traces.',
    scopes: ['memory:write'],
    risk: 'HIGH',
    body: { type: 'object', description: 'An ENTROPY-MEMORY bundle from /export' },
  }, (ctx) =>
    gated(ctx, {
      risk: 'HIGH',
      kind: 'memory.import',
      payload: { bundle: ctx.body },
      apply: () => memory.importProfile(ctx.body, { actor: ctx.subject }),
    }));

  router.get('/v1/memory/stats', {
    handler: 'memory.stats',
    group: 'memory',
    domain: 'memory',
    title: 'Memory stats',
    summary: 'Profiles, active traces, wins, loadouts and companions tracked.',
    auth: false,
  }, () => memory.stats());

  /* ══════════════════════════ 5. POWER WEAVING ══════════════════════════ */

  router.get('/v1/weave/catalog', {
    handler: 'weave.catalog',
    group: 'weave',
    domain: 'weave',
    title: 'Ability catalog',
    summary: 'Base abilities plus abilities generated from mined artifact fragments.',
    scopes: ['entropy:read'],
    query: [
      { name: 'school', type: 'string', enum: Object.keys(SCHOOLS) },
      { name: 'tier', type: 'integer' },
      { name: 'origin', type: 'string', note: 'base|mined' },
      { name: 'limit', type: 'integer' },
    ],
  }, (ctx) => ({
    schools: Object.values(SCHOOLS),
    count: weave.catalog({ school: ctx.query.school || null, tier: ctx.query.tier ? Number(ctx.query.tier) : null, origin: ctx.query.origin || null, limit: clamp(Number(ctx.query.limit) || 200, 1, 500) }).length,
    abilities: weave.catalog({ school: ctx.query.school || null, tier: ctx.query.tier ? Number(ctx.query.tier) : null, origin: ctx.query.origin || null, limit: clamp(Number(ctx.query.limit) || 200, 1, 500) }),
    stats: weave.stats(),
  }));

  router.get('/v1/weave/schools', {
    handler: 'weave.schools',
    group: 'weave',
    domain: 'weave',
    title: 'Schools + synergy matrix',
    summary: 'The compatibility matrix that drives every fusion outcome.',
    auth: false,
  }, () => weave.schools());

  router.get('/v1/weave/abilities/:abilityId', {
    handler: 'weave.ability.get',
    group: 'weave',
    domain: 'weave',
    title: 'Ability detail',
    summary: 'One ability: stats, requirements, entropy address, origin fragment.',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const ability = weave.getAbility(ctx.params.abilityId);
    if (!ability) throw toNotFound(`unknown ability: ${ctx.params.abilityId}`);
    return ability;
  });

  router.post('/v1/weave/unlock', {
    handler: 'weave.unlock',
    group: 'weave',
    domain: 'weave',
    title: 'Unlock an ability',
    summary: 'Pays RLU (or residue at 0.6×) and enforces level + prerequisite abilities in code.',
    scopes: ['weave:write'],
    risk: 'HIGH',
    body: { type: 'object', properties: { profileId: { type: 'string' }, abilityId: { type: 'string' }, payWith: { type: 'string', enum: ['rlu', 'residue'] } }, required: ['abilityId'] },
    example: { abilityId: 'tidal-step', payWith: 'rlu' },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'HIGH',
      kind: 'weave.unlock',
      payload: { profileId, abilityId: ctx.body.abilityId, payWith: ctx.body.payWith || 'rlu' },
      apply: () => weave.unlock(profileId, ctx.body.abilityId, { payWith: ctx.body.payWith || 'rlu', actor: ctx.subject }),
    });
  });

  router.post('/v1/weave/analyze', {
    handler: 'weave.analyze',
    group: 'weave',
    domain: 'weave',
    title: 'Analyse a fusion',
    summary: 'Dry-run the fusion maths: synergy pairs, power, stability, resonance, predicted outcome and generated name. No state change.',
    scopes: ['entropy:read'],
    risk: null,
    body: { type: 'object', properties: { profileId: { type: 'string' }, abilityIds: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 } }, required: ['abilityIds'] },
    example: { abilityIds: ['tidal-step', 'gate-seal'] },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return weave.analyze(profileId, ctx.body.abilityIds || []);
  });

  router.post('/v1/weave/fuse', {
    handler: 'weave.fuse',
    group: 'weave',
    domain: 'weave',
    title: 'Weave a fusion',
    summary: 'Commit a 2–4 ability fusion. STABLE / VOLATILE produce a new ability with its own address; FRACTURE returns residue.',
    scopes: ['weave:write'],
    risk: 'HIGH',
    body: { type: 'object', properties: { profileId: { type: 'string' }, abilityIds: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 } }, required: ['abilityIds'] },
    example: { abilityIds: ['tidal-step', 'mark-relay'] },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    const preview = (() => {
      try {
        return weave.analyze(profileId, ctx.body.abilityIds || []);
      } catch (err) {
        return { error: err.message };
      }
    })();
    return gated(ctx, {
      risk: 'HIGH',
      kind: 'weave.fuse',
      payload: { profileId, abilityIds: ctx.body.abilityIds },
      reason: preview.error ? null : `fusion ${preview.name} predicted ${preview.result?.outcome} (stability ${preview.result?.stability})`,
      pendingExtra: { preview },
      apply: () => weave.weave(profileId, ctx.body.abilityIds, { actor: ctx.subject }),
    });
  });

  router.get('/v1/weave/holdings/:profileId', {
    handler: 'weave.holdings',
    group: 'weave',
    domain: 'weave',
    title: 'Weave holdings',
    summary: 'Unlocked abilities, levels, fusions and residue for a profile.',
    scopes: ['entropy:read'],
  }, (ctx) => weave.holdingsOf(resolveProfile(ctx.params.profileId, { create: true })));

  router.post('/v1/weave/fusions/:fusionId/use', {
    handler: 'weave.fusion.use',
    group: 'weave',
    domain: 'weave',
    title: 'Use a fusion',
    summary: 'Counts a use; volatile fusions lose durability and dissolve into residue at zero.',
    scopes: ['weave:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' }, outcome: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'weave.fusion.use',
      payload: { fusionId: ctx.params.fusionId, profileId: ctx.body.profileId || ctx.subject },
      apply: () => weave.useFusion(resolveProfile(ctx.body.profileId || ctx.subject), ctx.params.fusionId, { outcome: ctx.body.outcome || 'use', actor: ctx.subject }),
    }));

  router.post('/v1/weave/fusions/:fusionId/unweave', {
    handler: 'weave.unweave',
    group: 'weave',
    domain: 'weave',
    title: 'Unweave a fusion',
    summary: 'Dissolve a fusion back into residue (power×0.2 + 4 per component).',
    scopes: ['weave:write'],
    risk: 'MEDIUM',
    body: { type: 'object', properties: { profileId: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'MEDIUM',
      kind: 'weave.unweave',
      payload: { profileId: ctx.body.profileId || ctx.subject, fusionId: ctx.params.fusionId },
      apply: () => weave.unweave(resolveProfile(ctx.body.profileId || ctx.subject), ctx.params.fusionId, { actor: ctx.subject }),
    }));

  router.get('/v1/weave/recipes', {
    handler: 'weave.recipes',
    group: 'weave',
    domain: 'weave',
    title: 'Proven recipes',
    summary: 'Which combinations the network has actually landed, with best power/stability.',
    scopes: ['entropy:read'],
    query: [{ name: 'sortBy', type: 'string', note: 'count|power|stability' }, { name: 'limit', type: 'integer' }],
  }, (ctx) => weave.recipes({ limit: clamp(Number(ctx.query.limit) || 24, 1, 100), sortBy: ctx.query.sortBy || 'count' }));

  router.get('/v1/weave/leaderboard', {
    handler: 'weave.leaderboard',
    group: 'weave',
    domain: 'weave',
    title: 'Fusion leaderboard',
    summary: 'Top active fusions scored by power × stability.',
    scopes: ['entropy:read'],
  }, (ctx) => ({ outcomes: OUTCOMES, leaderboard: weave.leaderboard({ limit: clamp(Number(ctx.query.limit) || 20, 1, 100) }) }));

  router.get('/v1/weave/stats', {
    handler: 'weave.stats',
    group: 'weave',
    domain: 'weave',
    title: 'Weave stats',
    summary: 'Catalog size, mined abilities, unlocks, fusions, fractures, residue.',
    auth: false,
  }, () => weave.stats());

  /* ════════════════════════════ 6. AR OVERLAY ═══════════════════════════ */

  router.get('/v1/ar/layers', {
    handler: 'ar.layers',
    group: 'ar',
    domain: 'ar',
    title: 'AR layers',
    summary: 'Layer registry tinted with the live chromium alloy, plus scan modes and the privacy posture.',
    scopes: ['entropy:read'],
  }, () => ar.layers());

  router.post('/v1/ar/scan', {
    handler: 'ar.scan',
    group: 'ar',
    domain: 'ar',
    title: 'Run a scan',
    summary: 'Deterministic contacts from (seed, quantised location, time bucket, layers). Plated with Entropy Chromium.',
    scopes: ['ar:write'],
    risk: 'LOW',
    body: {
      type: 'object',
      properties: {
        profileId: { type: 'string' },
        mode: { type: 'string', enum: Object.keys(SCAN_MODES) },
        location: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
        layers: { type: 'array', items: { type: 'string', enum: LAYERS.map((l) => l.id) } },
      },
    },
    example: { mode: 'deep', location: { x: 120, y: -40, z: 8 }, layers: ['scan', 'glyph', 'map', 'threat'] },
  }, (ctx) => {
    const profileId = ctx.body.profileId ? resolveProfile(ctx.body.profileId, { create: true }) : null;
    return gated(ctx, {
      risk: 'LOW',
      kind: 'ar.scan',
      payload: { profileId, scan: ctx.body },
      apply: () => ar.scan({ ...ctx.body, profileId }, { actor: ctx.subject }),
    });
  });

  router.get('/v1/ar/history/:profileId', {
    handler: 'ar.history',
    group: 'ar',
    domain: 'ar',
    title: 'Scan history',
    summary: 'Recent scan summaries for a profile (contacts are re-derivable from the scan seed).',
    scopes: ['entropy:read'],
  }, (ctx) => ({ scans: ar.history(resolveProfile(ctx.params.profileId, { create: true }), { limit: clamp(Number(ctx.query.limit) || 20, 1, 100) }) }));

  router.get('/v1/ar/map/:z/:x/:y', {
    handler: 'ar.map.tile',
    group: 'ar',
    domain: 'ar',
    title: 'Map tile',
    summary: 'Deterministic tile: heightfield, biome, hazard/cover and markers. Shaped by mined terrain fragments.',
    scopes: ['entropy:read'],
  }, (ctx) => ar.tile(ctx.params.z, ctx.params.x, ctx.params.y));

  router.get('/v1/ar/overlay.svg', {
    handler: 'ar.overlay.svg',
    group: 'ar',
    domain: 'ar',
    title: 'Overlay SVG',
    summary: 'A ready-to-composite HUD frame (reticle, contacts, legend) generated from the chromium alloy.',
    auth: false,
    query: [
      { name: 'mode', type: 'string', note: 'scan mode used to source contacts' },
      { name: 'layers', type: 'string', note: 'comma-separated layer ids' },
      { name: 'w', type: 'integer' },
      { name: 'h', type: 'integer' },
      { name: 'title', type: 'string' },
    ],
  }, (ctx) => {
    const layers = ctx.query.layers ? String(ctx.query.layers).split(',').filter((l) => LAYERS.some((x) => x.id === l)) : LAYERS.map((l) => l.id);
    let contacts = [];
    let scanId = null;
    try {
      const scan = ar.scan({ mode: ctx.query.mode || 'sweep', layers, location: { x: Number(ctx.query.x) || 0, y: Number(ctx.query.y) || 0, z: 0 } }, { actor: ctx.subject });
      contacts = scan.contacts;
      scanId = scan.scanId;
    } catch {
      contacts = [];
    }
    const svg = ar.renderOverlay({
      contacts,
      layers,
      viewport: { w: clamp(Number(ctx.query.w) || 960, 320, 2400), h: clamp(Number(ctx.query.h) || 540, 240, 1400) },
      title: ctx.query.title || 'ENTROPY SCAN',
      scanId,
    });
    return { __raw: true, status: 200, body: svg, extra: { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' } } };
  });

  router.post('/v1/ar/anchors', {
    handler: 'ar.anchor.create',
    group: 'ar',
    domain: 'ar',
    title: 'Pin an anchor',
    summary: 'Place a marker on a layer. Visibility public|party|private; positions are quantised to 25 m.',
    scopes: ['ar:write'],
    risk: 'MEDIUM',
    body: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: LAYERS.map((l) => l.id) },
        label: { type: 'string' },
        detail: { type: 'string' },
        position: { type: 'object' },
        visibility: { type: 'string', enum: ['public', 'party', 'private'] },
        ttlMinutes: { type: 'integer' },
        profileId: { type: 'string' },
        ref: { type: 'object' },
      },
      required: ['label'],
    },
  }, (ctx) =>
    gated(ctx, {
      risk: 'MEDIUM',
      kind: 'ar.anchor',
      payload: { anchor: { ...ctx.body, profileId: ctx.body.profileId || null } },
      apply: () => {
        const owner = ctx.body.profileId ? resolveProfile(ctx.body.profileId, { create: true }) : memory.getProfile(ctx.subject)?.profileId || null;
        return ar.createAnchor({ ...ctx.body, profileId: owner }, { actor: ctx.subject });
      },
    }));

  router.get('/v1/ar/anchors', {
    handler: 'ar.anchor.list',
    group: 'ar',
    domain: 'ar',
    title: 'List anchors',
    summary: 'Live anchors, filtered by layer/visibility. Private anchors only ever return to their owner.',
    scopes: ['entropy:read'],
    query: [{ name: 'layer', type: 'string' }, { name: 'visibility', type: 'string' }, { name: 'limit', type: 'integer' }],
  }, (ctx) => {
    const profileId = ctx.claims ? memory.getProfile(ctx.subject)?.profileId || ctx.subject : null;
    return { anchors: ar.listAnchors({ layer: ctx.query.layer || null, visibility: ctx.query.visibility || null, profileId, limit: clamp(Number(ctx.query.limit) || 60, 1, 200) }), stats: ar.stats() };
  });

  router.delete('/v1/ar/anchors/:anchorId', {
    handler: 'ar.anchor.remove',
    group: 'ar',
    domain: 'ar',
    title: 'Remove an anchor',
    summary: 'Owner-only removal (or unmask authority).',
    scopes: ['ar:write'],
    risk: 'LOW',
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'ar.anchor.remove',
      payload: { anchorId: ctx.params.anchorId },
      apply: () => ar.removeAnchor(ctx.params.anchorId, { actor: ctx.subject }),
    }));

  router.get('/v1/ar/stats', {
    handler: 'ar.stats',
    group: 'ar',
    domain: 'ar',
    title: 'AR stats',
    summary: 'Scans, contacts, live anchors and the privacy cell size.',
    auth: false,
  }, () => ar.stats());

  /* ═══════════════════════ 7. AI SQUAD COMPANIONS ═══════════════════════ */

  router.get('/v1/squad/roster', {
    handler: 'squad.roster',
    group: 'squad',
    domain: 'squad',
    title: 'Companion roster',
    summary: 'Seed-generated companions with roles, traits, voice and inborn tactic affinity.',
    scopes: ['entropy:read'],
  }, () => squad.roster());

  router.post('/v1/squad/:profileId/recruit', {
    handler: 'squad.recruit',
    group: 'squad',
    domain: 'squad',
    title: 'Recruit a companion',
    summary: 'Binds a roster companion to a profile and starts its learning model.',
    scopes: ['squad:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { companionId: { type: 'string' } }, required: ['companionId'] },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId, { create: true });
    return gated(ctx, {
      risk: 'LOW',
      kind: 'squad.recruit',
      payload: { profileId, companionId: ctx.body.companionId },
      apply: () => squad.recruit(profileId, ctx.body.companionId, { actor: ctx.subject }),
    });
  });

  router.get('/v1/squad/:profileId/companions', {
    handler: 'squad.companions.list',
    group: 'squad',
    domain: 'squad',
    title: 'Your companions',
    summary: 'Instances with normalised weights, confidence, bond, quirks and learning curves.',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId, { create: true });
    return { profileId, companions: squad.activeCompanions(profileId, { limit: 8 }), briefing: squad.briefing(profileId), learning: LEARNING };
  });

  router.get('/v1/squad/:profileId/companions/:companionId', {
    handler: 'squad.companion.model',
    group: 'squad',
    domain: 'squad',
    title: 'Companion learning model',
    summary: 'Full weights, history ring buffer, quirks with evidence, and the archetype it came from.',
    scopes: ['entropy:read'],
  }, (ctx) => squad.model(resolveProfile(ctx.params.profileId, { create: true }), ctx.params.companionId));

  router.post('/v1/squad/:profileId/companions/:companionId/drill', {
    handler: 'squad.drill',
    group: 'squad',
    domain: 'squad',
    title: 'Drill a tactic',
    summary: 'Explicit teaching. Drilling with the companion\'s inborn affinity raises bond; against it costs bond.',
    scopes: ['squad:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { tactic: { type: 'string', enum: TACTICS.map((t) => t.id) }, intensity: { type: 'number' } }, required: ['tactic'] },
    example: { tactic: 'flank-left', intensity: 1.5 },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId, { create: true });
    return gated(ctx, {
      risk: 'LOW',
      kind: 'squad.drill',
      payload: { profileId, companionId: ctx.params.companionId, tactic: ctx.body.tactic, intensity: ctx.body.intensity || 1 },
      apply: () => squad.drill(profileId, ctx.params.companionId, ctx.body.tactic, { intensity: ctx.body.intensity || 1, actor: ctx.subject }),
    });
  });

  router.post('/v1/squad/:profileId/learn', {
    handler: 'squad.learn',
    group: 'squad',
    domain: 'squad',
    title: 'Teach from a match',
    summary: 'Direct learning hook for integrations that run their own match loop (Memory calls this automatically).',
    scopes: ['squad:write'],
    risk: 'MEDIUM',
    body: {
      type: 'object',
      properties: {
        companionId: { type: 'string' },
        result: { type: 'string', enum: ['win', 'loss', 'draw'] },
        tactics: { type: 'array', items: { type: 'string', enum: TACTICS.map((t) => t.id) } },
        mode: { type: 'string' },
        deepScan: { type: 'boolean' },
      },
      required: ['companionId', 'result'],
    },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId, { create: true });
    return gated(ctx, {
      risk: 'MEDIUM',
      kind: 'squad.learn',
      payload: { profileId, ...ctx.body },
      apply: () => squad.learnFromMatch({ profileId, ...ctx.body }),
    });
  });

  router.get('/v1/squad/:profileId/recommend', {
    handler: 'squad.recommend',
    group: 'squad',
    domain: 'squad',
    title: 'Squad recommendation',
    summary: 'Composition scored by 0.45·roleCoverage + 0.35·learnedAlignment + 0.20·bond.',
    scopes: ['entropy:read'],
    query: [{ name: 'mode', type: 'string', enum: ['skirmish', 'raid', 'scan', 'defense', 'escort'] }, { name: 'size', type: 'integer' }],
  }, (ctx) => squad.recommendSquad(resolveProfile(ctx.params.profileId, { create: true }), { mode: ctx.query.mode || 'skirmish', size: clamp(Number(ctx.query.size) || 3, 1, 5) }));

  router.get('/v1/squad/:profileId/briefing', {
    handler: 'squad.briefing',
    group: 'squad',
    domain: 'squad',
    title: 'Squad briefing',
    summary: 'Plain-language explanation of what the bench has learned about you.',
    scopes: ['entropy:read'],
  }, (ctx) => squad.briefing(resolveProfile(ctx.params.profileId, { create: true })));

  router.get('/v1/squad/:profileId/banter', {
    handler: 'squad.banter',
    group: 'squad',
    domain: 'squad',
    title: 'Companion banter',
    summary: 'Dialogue generated from mined voice fragments + learned tactic context.',
    scopes: ['entropy:read'],
    query: [{ name: 'context', type: 'string', enum: ['lobby', 'raid', 'scan', 'weave', 'recall'] }, { name: 'companionId', type: 'string' }, { name: 'turns', type: 'integer' }],
  }, (ctx) =>
    squad.banter({
      profileId: resolveProfile(ctx.params.profileId, { create: true }),
      companionId: ctx.query.companionId || null,
      context: ctx.query.context || 'lobby',
      turns: clamp(Number(ctx.query.turns) || 4, 1, 10),
    }));

  router.post('/v1/squad/:profileId/companions/:companionId/dismiss', {
    handler: 'squad.dismiss',
    group: 'squad',
    domain: 'squad',
    title: 'Dismiss a companion',
    summary: 'Clears the bench slot; the learning record is retained for audit.',
    scopes: ['squad:write'],
    risk: 'LOW',
    body: { type: 'object', properties: {} },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'squad.dismiss',
      payload: { profileId: ctx.params.profileId, companionId: ctx.params.companionId },
      apply: () => squad.dismiss(resolveProfile(ctx.params.profileId, { create: true }), ctx.params.companionId, { actor: ctx.subject }),
    }));

  router.get('/v1/squad/tactics', {
    handler: 'squad.tactics',
    group: 'squad',
    domain: 'squad',
    title: 'Tactic + role vocabulary',
    summary: 'The tactic table, roles, quirk rules and learning constants.',
    auth: false,
  }, () => ({ tactics: TACTICS, roles: SQUAD_ROLES, learning: LEARNING, quirkRules: require('../systems/squad').QUIRK_RULES.map((q) => ({ id: q.id, label: q.label, note: q.note })) }));

  router.get('/v1/squad/stats', {
    handler: 'squad.stats',
    group: 'squad',
    domain: 'squad',
    title: 'Squad stats',
    summary: 'Roster size, instances, average bond, sworn companions, quirks surfaced.',
    auth: false,
  }, () => squad.stats());

  /* ══════════════════ 8. MISSIONS · EVENTS · SEASONS ════════════════════ */

  router.get('/v1/missions/board/:profileId', {
    handler: 'missions.board',
    group: 'missions',
    domain: 'missions',
    title: 'Mission board',
    summary: 'Daily + weekly + seasonal missions with your progress, plus live world events and season state.',
    scopes: ['entropy:read'],
  }, (ctx) => missions.board(resolveProfile(ctx.params.profileId, { create: true })));

  router.get('/v1/missions/cadence/:cadence', {
    handler: 'missions.generate',
    group: 'missions',
    domain: 'missions',
    title: 'Generate a cadence',
    summary: 'Deterministic mission set for daily|weekly|seasonal|event. Same seed + date ⇒ same missions everywhere.',
    scopes: ['entropy:read'],
    query: [{ name: 'day', type: 'integer', note: 'epoch day override' }, { name: 'limit', type: 'integer' }],
  }, (ctx) => {
    const cadence = ['daily', 'weekly', 'seasonal', 'event'].includes(ctx.params.cadence) ? ctx.params.cadence : null;
    if (!cadence) throw toBadRequest('cadence must be daily|weekly|seasonal|event');
    return missions.generate(cadence, { day: ctx.query.day ? Number(ctx.query.day) : undefined, limit: ctx.query.limit ? Number(ctx.query.limit) : null });
  });

  router.post('/v1/missions/:missionId/accept', {
    handler: 'missions.accept',
    group: 'missions',
    domain: 'missions',
    title: 'Accept a mission',
    summary: 'Starts progress tracking for a generated mission.',
    scopes: ['mission:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' } } },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'LOW',
      kind: 'missions.accept',
      payload: { profileId, missionId: ctx.params.missionId },
      apply: () => missions.accept(profileId, ctx.params.missionId, { actor: ctx.subject }),
    });
  });

  router.post('/v1/missions/:missionId/complete', {
    handler: 'missions.complete',
    group: 'missions',
    domain: 'missions',
    title: 'Complete a mission',
    summary: 'Validates every objective, pays RLU + season xp, writes a memory trace.',
    scopes: ['mission:write'],
    risk: 'MEDIUM',
    body: { type: 'object', properties: { profileId: { type: 'string' } } },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'MEDIUM',
      kind: 'missions.complete',
      payload: { profileId, missionId: ctx.params.missionId },
      apply: () => missions.complete(profileId, ctx.params.missionId, { actor: ctx.subject }),
    });
  });

  router.post('/v1/missions/observe', {
    handler: 'missions.observe',
    group: 'missions',
    domain: 'missions',
    title: 'Push a gameplay event',
    summary: 'Integration hook: advance every accepted mission whose objective matches this event type.',
    scopes: ['mission:write'],
    risk: 'LOW',
    body: {
      type: 'object',
      properties: { profileId: { type: 'string' }, event: { type: 'string', enum: Object.keys(OBJECTIVE_EVENTS) }, amount: { type: 'integer' }, meta: { type: 'object' } },
      required: ['event'],
    },
    example: { event: 'scan.run', amount: 2 },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'LOW',
      kind: 'missions.observe',
      payload: { profileId, event: ctx.body.event, amount: ctx.body.amount || 1 },
      apply: () => missions.observe({ profileId, event: ctx.body.event, amount: ctx.body.amount || 1, meta: ctx.body.meta || {} }),
    });
  });

  router.get('/v1/missions/events', {
    handler: 'missions.events.list',
    group: 'missions',
    domain: 'missions',
    title: 'World events',
    summary: 'Scheduled + triggered events live now, with their modifiers.',
    scopes: ['entropy:read'],
  }, (ctx) => ({ live: missions.liveWorldEvents(), scheduledToday: missions.worldEvents(), kinds: WORLD_EVENT_KINDS, multipliers: { rluMultiplier: missions.eventMultiplier('rluMultiplier'), stabilityBonus: missions.eventBonus('stabilityBonus'), bondMultiplier: missions.eventMultiplier('bondMultiplier'), pendingDiscount: missions.eventMultiplier('pendingDiscount') } }));

  router.post('/v1/missions/events', {
    handler: 'missions.event.trigger',
    group: 'missions',
    domain: 'missions',
    title: 'Trigger a world event',
    summary: 'Architect authority. SEVERE risk, so a normal token parks this in the Unmask Pool.',
    scopes: ['mission:write'],
    risk: 'SEVERE',
    body: {
      type: 'object',
      properties: { kind: { type: 'string', enum: WORLD_EVENT_KINDS.map((k) => k.id) }, durationHours: { type: 'number' }, intensity: { type: 'number' }, reason: { type: 'string' } },
      required: ['kind'],
    },
    example: { kind: 'chromium-rain', durationHours: 6, reason: 'community night' },
  }, (ctx) =>
    gated(ctx, {
      risk: 'SEVERE',
      kind: 'missions.event.trigger',
      payload: { event: { kind: ctx.body.kind, durationHours: ctx.body.durationHours || 4, intensity: ctx.body.intensity || 0.8, reason: ctx.body.reason || null } },
      apply: () => missions.triggerWorldEvent({ kind: ctx.body.kind, durationHours: ctx.body.durationHours || 4, intensity: ctx.body.intensity || 0.8, reason: ctx.body.reason || null }, { actor: ctx.subject }),
    }));

  router.get('/v1/missions/season', {
    handler: 'missions.season.current',
    group: 'missions',
    domain: 'missions',
    title: 'Current season',
    summary: '28-day season: id, name, laws (mined or derived), tiers and live modifiers.',
    auth: false,
  }, () => ({ season: missions.currentSeason(), tiers: SEASON_TIERS, seasonLengthDays: require('../systems/missions').SEASON_LENGTH_DAYS }));

  router.get('/v1/missions/season/:profileId', {
    handler: 'missions.season.progress',
    group: 'missions',
    domain: 'missions',
    title: 'Season progression',
    summary: 'Your xp, tier, next threshold and claimable rewards. Pass claim=true to collect.',
    scopes: ['entropy:read'],
    query: [{ name: 'claim', type: 'boolean' }],
  }, (ctx) => {
    const profileId = resolveProfile(ctx.params.profileId, { create: true });
    if (ctx.query.claim === 'true') {
      return gated(ctx, {
        risk: 'MEDIUM',
        kind: 'missions.season.claim',
        payload: { profileId },
        apply: () => missions.seasonProgress(profileId, { claim: true }),
      });
    }
    return missions.seasonProgress(profileId);
  });

  router.get('/v1/missions/leaderboard', {
    handler: 'missions.leaderboard',
    group: 'missions',
    domain: 'missions',
    title: 'Mission leaderboard',
    summary: 'Completions and RLU earned, optionally filtered by cadence.',
    scopes: ['entropy:read'],
    query: [{ name: 'cadence', type: 'string' }, { name: 'limit', type: 'integer' }],
  }, (ctx) => missions.leaderboard({ cadence: ctx.query.cadence || null, limit: clamp(Number(ctx.query.limit) || 20, 1, 100) }));

  router.get('/v1/missions/stats', {
    handler: 'missions.stats',
    group: 'missions',
    domain: 'missions',
    title: 'Mission stats',
    summary: 'Completions, RLU/xp paid, live events and the current season.',
    auth: false,
  }, () => missions.stats());

  /* ═══════════════════════ 9. SAFE MULTIPLAYER ══════════════════════════ */

  router.get('/v1/multiplayer/safety', {
    handler: 'multiplayer.safety.model',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Safety model',
    summary: 'The scoring weights, default posture, filters, age bands and raid phases — safety as code.',
    auth: false,
  }, (ctx) => {
    const settings = ctx.body?.settings || ctx.query?.settings ? JSON.parse(ctx.query.settings) : require('../systems/multiplayer').Multiplayer.defaultSettings();
    return {
      defaults: settings,
      score: require('../systems/multiplayer').Multiplayer.safetyScore(settings),
      breakdown: require('../systems/multiplayer').Multiplayer.safetyBreakdown(settings),
      weights: require('../systems/multiplayer').SAFETY_WEIGHTS,
      filters: CONTENT_FILTERS,
      ageBands: AGE_BANDS,
      privacy: Object.values(require('../systems/multiplayer').PRIVACY),
      modes: LOBBY_MODES,
      raidPhases: RAID_PHASES,
      guarantees: [
        'positions are quantised to 25 m before they can be shared',
        'presence sharing is per-member and default-off',
        'no email, device id or IP is ever written to lobby state',
        'reports park a pending seal — sanctions require moderator authority, never auto-fire',
        'safe-exit is a single call: leaves every lobby, clears presence, revokes consent',
      ],
    };
  });

  router.post('/v1/multiplayer/lobbies', {
    handler: 'multiplayer.lobby.create',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Create a lobby',
    summary: 'Safety-scored on creation from its settings. Defaults are locked down (party-code, filters on, proximity voice off).',
    scopes: ['lobby:write'],
    risk: 'MEDIUM',
    body: {
      type: 'object',
      properties: {
        profileId: { type: 'string' },
        name: { type: 'string' },
        mode: { type: 'string', enum: LOBBY_MODES },
        region: { type: 'string' },
        settings: { type: 'object', description: 'privacy, maxMembers, proximityVoice, contentFilters, hostModeration, ageBand…' },
      },
    },
    example: { mode: 'raid', name: 'Night Gate Raid', settings: { privacy: 'party-code', maxMembers: 6, ageBand: 'teen' } },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'MEDIUM',
      kind: 'multiplayer.lobby',
      payload: { profileId, lobby: { name: ctx.body.name, mode: ctx.body.mode, region: ctx.body.region, settings: ctx.body.settings } },
      apply: () => {
        return multiplayer.createLobby(
          profileId,
          { name: ctx.body.name, mode: ctx.body.mode, region: ctx.body.region, settings: ctx.body.settings },
          { actor: ctx.subject, verifiedHost: ctx.claims.tier === 'sovereign' || ctx.claims.tier === 'architect' },
        );
      },
    });
  });

  router.get('/v1/multiplayer/lobbies', {
    handler: 'multiplayer.lobby.list',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'List lobbies',
    summary: 'Open lobbies (invite-only lobbies appear only to their members).',
    scopes: ['entropy:read'],
    query: [{ name: 'mine', type: 'boolean' }, { name: 'includeClosed', type: 'boolean' }],
  }, (ctx) => {
    const profileId = memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    return { lobbies: multiplayer.listLobbies({ profileId: ctx.query.mine === 'true' ? profileId : null, includeClosed: ctx.query.includeClosed === 'true', limit: clamp(Number(ctx.query.limit) || 40, 1, 100) }), stats: multiplayer.stats() };
  });

  router.get('/v1/multiplayer/find', {
    handler: 'multiplayer.matchmaking',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Matchmaking',
    summary: 'Deterministic best-fit discovery above a safety floor. Safety is a hard filter, not a sort key.',
    scopes: ['entropy:read'],
    query: [
      { name: 'mode', type: 'string', enum: LOBBY_MODES },
      { name: 'minSafety', type: 'integer', note: 'default 60' },
      { name: 'region', type: 'string' },
      { name: 'limit', type: 'integer' },
    ],
  }, (ctx) => {
    const profileId = memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    const results = multiplayer.findLobbies({ mode: ctx.query.mode || null, minSafety: clamp(Number(ctx.query.minSafety) || 60, 0, 100), privacy: ctx.query.privacy || null, region: ctx.query.region || null, limit: clamp(Number(ctx.query.limit) || 12, 1, 50), profileId });
    return { minSafety: clamp(Number(ctx.query.minSafety) || 60, 0, 100), count: results.length, lobbies: results };
  });

  router.get('/v1/multiplayer/lobbies/:lobbyId', {
    handler: 'multiplayer.lobby.get',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Lobby detail',
    summary: 'Members (pseudonymous), safety breakdown, settings, raid binding and moderation log.',
    scopes: ['entropy:read'],
  }, (ctx) => {
    const profileId = memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    return multiplayer.getLobby(ctx.params.lobbyId, profileId);
  });

  router.post('/v1/multiplayer/lobbies/:lobbyId/join', {
    handler: 'multiplayer.lobby.join',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Join a lobby',
    summary: 'Enforces bans, invite-only rules, capacity, spectator policy and your safety floor.',
    scopes: ['lobby:write'],
    risk: 'MEDIUM',
    body: {
      type: 'object',
      properties: { profileId: { type: 'string' }, inviteCode: { type: 'string' }, as: { type: 'string', enum: ['member', 'spectator'] }, safetyFloor: { type: 'integer' } },
    },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'MEDIUM',
      kind: 'multiplayer.join',
      payload: { profileId, lobbyId: ctx.params.lobbyId, inviteCode: ctx.body.inviteCode || null, as: ctx.body.as || 'member', safetyFloor: ctx.body.safetyFloor || 0 },
      apply: () => multiplayer.joinLobby({ profileId, lobbyId: ctx.params.lobbyId, inviteCode: ctx.body.inviteCode || null, as: ctx.body.as || 'member', safetyFloor: Number(ctx.body.safetyFloor) || 0 }, { actor: ctx.subject }),
    });
  });

  router.post('/v1/multiplayer/lobbies/:lobbyId/leave', {
    handler: 'multiplayer.lobby.leave',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Leave a lobby',
    summary: 'Host transfer is automatic; an empty lobby closes and its invite code is revoked.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.leave',
      payload: { profileId: ctx.body.profileId || ctx.subject, lobbyId: ctx.params.lobbyId },
      apply: () => multiplayer.leaveLobby(resolveProfile(ctx.body.profileId || ctx.subject), ctx.params.lobbyId, { actor: ctx.subject }),
    }));

  router.post('/v1/multiplayer/lobbies/:lobbyId/invite', {
    handler: 'multiplayer.lobby.invite',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Invite a player',
    summary: 'Required for invite-only lobbies. Records who invited whom.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { targetProfileId: { type: 'string' } }, required: ['targetProfileId'] },
  }, (ctx) => {
    const profileId = memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    const lobby = multiplayer.getLobby(ctx.params.lobbyId, profileId);
    return gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.invite',
      payload: { lobbyId: ctx.params.lobbyId, targetProfileId: ctx.body.targetProfileId },
      apply: () => multiplayer.invite(ctx.params.lobbyId, resolveProfile(ctx.body.targetProfileId), { actor: ctx.subject, isHost: lobby.host === profileId }),
    });
  });

  router.post('/v1/multiplayer/lobbies/:lobbyId/moderate', {
    handler: 'multiplayer.moderate',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Moderate a member',
    summary: 'warn|mute|kick|ban by the host or an unmask authority. Every action is logged with a reason.',
    scopes: ['lobby:write'],
    risk: 'HIGH',
    body: { type: 'object', properties: { targetProfileId: { type: 'string' }, action: { type: 'string', enum: ['warn', 'mute', 'kick', 'ban'] }, reason: { type: 'string' } }, required: ['targetProfileId', 'action'] },
  }, (ctx) => {
    const profileId = memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    const lobby = multiplayer.getLobby(ctx.params.lobbyId, profileId);
    const isHost = lobby.host === profileId;
    const isModerator = (ctx.claims.scopes || []).includes('unmask:seal');
    if (!isHost && !isModerator) throw toForbidden('host or moderator authority required', { host: lobby.host });
    return gated(ctx, {
      risk: 'HIGH',
      kind: 'multiplayer.moderate',
      payload: { lobbyId: ctx.params.lobbyId, action: { targetProfileId: resolveProfile(ctx.body.targetProfileId), action: ctx.body.action, reason: ctx.body.reason || null } },
      apply: () => multiplayer.moderate(ctx.params.lobbyId, { targetProfileId: resolveProfile(ctx.body.targetProfileId), action: ctx.body.action, reason: ctx.body.reason || null }, { actor: ctx.subject, isHost, isModerator }),
    });
  });

  router.post('/v1/multiplayer/lobbies/:lobbyId/consent', {
    handler: 'multiplayer.consent',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Set presence consent',
    summary: 'Opt in/out of sharing your quantised position on party members\' AR layers. Default is OFF.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { consentShared: { type: 'boolean' }, profileId: { type: 'string' } }, required: ['consentShared'] },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.consent',
      payload: { lobbyId: ctx.params.lobbyId, profileId: ctx.subject, consentShared: Boolean(ctx.body.consentShared) },
      apply: () => multiplayer.setConsent(resolveProfile(ctx.body.profileId || ctx.subject), ctx.params.lobbyId, Boolean(ctx.body.consentShared), { actor: ctx.subject }),
    }));

  router.post('/v1/multiplayer/report', {
    handler: 'multiplayer.report',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'File a report',
    summary: 'Creates a report and parks the sanction decision as a pending seal — no unilateral punishment.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: {
      type: 'object',
      properties: { lobbyId: { type: 'string' }, targetProfileId: { type: 'string' }, category: { type: 'string', enum: ['harassment', 'hate', 'pii-exposure', 'cheating', 'minors-safety', 'spam', 'impersonation', 'other'] }, detail: { type: 'string' } },
      required: ['targetProfileId'],
    },
  }, (ctx) => {
    const profileId = memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    return multiplayer.report(
      {
        lobbyId: ctx.body.lobbyId || null,
        reporterProfileId: resolveProfile(ctx.body.reporterProfileId || ctx.subject, { create: true }),
        targetProfileId: resolveProfile(ctx.body.targetProfileId),
        category: ctx.body.category || 'harassment',
        detail: ctx.body.detail || null,
      },
      { actor: ctx.subject, claims: ctx.claims },
    );
  });

  router.post('/v1/multiplayer/safe-exit', {
    handler: 'multiplayer.safeExit',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Safe exit',
    summary: 'Panic path: leave every lobby and party, clear presence, revoke consent. One call, no confirmation loop.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' }, reason: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.safeExit',
      payload: { profileId: ctx.subject },
      apply: () => multiplayer.safeExit(resolveProfile(ctx.body.profileId || ctx.subject, { create: true }), { actor: ctx.subject, reason: ctx.body.reason || 'player safe exit' }),
    }));

  router.post('/v1/multiplayer/parties', {
    handler: 'multiplayer.party.create',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Create a party',
    summary: 'Persistent group that survives lobby hops, with a shared safety floor.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { name: { type: 'string' }, maxMembers: { type: 'integer' }, profileId: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.party',
      payload: { profileId: ctx.subject, name: ctx.body.name },
      apply: () => {
        const party = multiplayer.createParty(resolveProfile(ctx.body.profileId || ctx.subject, { create: true }), { name: ctx.body.name, maxMembers: ctx.body.maxMembers }, { actor: ctx.subject });
        return party;
      },
    }));

  router.post('/v1/multiplayer/parties/:partyId/join', {
    handler: 'multiplayer.party.join',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Join a party',
    summary: 'Capacity-checked, consent defaults off.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.party.join',
      payload: { partyId: ctx.params.partyId, profileId: ctx.subject },
      apply: () => multiplayer.joinParty(ctx.params.partyId, resolveProfile(ctx.body.profileId || ctx.subject, { create: true }), { actor: ctx.subject }),
    }));

  router.get('/v1/multiplayer/parties/:profileId', {
    handler: 'multiplayer.party.get',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Your party',
    summary: 'Active party for a profile (members, leader, safety floor).',
    scopes: ['entropy:read'],
  }, (ctx) => multiplayer.partyFor(resolveProfile(ctx.params.profileId, { create: true })) || { party: null, note: 'no active party' });

  router.post('/v1/multiplayer/raids', {
    handler: 'multiplayer.raid.create',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Create a co-op raid',
    summary: 'Difficulty derived from season index + mined terrain hazard + roster size. Roles are assigned from the squad recommender.',
    scopes: ['lobby:write'],
    risk: 'HIGH',
    body: { type: 'object', properties: { lobbyId: { type: 'string' }, difficulty: { type: 'integer' }, missionId: { type: 'string' }, seedNote: { type: 'string' } }, required: ['lobbyId'] },
  }, (ctx) =>
    gated(ctx, {
      risk: 'HIGH',
      kind: 'multiplayer.raid',
      payload: { lobbyId: ctx.body.lobbyId, raid: { difficulty: ctx.body.difficulty, missionId: ctx.body.missionId, seedNote: ctx.body.seedNote } },
      apply: () => multiplayer.createRaid(ctx.body.lobbyId, { difficulty: ctx.body.difficulty || null, missionId: ctx.body.missionId || null, seedNote: ctx.body.seedNote || null }, { actor: ctx.subject }),
    }));

  router.get('/v1/multiplayer/raids', {
    handler: 'multiplayer.raid.list',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'List raids',
    summary: 'Raids by status (assembling|running|resolved).',
    scopes: ['entropy:read'],
    query: [{ name: 'status', type: 'string' }],
  }, (ctx) => ({ raids: multiplayer.listRaids({ status: ctx.query.status || null, limit: clamp(Number(ctx.query.limit) || 20, 1, 100) }), phases: RAID_PHASES }));

  router.get('/v1/multiplayer/raids/:raidId', {
    handler: 'multiplayer.raid.get',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Raid detail',
    summary: 'Phase machine, roster with roles and companions, terrain, brief, log and rewards.',
    scopes: ['entropy:read'],
  }, (ctx) => multiplayer.getRaid(ctx.params.raidId));

  router.post('/v1/multiplayer/raids/:raidId/ready', {
    handler: 'multiplayer.raid.ready',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Ready up',
    summary: 'When the whole roster is ready the raid starts and phase 0 completes.',
    scopes: ['lobby:write'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' } } },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'multiplayer.raid.ready',
      payload: { raidId: ctx.params.raidId, profileId: ctx.subject },
      apply: () => multiplayer.readyUp(ctx.params.raidId, resolveProfile(ctx.body.profileId || ctx.subject, { create: true }), { actor: ctx.subject }),
    }));

  router.post('/v1/multiplayer/raids/:raidId/tick', {
    handler: 'multiplayer.raid.tick',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Advance a raid phase',
    summary: 'Deterministic phase resolution from (raidSeed, phase, squad capability vs difficulty pressure). Three costly phases ends the run.',
    scopes: ['lobby:write'],
    risk: 'MEDIUM',
    body: { type: 'object', properties: {} },
  }, (ctx) =>
    gated(ctx, {
      risk: 'MEDIUM',
      kind: 'multiplayer.raid.tick',
      payload: { raidId: ctx.params.raidId },
      apply: () => multiplayer.tickRaid(ctx.params.raidId, { actor: ctx.subject }),
    }));

  router.post('/v1/multiplayer/presence', {
    handler: 'multiplayer.presence.beat',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Presence heartbeat',
    summary: 'Positions are quantised to 25 m before storage. Presence expires after 5 minutes.',
    scopes: ['lobby:write'],
    risk: null,
    body: { type: 'object', properties: { lobbyId: { type: 'string' }, position: { type: 'object' }, profileId: { type: 'string' } } },
  }, (ctx) => multiplayer.heartbeat(resolveProfile(ctx.body.profileId || ctx.subject, { create: true }), { lobbyId: ctx.body.lobbyId || null, position: ctx.body.position || null }));

  router.get('/v1/multiplayer/presence', {
    handler: 'multiplayer.presence.list',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Presence list',
    summary: 'Who is online, pseudonymously, with consent flags.',
    scopes: ['entropy:read'],
    query: [{ name: 'lobbyId', type: 'string' }],
  }, (ctx) => ({ presence: multiplayer.presence({ lobbyId: ctx.query.lobbyId || null, limit: clamp(Number(ctx.query.limit) || 50, 1, 200) }) }));

  router.get('/v1/multiplayer/stats', {
    handler: 'multiplayer.stats',
    group: 'multiplayer',
    domain: 'multiplayer',
    title: 'Multiplayer stats',
    summary: 'Lobbies, members, average/min safety, parties, raids, reports, bans.',
    auth: false,
  }, () => multiplayer.stats());

  /* ══════════════════════ 10. REALITY MINING STACK ══════════════════════ */

  router.get('/v1/miners/consensus', {
    handler: 'miners.consensus',
    group: 'miners',
    domain: 'miners',
    title: 'Consensus parameters',
    summary: 'Every tunable in the mining stack, plus how difficulty and rewards work.',
    auth: false,
  }, () => ({
    consensus: { ...CONSENSUS, ...miners.C },
    explanation: {
      header: 'version · prevHash · height · timestamp · seedRoot · difficultyBits · miner · nonce',
      pow: 'sha256(canonical(header)) must have ≥ difficultyBits leading zero bits',
      difficulty: `retarget every ${miners.C.retargetInterval} blocks toward ${miners.C.targetBlockMs} ms, using the window median, clamped to ×2/÷2, within ${miners.C.minDifficultyBits}–${miners.C.maxDifficultyBits} bits`,
      shares: `pool share target = block target − ${miners.C.shareDifficultyOffset} bits (16× easier)`,
      reward: `subsidy ${miners.C.baseSubsidyRlu} RLU + ${miners.C.subsidyPerDifficultyBit} RLU per difficulty bit + Σ fragment RLU`,
      coinbase: 'reality fragments (scene, law, voice, terrain, artifact, glyph, weather, memory) — not currency',
      noHalving: 'there is deliberately no scarcity halving curve; content should get cheaper, not scarcer',
    },
    unit: { symbol: 'RLU', name: 'Reality Unit', monetary: false, transferableOffNetwork: false, market: null },
  }));

  router.get('/v1/miners/chain', {
    handler: 'miners.chain',
    group: 'miners',
    domain: 'miners',
    title: 'Reality chain',
    summary: 'Blocks newest-first with work, solve time, subsidy and reality summary.',
    scopes: ['entropy:read'],
    query: [{ name: 'limit', type: 'integer' }, { name: 'from', type: 'integer', note: 'height' }],
  }, (ctx) => miners.chain({ limit: clamp(Number(ctx.query.limit) || 20, 1, 200), from: ctx.query.from ? Number(ctx.query.from) : null }));

  router.get('/v1/miners/blocks/:heightOrHash', {
    handler: 'miners.block.get',
    group: 'miners',
    domain: 'miners',
    title: 'Block detail',
    summary: 'Full block: header, PoW, reality fragments with addresses, payouts.',
    scopes: ['entropy:read'],
  }, (ctx) => miners.getBlock(ctx.params.heightOrHash));

  router.post('/v1/miners/verify', {
    handler: 'miners.chain.verify',
    group: 'miners',
    domain: 'miners',
    title: 'Verify the chain',
    summary: 'Re-check every link, every proof-of-work and re-derive reality for a sample of blocks.',
    scopes: ['entropy:read'],
    risk: null,
    body: { type: 'object', properties: { sampleReality: { type: 'integer' } } },
  }, (ctx) => miners.verifyChain({ sampleReality: clamp(Number(ctx.body.sampleReality) || 8, 0, 50) }));

  router.get('/v1/miners/pool', {
    handler: 'miners.pool',
    group: 'miners',
    domain: 'miners',
    title: 'Pool state',
    summary: 'Workers, hashrate, shares, pending share weights, payouts, retarget history.',
    scopes: ['entropy:read'],
  }, (ctx) => miners.pool({ limit: clamp(Number(ctx.query.limit) || 20, 1, 100) }));

  router.post('/v1/miners/workers', {
    handler: 'miners.worker.register',
    group: 'miners',
    domain: 'miners',
    title: 'Register a miner worker',
    summary: 'Creates a worker identity (EX-MIN address) for pool or solo mining.',
    scopes: ['miner:work'],
    risk: 'LOW',
    body: { type: 'object', properties: { profileId: { type: 'string' }, workerId: { type: 'string' }, label: { type: 'string' }, pool: { type: 'boolean' } } },
    example: { label: 'laptop-01', pool: true },
  }, (ctx) =>
    gated(ctx, {
      risk: 'LOW',
      kind: 'miners.worker.register',
      payload: { profileId: ctx.subject, label: ctx.body.label },
      apply: () =>
        miners.registerWorker({
          workerId: ctx.body.workerId || null,
          profileId: resolveProfile(ctx.body.profileId || ctx.subject, { create: true }),
          label: ctx.body.label || null,
          pool: ctx.body.pool !== false,
        }, { actor: ctx.subject }),
    }));

  router.get('/v1/miners/work', {
    handler: 'miners.work.get',
    group: 'miners',
    domain: 'miners',
    title: 'Get mining work (long-poll)',
    summary: 'Stratum-shaped job: header template, block target, share target, expiry, reward preview.',
    scopes: ['miner:work'],
    query: [{ name: 'workerId', type: 'string' }, { name: 'profileId', type: 'string' }],
  }, (ctx) => miners.getWork({ workerId: ctx.query.workerId || null, profileId: ctx.query.profileId ? resolveProfile(ctx.query.profileId, { create: true }) : memory.getProfile(ctx.subject)?.profileId || ctx.subject, extraSeed: ctx.query.seed || null }));

  router.post('/v1/miners/submit', {
    handler: 'miners.work.submit',
    group: 'miners',
    domain: 'miners',
    title: 'Submit work',
    summary: 'Share or block. Stale jobs and moved tips are rejected with a precise reason and counted.',
    scopes: ['miner:work'],
    risk: 'LOW',
    body: {
      type: 'object',
      properties: { jobId: { type: 'string' }, nonce: { type: 'integer' }, workerId: { type: 'string' }, hashes: { type: 'integer' }, profileId: { type: 'string' } },
      required: ['jobId', 'nonce'],
    },
  }, (ctx) => {
    const beneficiary = ctx.body.profileId ? resolveProfile(ctx.body.profileId, { create: true }) : memory.getProfile(ctx.subject)?.profileId || ctx.subject;
    const result = miners.submitWork(
      { jobId: ctx.body.jobId, nonce: ctx.body.nonce, workerId: ctx.body.workerId || null, hashes: ctx.body.hashes || null, profileId: beneficiary },
      { actor: ctx.subject },
    );
    if (result.accepted && result.block && ctx.body.profileId) {
      // nothing extra: _acceptBlock already fanned out to memory/missions/weave
    }
    return result;
  });

  router.post('/v1/miners/mine', {
    handler: 'miners.mine.local',
    group: 'miners',
    domain: 'miners',
    title: 'Mine in-process',
    summary: 'Server-side mining for demos and the HUD: search nonces for a time budget and append real blocks.',
    scopes: ['miner:work'],
    risk: 'MEDIUM',
    body: {
      type: 'object',
      properties: { profileId: { type: 'string' }, seconds: { type: 'number', note: 'time budget, 1..120' }, blocks: { type: 'integer', note: 'stop after N blocks' }, workerId: { type: 'string' } },
    },
    example: { seconds: 3, blocks: 2 },
  }, (ctx) => {
    const profileId = resolveProfile(ctx.body.profileId || ctx.subject, { create: true });
    return gated(ctx, {
      risk: 'MEDIUM',
      kind: 'miners.mine',
      payload: { profileId, seconds: ctx.body.seconds, blocks: ctx.body.blocks },
      apply: () => miners.mineLocal({ profileId, seconds: clamp(Number(ctx.body.seconds) || 3, 1, 120), blocks: clamp(Number(ctx.body.blocks) || 1, 1, 10), workerId: ctx.body.workerId || null }),
    });
  });

  router.get('/v1/miners/wallet/:profileId', {
    handler: 'miners.wallet',
    group: 'miners',
    domain: 'miners',
    title: 'Reality wallet',
    summary: 'RLU balance, lifetime, ledger tail, artifacts and fragment custody. Non-monetary by design.',
    scopes: ['entropy:read'],
    query: [{ name: 'ledgerLimit', type: 'integer' }],
  }, (ctx) => miners.walletView(resolveProfile(ctx.params.profileId, { create: true }), { ledgerLimit: clamp(Number(ctx.query.ledgerLimit) || 25, 1, 200) }));

  router.get('/v1/miners/reality', {
    handler: 'miners.reality.library',
    group: 'miners',
    domain: 'miners',
    title: 'Reality library',
    summary: 'Every mined fragment grouped by kind — the content the world is made of.',
    scopes: ['entropy:read'],
    query: [{ name: 'kind', type: 'string' }, { name: 'limit', type: 'integer' }],
  }, (ctx) => (ctx.query.kind ? { kind: ctx.query.kind, fragments: miners.fragmentsByKind(ctx.query.kind, { limit: clamp(Number(ctx.query.limit) || 40, 1, 200) }) } : miners.library({ limitPerKind: clamp(Number(ctx.query.limit) || 6, 1, 20) })));

  router.get('/v1/miners/fragments/:address', {
    handler: 'miners.fragment.get',
    group: 'miners',
    domain: 'miners',
    title: 'Fragment detail',
    summary: 'One reality fragment by its EX-RLT address, with its source block.',
    scopes: ['entropy:read'],
  }, (ctx) => miners.getFragment(ctx.params.address));

  router.post('/v1/miners/fragments/derive', {
    handler: 'miners.fragment.derive',
    group: 'miners',
    domain: 'miners',
    title: 'Derive a fragment',
    summary: 'Preview the reality generator from any 64-hex digest without mining.',
    scopes: ['entropy:read'],
    risk: null,
    body: { type: 'object', properties: { hash: { type: 'string' }, index: { type: 'integer' }, kind: { type: 'string' } } },
  }, (ctx) => miners.deriveFragment({ hash: ctx.body.hash || null, index: Number(ctx.body.index) || 0, kind: ctx.body.kind || null }));

  router.get('/v1/miners/stats', {
    handler: 'miners.stats',
    group: 'miners',
    domain: 'miners',
    title: 'Mining stats',
    summary: 'Height, difficulty, hashrate, solve times, fragments, wallets, workers, retargets.',
    auth: false,
  }, () => miners.stats());

  /* ═══════════════════════ 11. ENTROPY CHROMIUM ═════════════════════════ */

  router.get('/v1/chromium/alloy', {
    handler: 'chromium.alloy',
    group: 'chromium',
    domain: 'chromium',
    title: 'Chromium alloy',
    summary: 'The generated material: hue triad, colours with contrast ratios, glass, elevation, type, motion and AR HUD spec.',
    auth: false,
    query: [
      { name: 'surface', type: 'string', enum: Object.keys(SURFACES) },
      { name: 'grade', type: 'string', enum: GRADES.map((g) => g.grade) },
      { name: 'seed', type: 'string', note: 'derive a per-player alloy' },
    ],
  }, (ctx) => {
    const { deriveAlloy } = require('../core/chromium');
    const alloy = ctx.query.surface || ctx.query.grade || ctx.query.seed
      ? deriveAlloy({ seed: ctx.query.seed || seed, surface: ctx.query.surface || 'bright', grade: ctx.query.grade || 'Cr-5' })
      : config.alloy();
    return { alloy, surfaces: SURFACES, grades: GRADES, cssUrl: '/v1/chromium/css' };
  });

  router.get('/v1/chromium/css', {
    handler: 'chromium.css',
    group: 'chromium',
    domain: 'chromium',
    title: 'Generated stylesheet',
    summary: 'CSS custom properties derived from the seed — the bright premium theme as data.',
    auth: false,
    query: [{ name: 'surface', type: 'string' }, { name: 'grade', type: 'string' }],
  }, (ctx) => {
    const { deriveAlloy, toCss } = require('../core/chromium');
    const alloy = ctx.query.surface || ctx.query.grade ? deriveAlloy({ seed, surface: ctx.query.surface || 'bright', grade: ctx.query.grade || 'Cr-5' }) : config.alloy();
    return { __raw: true, status: 200, body: toCss(alloy), extra: { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } } };
  });

  router.post('/v1/chromium/plate', {
    handler: 'chromium.plate',
    group: 'chromium',
    domain: 'chromium',
    title: 'Plate a payload',
    summary: 'Seal any JSON with an HMAC chrome plate. Clients verify it to prove origin and integrity.',
    scopes: ['entropy:read'],
    risk: null,
    body: { type: 'object', properties: { payload: { type: 'object' }, kind: { type: 'string' } } },
  }, (ctx) => {
    const { plate } = require('../core/chromium');
    if (!ctx.body.payload) throw toBadRequest('payload is required');
    return plate(ctx.body.payload, { seed, masterKey: keyring.masterKey, subject: ctx.subject, kind: ctx.body.kind || 'payload', grade: config.alloy().grade.grade });
  });

  router.post('/v1/chromium/verify-plate', {
    handler: 'chromium.verifyPlate',
    group: 'chromium',
    domain: 'chromium',
    title: 'Verify a plate',
    summary: 'Constant-time verification of a chrome plate against a payload.',
    scopes: ['entropy:read'],
    risk: null,
    body: { type: 'object', properties: { plate: { type: 'string' }, payload: { type: 'object' }, kind: { type: 'string' }, subject: { type: 'string' } } },
  }, (ctx) => {
    const { verifyPlate } = require('../core/chromium');
    if (!ctx.body.plate || !ctx.body.payload) throw toBadRequest('plate and payload are required');
    return verifyPlate(ctx.body.plate, ctx.body.payload, { masterKey: keyring.masterKey, subject: ctx.body.subject || ctx.subject, kind: ctx.body.kind || 'payload' });
  });

  router.post('/v1/chromium/derive-address', {
    handler: 'chromium.deriveAddress',
    group: 'chromium',
    domain: 'chromium',
    title: 'Derive an entropy address',
    summary: 'Public address derivation for any domain/label — the primitive behind every id in the system.',
    auth: false,
    body: {
      type: 'object',
      properties: { domain: { type: 'string', enum: Object.keys(require('../core/entropy-core').DOMAINS) }, label: { type: 'string' }, sublabel: { type: 'string' }, seed: { type: 'string' } },
      required: ['domain', 'label'],
    },
  }, (ctx) => deriveAddress({ domain: ctx.body.domain, seed: ctx.body.seed || seed, label: ctx.body.label, sublabel: ctx.body.sublabel || '' }));

  return router;
}

module.exports = { buildRouter };
