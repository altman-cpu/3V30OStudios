/**
 * keyring.test.js — the key auth token with a *smart value*, and the Unmask
 * Pool that holds everything pending.
 *
 *   node --test entropy/test/keyring.test.js
 *
 * Covers: token wire format + verification failures (signature, expiry, scope,
 * key rotation), the documented smart-value formula and its freshness decay,
 * the risk ladder / co-sign thresholds, and the full pending lifecycle
 * park → co-sign → unmask (with dispatch), void, expire and apply-failure.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Vault } = require('../src/core/vault');
const { Keyring, ALL_SCOPES, RISK, TIERS, SCOPES } = require('../src/core/keyring');

const SEED = 'entropy-unit-test-genesis-seed';

function harness(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-keyring-'));
  const vault = new Vault({ root });
  const events = [];
  const keyring = new Keyring({
    vault,
    genesisSeed: SEED,
    masterKey: opts.masterKey || 'unit-test-master-key-0001',
    pendingTtlMs: opts.pendingTtlMs ?? 60_000,
    onEvent: (e) => events.push(e),
  });
  return { root, vault, keyring, events };
}

const weak = (kr, subject = 'scout') =>
  kr.issueToken({ subject, scopes: ['entropy:read'], tier: 'observer', ttlSeconds: 900, pendingBudget: 2 }).claims;

const strong = (kr, subject = 'commander') =>
  kr.issueToken({
    subject,
    scopes: ALL_SCOPES,
    tier: 'sovereign',
    ttlSeconds: 3600,
    entropyCredits: 900,
    pendingBudget: 12,
    root: true,
  }).claims;

/* ────────────────────────────── token format ──────────────────────────── */

test('keyring: issueToken produces a verifiable entk.v1 token', () => {
  const { keyring } = harness();
  const issued = keyring.issueToken({
    subject: 'ada',
    scopes: ['entropy:read', 'memory:write'],
    tier: 'operator',
    ttlSeconds: 600,
    entropyCredits: 12,
    pendingBudget: 3,
    meta: { device: 'hud' },
  });

  assert.match(issued.token, /^entk\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'compact, stateless wire format');
  assert.match(issued.address, /^EX-KEY-/, 'every token subject gets an entropy address');
  assert.equal(issued.claims.sub, 'ada');
  assert.deepEqual(issued.claims.scopes, ['entropy:read', 'memory:write'], 'scopes are canonicalised (sorted)');
  assert.equal(issued.claims.meta.device, 'hud');
  assert.ok(issued.smartValue > 0);
  assert.equal(typeof issued.entropyPhrase, 'string');

  const verified = keyring.verifyToken(issued.token);
  assert.equal(verified.valid, true);
  assert.equal(verified.claims.sub, 'ada');
  assert.equal(verified.baseValue, issued.smartValue, 'a fresh token lives at its base value');
  assert.equal(verified.fresh, true);
  assert.ok(verified.expiresInMs > 0);
});

test('keyring: token validation rejects every tamper path', () => {
  const { keyring } = harness();
  const { token } = keyring.issueToken({ subject: 'ada', scopes: ['entropy:read'], tier: 'operator', ttlSeconds: 600 });

  assert.equal(keyring.verifyToken(null).code, 'token_missing');
  assert.equal(keyring.verifyToken('').code, 'token_missing');
  assert.equal(keyring.verifyToken('nonsense').code, 'token_malformed');
  assert.equal(keyring.verifyToken('entk.v2.aaa.bbb').code, 'token_malformed');

  const flipped = `${token.slice(0, -2)}${token.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  assert.equal(keyring.verifyToken(flipped).code, 'token_signature', 'signature is checked before anything else');

  assert.equal(keyring.verifyToken(token, [], Date.now() + 3_600_000).code, 'token_expired');
  assert.equal(keyring.verifyToken(token, ['admin:root']).code, 'token_scope');
  assert.equal(keyring.verifyToken(token, ['entropy:read']).valid, true, 'held scope passes');

  // A different master key = a different keyId = retired authority.
  const { keyring: rotated } = harness({ masterKey: 'unit-test-master-key-0002' });
  const other = rotated.verifyToken(token);
  assert.equal(other.valid, false);
  assert.ok(['token_key_rotation', 'token_signature'].includes(other.code), `got ${other.code}`);
});

/* ────────────────────────────── smart value ───────────────────────────── */

test('keyring: smart value follows the documented formula and decays with age', () => {
  const { keyring } = harness();
  const issued = keyring.issueToken({
    subject: 'weaver-one',
    scopes: ['entropy:read', 'weave:write', 'unmask:seal'],
    tier: 'weaver',
    ttlSeconds: 1000,
    entropyCredits: 40,
    pendingBudget: 5,
  });
  const claims = issued.claims;
  const tier = TIERS.find((t) => t.id === claims.tier);

  const expected =
    120 * tier.index * tier.smartMultiplier +
    45 * claims.scopes.length + // all held scopes count when opScopes is empty
    8 * claims.pendingBudget +
    3 * claims.entropyCredits;
  assert.equal(keyring.baseSmartValue(claims), Math.floor(expected));

  // Only the scopes the operation actually needs are scored.
  const scoped = keyring.baseSmartValue(claims, ['weave:write']);
  assert.equal(scoped, Math.floor(expected - 45 * 2), 'unused scopes are not credit');

  // Freshness decay: live = floor(base * (0.55 + 0.45 * remaining/ttl)).
  const atIssue = keyring.liveSmartValue(claims, [], claims.iat);
  const halfLife = keyring.liveSmartValue(claims, [], claims.iat + (claims.exp - claims.iat) / 2);
  const stale = keyring.liveSmartValue(claims, [], claims.exp);
  assert.equal(atIssue, claims.sv);
  assert.ok(halfLife < atIssue && halfLife > stale, 'authority bleeds off over the token lifetime');
  assert.equal(stale, Math.floor(claims.sv * 0.55), 'an expired-but-unsigned token still floors at 55%');
});

test('keyring: tiers order strictly and root adds a fixed bonus', () => {
  const { keyring } = harness();
  const values = TIERS.map((t) => {
    const issued = keyring.issueToken({ subject: `s-${t.id}`, scopes: ['entropy:read'], tier: t.id, ttlSeconds: 600 });
    return { id: t.id, value: keyring.baseSmartValue(issued.claims) };
  });
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i].value > values[i - 1].value, `${values[i].id} must outrank ${values[i - 1].id}`);
  }

  const plain = keyring.issueToken({ subject: 'rootless', scopes: ['admin:root'], tier: 'operator', ttlSeconds: 600, root: false });
  const rooted = keyring.issueToken({ subject: 'rootless', scopes: ['admin:root'], tier: 'operator', ttlSeconds: 600, root: true });
  assert.equal(
    keyring.baseSmartValue(rooted.claims) - keyring.baseSmartValue(plain.claims),
    400,
    'root flag is worth exactly +400',
  );

  assert.throws(() => keyring.issueToken({ subject: 'x', scopes: ['nope:nope'] }), /unknown scope/);
  assert.throws(() => keyring.issueToken({ subject: 'x', tier: 'emperor' }), /unknown tier/);
  assert.throws(() => keyring.issueToken({ scopes: ['entropy:read'] }), /requires a subject/);
  assert.ok(Object.keys(SCOPES).length === ALL_SCOPES.length);
});

test('keyring: bootstrap authority clears the GENESIS risk gate', () => {
  const { keyring } = harness();
  const boot = keyring.bootstrapToken();
  assert.equal(boot.claims.root, true);
  assert.equal(boot.claims.tier, 'sovereign');
  assert.deepEqual(boot.claims.scopes, ALL_SCOPES.slice().sort(), 'bootstrap holds every scope');
  assert.ok(boot.smartValue >= RISK.GENESIS.required, `bootstrap ${boot.smartValue} >= genesis ${RISK.GENESIS.required}`);
});

test('keyring: risk ladder is monotonic and co-sign thresholds step 1/2/2/3', () => {
  const ladder = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'SEVERE', 'GENESIS'].map((k) => RISK[k]);
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i].level > ladder[i - 1].level);
    assert.ok(ladder[i].required > ladder[i - 1].required);
  }
  assert.equal(Keyring.requiredFor('HIGH'), 900);
  assert.equal(Keyring.requiredFor('high'), 900, 'case-insensitive');
  assert.equal(Keyring.requiredFor('unknown'), 0, 'unknown risk falls back to open');

  assert.equal(Keyring.coSignThreshold(RISK.LOW.required), 1);
  assert.equal(Keyring.coSignThreshold(RISK.MEDIUM.required), 2);
  assert.equal(Keyring.coSignThreshold(RISK.HIGH.required), 2);
  assert.equal(Keyring.coSignThreshold(RISK.GENESIS.required), 3);
});

/* ─────────────────────────── pending / unmask pool ────────────────────── */

test('keyring: park → co-sign → unmask dispatches the parked effect exactly once', () => {
  const { keyring, vault, events } = harness();
  const requester = weak(keyring, 'scout');
  const required = RISK.HIGH.required; // 900

  const seal = keyring.parkPending({
    kind: 'weave.fuse',
    payload: { profileId: 'p1', abilities: ['kinetic.surge', 'aegis.ward'] },
    claims: requester,
    requiredSmartValue: required,
    handler: 'EX-HND-test',
    reason: 'smart value below HIGH risk gate',
  });

  assert.equal(seal.status, 'pending');
  assert.match(seal.address, /^EX-PND-/, 'every parked effect gets its own address');
  assert.equal(seal.coSignRequired, 2, 'HIGH risk needs two attestations');
  assert.equal(seal.coSignatures.length, 1, 'the requester is the first signer');
  assert.ok(seal.offeredSmartValue < required, 'that is why it parked');
  assert.match(seal.payloadHash, /^[0-9a-f]{64}$/);

  // Weak authority cannot unmask, and cannot self-clear a two-signature seal.
  const refused = keyring.unmask(seal.sealId, requester, () => ({ applied: true }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'unmask_insufficient');
  assert.equal(refused.detail.required, required);

  const first = keyring.coSign(seal.sealId, weak(keyring, 'pilot'), 'second opinion');
  assert.equal(first.ok, true);
  assert.equal(first.ready, false);
  assert.equal(first.missing.signatures, 0);
  assert.ok(first.missing.smartValue > 0, 'signatures alone are not enough');

  const second = keyring.coSign(seal.sealId, strong(keyring, 'commander'), 'sovereign attestation');
  assert.equal(second.ready, true, 'threshold + aggregate smart value both met');

  let applied = null;
  const outcome = keyring.unmask(seal.sealId, strong(keyring, 'commander'), (s) => {
    applied = s.payload;
    return { applied: true, fusionId: 'f-1' };
  }, { note: 'genesis unmask' });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.seal.status, 'unmasked');
  assert.equal(outcome.seal.unmaskedBy, 'commander');
  assert.equal(outcome.seal.unmaskNote, 'genesis unmask');
  assert.deepEqual(outcome.result, { applied: true, fusionId: 'f-1' });
  assert.deepEqual(applied, seal.payload, 'the applier receives the parked effect verbatim');

  // Idempotent: a second unmask must not re-apply.
  const again = keyring.unmask(seal.sealId, strong(keyring, 'commander'), () => ({ applied: 'again' }));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'seal_already_unmasked');

  const listed = keyring.listPending({ subject: 'scout' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'unmasked');
  assert.equal(keyring.getPending(seal.sealId).status, 'unmasked');
  assert.equal(keyring.getPending('does-not-exist'), null);
  assert.deepEqual(keyring.stats().unmasked, 1);

  const kinds = vault.tail(200).map((e) => e.kind);
  assert.ok(kinds.includes('pending.park'));
  assert.ok(kinds.includes('pending.cosign'));
  assert.ok(kinds.includes('pending.unmask'));
  assert.ok(events.some((e) => e.type === 'pending.unmasked'));
});

test('keyring: a root token overrides the co-sign threshold', () => {
  const { keyring } = harness();
  const seal = keyring.parkPending({
    kind: 'missions.season.advance',
    payload: { season: 6 },
    claims: weak(keyring, 'scout'),
    requiredSmartValue: RISK.GENESIS.required,
  });
  assert.equal(seal.coSignRequired, 3);

  const outcome = keyring.unmask(seal.sealId, strong(keyring, 'commander'), () => ({ season: 6 }), { note: 'root override' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.seal.unmaskAuthority >= RISK.GENESIS.required, true);
});

test('keyring: void closes a seal permanently', () => {
  const { keyring, events } = harness();
  const seal = keyring.parkPending({ kind: 'lobby.create', payload: {}, claims: weak(keyring), requiredSmartValue: RISK.MEDIUM.required });

  const voided = keyring.voidPending(seal.sealId, weak(keyring, 'moderator'), 'duplicate request');
  assert.equal(voided.ok, true);
  assert.equal(voided.seal.status, 'voided');
  assert.equal(voided.seal.voidReason, 'duplicate request');

  assert.equal(keyring.coSign(seal.sealId, strong(keyring)).code, 'seal_closed');
  assert.equal(keyring.unmask(seal.sealId, strong(keyring), () => null).code, 'seal_closed');
  assert.equal(keyring.voidPending(seal.sealId, strong(keyring)).code, 'seal_closed');
  assert.equal(keyring.stats().voided, 1);
  assert.ok(events.some((e) => e.type === 'pending.voided'));
});

test('keyring: expired seals are listed as expired, swept, and cannot be signed', () => {
  const { keyring } = harness();
  const seal = keyring.parkPending({
    kind: 'weave.unlock',
    payload: {},
    claims: weak(keyring),
    requiredSmartValue: RISK.MEDIUM.required,
    ttlMs: -5_000, // already past due
  });

  const second = keyring.parkPending({ kind: 'ar.anchor', payload: {}, claims: weak(keyring), requiredSmartValue: RISK.LOW.required, ttlMs: -5_000 });
  assert.deepEqual(keyring.listPending({ status: 'expired' }).map((s) => s.sealId).sort(), [seal.sealId, second.sealId].sort());

  assert.equal(keyring.sweepExpired(), 2, 'sweep retires both in canonical state');
  assert.equal(keyring.sweepExpired(), 0, 'and is idempotent');
  assert.equal(keyring.coSign(seal.sealId, strong(keyring)).code, 'seal_expired');
  assert.equal(keyring.unmask(seal.sealId, strong(keyring), () => null).code, 'seal_expired');
  assert.equal(keyring.getPending(seal.sealId).status, 'expired');
  assert.equal(keyring.stats().expired, 2);
});

test('keyring: a failing applier marks the seal failed without corrupting state', () => {
  const { keyring, vault, events } = harness();
  const seal = keyring.parkPending({
    kind: 'miners.submit',
    payload: { height: 2 },
    claims: strong(keyring),
    requiredSmartValue: RISK.LOW.required,
  });

  const outcome = keyring.unmask(seal.sealId, strong(keyring), () => {
    throw new Error('vault locked');
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'unmask_apply_failed');
  assert.match(outcome.detail, /vault locked/);
  assert.equal(keyring.getPending(seal.sealId).status, 'failed');
  assert.equal(keyring.stats().failed, 1);
  assert.ok(events.some((e) => e.type === 'pending.failed'));
  assert.ok(vault.tail(50).some((e) => e.kind === 'pending.failed'));
});

test('keyring: the pending pool survives a process restart', () => {
  const { root, keyring } = harness();
  const seal = keyring.parkPending({
    kind: 'squad.drill',
    payload: { companionId: 'c1' },
    claims: weak(keyring, 'scout'),
    requiredSmartValue: RISK.LOW.required,
  });

  // Re-open the same vault with the same master key, as a restart would.
  const reopened = new Keyring({ vault: new Vault({ root }), genesisSeed: SEED, masterKey: 'unit-test-master-key-0001' });
  const restored = reopened.getPending(seal.sealId);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.address, seal.address);
  assert.equal(restored.payload.companionId, 'c1');
  assert.equal(reopened.unmask(seal.sealId, strong(reopened), () => ({ ok: true })).ok, true);
});
