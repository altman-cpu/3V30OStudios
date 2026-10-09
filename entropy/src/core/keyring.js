'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KEYRING  —  key auth tokens with a SMART VALUE + the UNMASK (pending) pool
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  THE RULE THE COMMANDER ASKED FOR:
 *  "keep a key auth token with smart value on everything that has to be
 *   pending by code"
 *
 *  So every mutating operation declares a RISK (0..5). From that risk we
 *  compute a `requiredSmartValue`. The caller's token carries a *live* smart
 *  value that decays as the token ages. Then, in code, one of two things
 *  happens — automatically, never by hand:
 *
 *      liveSmartValue ≥ requiredSmartValue  →  AUTO-SEALED (committed now)
 *      liveSmartValue < requiredSmartValue  →  PENDING  (parked in the
 *                                              Unmask Pool with an expiry,
 *                                              a seal address and a co-sign
 *                                              threshold)
 *
 *  A pending seal is resolved by:
 *      • the same subject re-attesting with a stronger token, or
 *      • N co-signatures from other subjects (multi-attestation), or
 *      • an explicit `unmask` call by a holder with sufficient smart value.
 *
 *  When a seal clears we call it a GENESIS UNMASK: the parked effect is applied
 *  to canonical state and the journal records who unmasked it and why.
 *
 *  ── Smart value formula (documented so integrators can reason about it) ──
 *
 *      base  = 120·tierIndex + 45·|scopes∩opScopes| + 8·pendingBudget
 *              + 3·entropyCredits + 250·(root? 1:0)
 *      live  = floor( base · (0.55 + 0.45 · freshness) )
 *      freshness = clamp((exp − now)/ttl, 0, 1)
 *
 *  i.e. a fresh sovereign-root token is worth ~10× a stale observer token.
 *  The decay is deliberate: long-lived tokens lose authority, which bounds the
 *  blast radius of a leaked key without needing a revocation round-trip.
 *
 *  Token wire format (compact, stateless, verifiable offline):
 *
 *      entk.v1.<base64url(claimsJson)>.<base64url(HMAC-SHA256(masterKey))>
 */

const crypto = require('node:crypto');
const {
  deriveAddress,
  hmac,
  b64url,
  unb64url,
  safeEqual,
  clamp,
  nowIso,
  nowMs,
  hashHex,
  createRng,
  entropyPhrase,
} = require('./entropy-core');

/* ── scope catalogue ─────────────────────────────────────────────────────── */

const SCOPES = Object.freeze({
  'entropy:read': { weight: 1, note: 'read any entropy domain' },
  'memory:write': { weight: 2, note: 'Entropy Memory profile mutation' },
  'weave:write': { weight: 3, note: 'unlock / fuse abilities' },
  'ar:write': { weight: 2, note: 'create scan sessions and anchors' },
  'squad:write': { weight: 2, note: 'companion tactic training' },
  'mission:write': { weight: 2, note: 'accept / complete missions' },
  'lobby:write': { weight: 3, note: 'create lobbies, parties, raids' },
  'miner:work': { weight: 2, note: 'request work and submit shares/blocks' },
  'unmask:seal': { weight: 5, note: 'resolve pending seals (genesis unmask)' },
  'admin:root': { weight: 9, note: 'keyring, config, network control' },
});

const ALL_SCOPES = Object.freeze(Object.keys(SCOPES));
const READ_SCOPES = Object.freeze(['entropy:read']);

/** Identity tiers: the multiplier that makes a token "smart". */
const TIERS = Object.freeze([
  { index: 0, id: 'guest', label: 'Guest', smartMultiplier: 0.35, note: 'lobby spectator, read-only HUD' },
  { index: 1, id: 'observer', label: 'Observer', smartMultiplier: 0.6, note: 'read + scan' },
  { index: 2, id: 'operator', label: 'Operator', smartMultiplier: 1, note: 'standard player / integrator' },
  { index: 3, id: 'weaver', label: 'Weaver', smartMultiplier: 1.6, note: 'power-weave authority' },
  { index: 4, id: 'architect', label: 'Architect', smartMultiplier: 2.4, note: 'missions, seasons, events' },
  { index: 5, id: 'sovereign', label: 'Sovereign', smartMultiplier: 3.6, note: 'unmask + network control' },
]);

/** Risk ladder: every write endpoint declares one of these. */
const RISK = Object.freeze({
  NONE: { level: 0, required: 0, label: 'open', note: 'reads, derived content' },
  LOW: { level: 1, required: 180, label: 'low', note: 'profile-scoped writes' },
  MEDIUM: { level: 2, required: 420, label: 'medium', note: 'shared-world writes' },
  HIGH: { level: 3, required: 900, label: 'high', note: 'economy / weave / raids' },
  SEVERE: { level: 4, required: 1600, label: 'severe', note: 'seasons, world events' },
  GENESIS: { level: 5, required: 2600, label: 'genesis', note: 'keyring, network config' },
});

/* ─────────────────────────────── keyring ─────────────────────────────── */

class Keyring {
  /**
   * @param {object} opts
   * @param {import('./vault').Vault} opts.vault
   * @param {string} opts.genesisSeed
   * @param {string} [opts.masterKey]      override (env ENTROPY_MASTER_KEY)
   * @param {number} [opts.pendingTtlMs]   default expiry for a parked seal
   * @param {(e:object)=>void} [opts.onEvent]
   */
  constructor({ vault, genesisSeed, masterKey = null, pendingTtlMs = 30 * 60 * 1000, onEvent = null }) {
    this.vault = vault;
    this.genesisSeed = genesisSeed;
    this.pendingTtlMs = pendingTtlMs;
    this.onEvent = onEvent;

    const stored = vault.readKeyring();
    if (masterKey) {
      this.masterKey = Buffer.from(masterKey, 'utf8');
      this.keyId = hashHex('keyid', this.masterKey).slice(0, 16);
      vault.writeKeyring({ keyId: this.keyId, source: 'env', createdAt: stored?.createdAt || nowIso(), note: 'master key supplied by environment; secret not stored' });
    } else if (stored?.masterKey) {
      this.masterKey = Buffer.from(stored.masterKey, 'hex');
      this.keyId = stored.keyId;
    } else {
      this.masterKey = crypto.randomBytes(32);
      this.keyId = hashHex('keyid', this.masterKey).slice(0, 16);
      vault.writeKeyring({
        keyId: this.keyId,
        masterKey: this.masterKey.toString('hex'),
        source: 'generated',
        createdAt: nowIso(),
        fingerprint: hashHex('fingerprint', this.masterKey).slice(0, 32),
        warning: 'Local development key. In production set ENTROPY_MASTER_KEY from a secrets manager.',
      });
    }

    this.subjectAddress = deriveAddress({ domain: 'KEY', seed: genesisSeed, label: 'root', sublabel: this.keyId });
  }

  /* ───────────────────────────── smart value ─────────────────────────── */

  /**
   * Base smart value of a claim set (no decay).
   * @param {object} claims
   * @param {string[]} [opScopes] scopes required by the operation being attempted
   */
  baseSmartValue(claims, opScopes = []) {
    const tier = TIERS.find((t) => t.id === claims.tier) || TIERS[2];
    const scopeHits = new Set(opScopes).size
      ? opScopes.filter((s) => (claims.scopes || []).includes(s)).length
      : (claims.scopes || []).length;

    let base =
      120 * tier.index * tier.smartMultiplier +
      45 * scopeHits +
      8 * Number(claims.pendingBudget || 0) +
      3 * Number(claims.entropyCredits || 0);

    if ((claims.scopes || []).includes('admin:root')) base += 250;
    if (claims.root) base += 400;
    return Math.floor(clamp(base, 0, 99_999));
  }

  /** Live smart value: base × freshness decay. */
  liveSmartValue(claims, opScopes = [], now = nowMs()) {
    const base = this.baseSmartValue(claims, opScopes);
    const ttl = Math.max(1, Number(claims.exp || 0) - Number(claims.iat || 0));
    const remaining = Number(claims.exp || 0) - now;
    const freshness = clamp(remaining / ttl, 0, 1);
    return Math.floor(base * (0.55 + 0.45 * freshness));
  }

  /* ────────────────────────────── token issue ────────────────────────── */

  /**
   * Issue a signed key auth token.
   * @param {object} opts
   * @param {string} opts.subject              player / integration id
   * @param {string[]} [opts.scopes]
   * @param {string} [opts.tier]               TIERS id
   * @param {number} [opts.ttlSeconds]
   * @param {number} [opts.entropyCredits]     mined reality credits
   * @param {number} [opts.pendingBudget]      how many seals may be parked
   * @param {object} [opts.meta]               free-form (device, integration…)
   * @param {boolean} [opts.root]
   */
  issueToken({
    subject,
    scopes = READ_SCOPES,
    tier = 'operator',
    ttlSeconds = 60 * 60,
    entropyCredits = 0,
    pendingBudget = 3,
    meta = {},
    root = false,
  }) {
    if (!subject) throw new Error('issueToken requires a subject');
    const unknown = scopes.filter((s) => !SCOPES[s]);
    if (unknown.length) throw new Error(`unknown scope(s): ${unknown.join(', ')}`);
    if (!TIERS.some((t) => t.id === tier)) throw new Error(`unknown tier: ${tier}`);

    const iat = nowMs();
    const exp = iat + Math.max(30, ttlSeconds) * 1000;
    const jti = hashHex('jti', subject, iat, crypto.randomBytes(8).toString('hex')).slice(0, 24);

    const claims = {
      v: 1,
      sub: String(subject),
      addr: deriveAddress({ domain: 'KEY', seed: this.genesisSeed, label: subject, sublabel: tier }).address,
      scopes: scopes.slice().sort(),
      tier,
      root: Boolean(root),
      iat,
      exp,
      jti,
      kid: this.keyId,
      entropyCredits: Number(entropyCredits) || 0,
      pendingBudget: Number(pendingBudget) || 0,
      meta,
    };
    claims.sv = this.baseSmartValue(claims);
    claims.svLive = claims.sv; // refreshed on verify

    const payload = b64url(JSON.stringify(claims));
    const sig = b64url(hmac(this.masterKey, 'entk.v1', payload));
    return {
      token: `entk.v1.${payload}.${sig}`,
      claims,
      address: claims.addr,
      smartValue: claims.sv,
      expiresAt: new Date(exp).toISOString(),
      entropyPhrase: entropyPhrase(`${this.genesisSeed}|${subject}|${jti}`, 3),
    };
  }

  /**
   * Verify a token and compute its live smart value.
   * @returns {{valid:boolean, reason?:string, code?:string, claims?:object, smartValue?:number, baseValue?:number, fresh?:boolean}}
   */
  verifyToken(token, opScopes = [], now = nowMs()) {
    if (!token || typeof token !== 'string') return { valid: false, code: 'token_missing', reason: 'no bearer token supplied' };
    const parts = token.trim().split('.');
    if (parts.length !== 4 || parts[0] !== 'entk' || parts[1] !== 'v1') {
      return { valid: false, code: 'token_malformed', reason: 'expected entk.v1.<payload>.<signature>' };
    }
    const [, , payload, sig] = parts;
    const expected = b64url(hmac(this.masterKey, 'entk.v1', payload));
    if (!safeEqual(expected, sig)) return { valid: false, code: 'token_signature', reason: 'signature mismatch' };

    let claims;
    try {
      claims = JSON.parse(unb64url(payload).toString('utf8'));
    } catch {
      return { valid: false, code: 'token_payload', reason: 'payload is not valid JSON' };
    }
    if (claims.kid && claims.kid !== this.keyId) {
      return { valid: false, code: 'token_key_rotation', reason: `signed by retired key ${claims.kid}` };
    }
    if (Number(claims.exp) <= now) {
      return { valid: false, code: 'token_expired', reason: 'token expired', claims };
    }
    const missing = opScopes.filter((s) => !(claims.scopes || []).includes(s));
    if (missing.length) {
      return { valid: false, code: 'token_scope', reason: `missing scope(s): ${missing.join(', ')}`, claims };
    }

    const baseValue = this.baseSmartValue(claims, opScopes);
    const smartValue = this.liveSmartValue(claims, opScopes, now);
    claims.svLive = smartValue;
    return {
      valid: true,
      claims,
      smartValue,
      baseValue,
      fresh: Number(claims.exp) - now > 0.5 * (Number(claims.exp) - Number(claims.iat)),
      expiresInMs: Number(claims.exp) - now,
    };
  }

  /* ─────────────────────────── pending / unmask pool ─────────────────── */

  /** Instance accessor so handlers never touch the class directly. */
  requiredFor(risk) {
    return Keyring.requiredFor(risk);
  }

  /** Required smart value for an operation risk level. */
  static requiredFor(risk) {
    const key = typeof risk === 'string' ? risk.toUpperCase() : 'NONE';
    return (RISK[key] || RISK.NONE).required;
  }

  /** How many co-signatures a parked seal needs before it can unmask. */
  static coSignThreshold(requiredSmartValue) {
    if (requiredSmartValue >= RISK.GENESIS.required) return 3;
    if (requiredSmartValue >= RISK.HIGH.required) return 2;
    if (requiredSmartValue >= RISK.MEDIUM.required) return 2;
    return 1;
  }

  _pendingState() {
    return this.vault.read('pending', { seals: {}, index: [] });
  }

  /**
   * Park an effect in the Unmask Pool.
   * @param {object} opts
   * @param {string} opts.kind            e.g. 'weave.fuse'
   * @param {object} opts.payload         the effect to apply once unmasked
   * @param {object} [opts.claims]        requesting token claims
   * @param {number} [opts.requiredSmartValue]
   * @param {string} [opts.handler]       content-handler address
   * @param {string} [opts.reason]
   * @param {number} [opts.ttlMs]
   */
  parkPending({ kind, payload, claims = null, requiredSmartValue = 0, handler = null, reason = null, ttlMs = null }) {
    const state = this._pendingState();
    const subject = claims?.sub || 'anonymous';
    const sealId = hashHex('seal', kind, subject, nowMs(), crypto.randomBytes(6).toString('hex')).slice(0, 20);
    const seal = {
      sealId,
      address: deriveAddress({ domain: 'PND', seed: this.genesisSeed, label: sealId, sublabel: kind }).address,
      kind,
      handler,
      subject,
      subjectAddress: claims?.addr || null,
      tier: claims?.tier || null,
      payloadHash: hashHex('payload', JSON.stringify(payload || {})),
      payload: payload || {},
      requiredSmartValue,
      offeredSmartValue: claims ? this.liveSmartValue(claims) : 0,
      coSignatures: claims ? [{ subject, at: nowIso(), smartValue: this.liveSmartValue(claims) }] : [],
      coSignRequired: Keyring.coSignThreshold(requiredSmartValue),
      status: 'pending',
      reason,
      createdAt: nowIso(),
      expiresAt: new Date(nowMs() + (ttlMs || this.pendingTtlMs)).toISOString(),
      unmaskedAt: null,
      unmaskedBy: null,
    };
    state.seals[sealId] = seal;
    state.index = [sealId, ...state.index.filter((id) => id !== sealId)].slice(0, 500);
    this.vault.write('pending', state, { actor: subject, kind: 'pending.park', handler, reason: `smart value ${seal.offeredSmartValue} < ${requiredSmartValue}` });
    if (this.onEvent) this.onEvent({ type: 'pending.parked', payload: publicSeal(seal) });
    return seal;
  }

  /** List seals with optional filters. */
  listPending({ subject = null, status = null, limit = 50 } = {}) {
    const state = this._pendingState();
    const now = nowMs();
    return state.index
      .map((id) => state.seals[id])
      .filter(Boolean)
      .map((seal) => {
        if (seal.status === 'pending' && Date.parse(seal.expiresAt) <= now) {
          return { ...seal, status: 'expired' };
        }
        return seal;
      })
      .filter((seal) => (subject ? seal.subject === subject : true))
      .filter((seal) => (status ? seal.status === status : true))
      .slice(0, limit)
      .map(publicSeal);
  }

  getPending(sealId) {
    const state = this._pendingState();
    const seal = state.seals[sealId];
    return seal ? publicSeal(seal) : null;
  }

  /**
   * Add a co-signature to a parked seal. Auto-unmasks when the threshold and
   * the aggregate smart value are both satisfied.
   */
  coSign(sealId, claims, note = null) {
    const state = this._pendingState();
    const seal = state.seals[sealId];
    if (!seal) return { ok: false, code: 'seal_not_found' };
    if (seal.status === 'expired' || (seal.status === 'pending' && Date.parse(seal.expiresAt) <= nowMs())) {
      seal.status = 'expired';
      this.vault.write('pending', state, { actor: claims?.sub || 'system', kind: 'pending.expire' });
      return { ok: false, code: 'seal_expired' };
    }
    if (seal.status !== 'pending') return { ok: false, code: 'seal_closed', detail: seal.status };
    const smartValue = this.liveSmartValue(claims);
    const existing = seal.coSignatures.find((c) => c.subject === claims.sub);
    if (existing) {
      existing.smartValue = Math.max(existing.smartValue, smartValue);
      existing.at = nowIso();
      existing.note = note || existing.note;
    } else {
      seal.coSignatures.push({ subject: claims.sub, address: claims.addr, tier: claims.tier, smartValue, at: nowIso(), note });
    }
    const aggregate = seal.coSignatures.reduce((sum, c) => sum + c.smartValue, 0);
    seal.aggregateSmartValue = aggregate;
    this.vault.write('pending', state, { actor: claims.sub, kind: 'pending.cosign', reason: note });
    if (this.onEvent) this.onEvent({ type: 'pending.cosigned', payload: publicSeal(seal) });

    if (seal.coSignatures.length >= seal.coSignRequired && aggregate >= seal.requiredSmartValue) {
      return { ok: true, ready: true, seal: publicSeal(seal) };
    }
    return {
      ok: true,
      ready: false,
      seal: publicSeal(seal),
      missing: {
        signatures: Math.max(0, seal.coSignRequired - seal.coSignatures.length),
        smartValue: Math.max(0, seal.requiredSmartValue - aggregate),
      },
    };
  }

  /**
   * Mark a seal unmasked (committed). The caller supplies the applier.
   * @param {string} sealId
   * @param {object} claims
   * @param {(seal:object)=>any} applier
   */
  unmask(sealId, claims, applier, { note = null } = {}) {
    const state = this._pendingState();
    const seal = state.seals[sealId];
    if (!seal) return { ok: false, code: 'seal_not_found' };
    if (seal.status === 'unmasked') return { ok: false, code: 'seal_already_unmasked' };
    if (seal.status === 'expired' || Date.parse(seal.expiresAt) <= nowMs()) {
      seal.status = 'expired';
      this.vault.write('pending', state, { actor: claims?.sub || 'system', kind: 'pending.expire' });
      return { ok: false, code: 'seal_expired' };
    }
    if (seal.status !== 'pending') {
      // voided / failed seals are terminal — not even root may re-open one.
      return { ok: false, code: 'seal_closed', detail: seal.status };
    }

    const authority = this.liveSmartValue(claims);
    const aggregate = seal.coSignatures.reduce((sum, c) => sum + c.smartValue, 0);
    const signaturesOk = seal.coSignatures.length >= seal.coSignRequired || claims?.sub === seal.subject;
    const valueOk = authority >= seal.requiredSmartValue || aggregate >= seal.requiredSmartValue;
    const rootOverride = Boolean(claims?.root) && (claims.scopes || []).includes('unmask:seal');

    if (!(valueOk && signaturesOk) && !rootOverride) {
      return {
        ok: false,
        code: 'unmask_insufficient',
        detail: {
          authority,
          aggregate,
          required: seal.requiredSmartValue,
          signatures: seal.coSignatures.length,
          signaturesRequired: seal.coSignRequired,
          rootOverride,
        },
      };
    }

    let result = null;
    try {
      result = applier(seal);
    } catch (err) {
      seal.status = 'failed';
      seal.failure = { message: err.message, at: nowIso() };
      this.vault.write('pending', state, { actor: claims?.sub || 'system', kind: 'pending.failed' });
      if (this.onEvent) this.onEvent({ type: 'pending.failed', payload: publicSeal(seal) });
      return { ok: false, code: 'unmask_apply_failed', detail: err.message };
    }

    seal.status = 'unmasked';
    seal.unmaskedAt = nowIso();
    seal.unmaskedBy = claims?.sub || 'system';
    seal.unmaskAuthority = authority;
    seal.unmaskNote = note;
    seal.result = result && typeof result === 'object' ? result : { value: result ?? null };
    this.vault.write('pending', state, { actor: claims?.sub || 'system', kind: 'pending.unmask', reason: note });
    if (this.onEvent) this.onEvent({ type: 'pending.unmasked', payload: publicSeal(seal) });
    return { ok: true, seal: publicSeal(seal), result };
  }

  /** Reject / void a parked seal. */
  voidPending(sealId, claims, reason = 'voided') {
    const state = this._pendingState();
    const seal = state.seals[sealId];
    if (!seal) return { ok: false, code: 'seal_not_found' };
    if (seal.status !== 'pending') return { ok: false, code: 'seal_closed', detail: seal.status };
    seal.status = 'voided';
    seal.voidReason = reason;
    seal.voidedBy = claims?.sub || 'system';
    seal.voidedAt = nowIso();
    this.vault.write('pending', state, { actor: claims?.sub || 'system', kind: 'pending.void', reason });
    if (this.onEvent) this.onEvent({ type: 'pending.voided', payload: publicSeal(seal) });
    return { ok: true, seal: publicSeal(seal) };
  }

  /** Sweep expired seals. Returns the number retired. */
  sweepExpired() {
    const state = this._pendingState();
    const now = nowMs();
    let retired = 0;
    for (const id of state.index) {
      const seal = state.seals[id];
      if (seal && seal.status === 'pending' && Date.parse(seal.expiresAt) <= now) {
        seal.status = 'expired';
        seal.expiredAt = nowIso();
        retired += 1;
      }
    }
    if (retired) this.vault.write('pending', state, { actor: 'system', kind: 'pending.sweep', reason: `${retired} expired` });
    return retired;
  }

  /** Pool summary for the HUD. */
  stats() {
    const state = this._pendingState();
    const now = nowMs();
    const buckets = { pending: 0, unmasked: 0, expired: 0, voided: 0, failed: 0 };
    let outstandingValue = 0;
    for (const seal of Object.values(state.seals)) {
      const status = seal.status === 'pending' && Date.parse(seal.expiresAt) <= now ? 'expired' : seal.status;
      buckets[status] = (buckets[status] || 0) + 1;
      if (status === 'pending') outstandingValue += Math.max(0, seal.requiredSmartValue - (seal.aggregateSmartValue || seal.offeredSmartValue || 0));
    }
    return { total: Object.values(state.seals).length, ...buckets, outstandingValue };
  }

  /** Deterministic bootstrap token for local development / first run. */
  bootstrapToken({ subject = 'commander', ttlSeconds = 60 * 60 * 12 } = {}) {
    return this.issueToken({
      subject,
      scopes: ALL_SCOPES,
      tier: 'sovereign',
      ttlSeconds,
      entropyCredits: 1200,
      pendingBudget: 12,
      root: true,
      meta: { bootstrap: true, note: 'Genesis Unmask development authority' },
    });
  }
}

/** Strip private material from a seal before it leaves the process. */
function publicSeal(seal) {
  if (!seal) return null;
  const { payload, ...rest } = seal;
  return {
    ...rest,
    payloadPreview: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : null,
    payload,
  };
}

module.exports = {
  Keyring,
  SCOPES,
  ALL_SCOPES,
  READ_SCOPES,
  TIERS,
  RISK,
  publicSeal,
};
