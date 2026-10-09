/**
 * api.test.js — the HTTP surface: envelope, addresses, auth, the pending
 * gate (202 → co-sign → genesis unmask), SSE, generated assets, errors,
 * rate limiting, and the JavaScript SDK client against a live server.
 *
 *   node --test entropy/test/api.test.js
 *
 * Every request is a real socket round-trip against `app.listen({port:0})`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/api/server');
const { EntropyClient, EntropyApiError } = require('../src/sdk/client');
const core = require('../src/core/entropy-core');

const FAST = Object.freeze({
  minDifficultyBits: 6,
  maxDifficultyBits: 14,
  genesisDifficultyBits: 9,
  targetBlockMs: 60,
  retargetInterval: 3,
  shareDifficultyOffset: 3,
  jobTtlMs: 20_000,
});

/** Boot a real server on an ephemeral port, run `fn`, tear everything down. */
async function withServer(fn, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-api-'));
  const savedEnv = {};
  for (const [k, v] of Object.entries(opts.env || {})) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const app = createApp({
    dataDir,
    seed: opts.seed || 'api-test-genesis-seed',
    mode: opts.mode || 'dev',
    host: '127.0.0.1',
    port: 0,
    consensus: { ...FAST, ...(opts.consensus || {}) },
    pendingTtlMs: 60_000,
  });
  const live = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${live.address.port}`;
  const root = app.bootstrapToken({ subject: 'test-commander' });
  try {
    return await fn({ app, live, base, root, dataDir, ...app.systems, keyring: app.keyring, vault: app.vault, bus: app.bus, config: app.config });
  } finally {
    await app.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const json = (token, extra = {}) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});

async function call(base, method, urlPath, { token = null, body = null, headers = {} } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: json(token, headers),
    body: body === null ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json() : await res.text();
  return { res, status: res.status, type, payload };
}

/* ══════════════════════ discovery + generated assets ══════════════════ */

test('api: public discovery, generated CSS and the OpenAPI document need no token', async () => {
  await withServer(async ({ base, root }) => {
    const index = await call(base, 'GET', '/v1');
    assert.equal(index.status, 200);
    assert.equal(index.payload.ok, true);
    assert.equal(index.payload.data.protocol, 'ENTROPY');
    assert.ok(index.payload.meta.requestId);
    assert.equal(index.res.headers.get('x-entropy-protocol'), 'ENTROPY/1.0.0');
    assert.equal(index.res.headers.get('access-control-allow-origin'), '*');
    assert.equal(index.res.headers.get('x-content-type-options'), 'nosniff');

    const health = await call(base, 'GET', '/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.data.status, 'ok');
    assert.equal(health.payload.data.chain.valid, true);
    assert.ok(health.payload.data.pending.total >= 0);
    assert.ok(health.payload.data.memoryMb > 0);

    // OPTIONS preflight is answered without touching the router.
    const preflight = await fetch(`${base}/v1/status`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-entropy-pending/);

    const openapi = await call(base, 'GET', '/v1/openapi.json');
    assert.equal(openapi.status, 200);
    const doc = openapi.payload.data;
    assert.equal(doc.openapi.startsWith('3.'), true);
    assert.match(doc.info.title, /Entropy API/i);
    assert.equal(doc.info.version, core.PROTOCOL_VERSION);
    const paths = Object.keys(doc.paths);
    assert.ok(paths.length >= 60, `expected a full surface, got ${paths.length} paths`);
    assert.ok(paths.includes('/v1/weave/fuse'));
    let addressed = 0;
    for (const p of paths) {
      for (const op of Object.values(doc.paths[p])) {
        if (op?.['x-entropy-address']) {
          addressed += 1;
          assert.equal(core.isAddress(op['x-entropy-address']), true);
        }
      }
    }
    assert.ok(addressed >= 60, `every operation carries its handler address (${addressed})`);
    assert.ok(doc.components.schemas, 'the document ships its schemas');

    const css = await fetch(`${base}/ui/chromium.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const cssText = await css.text();
    assert.match(cssText, /--accent:/);
    assert.match(cssText, /color-scheme:\s*light/, 'the HUD is a bright, premium surface');
    assert.match(cssText, /ENTROPY CHROMIUM/);

    // The HUD is served at /ui/ (and at /) with its own assets reachable.
    for (const uiPath of ['/ui/', '/ui/index.html', '/', '/ui/hud.css', '/ui/hud.js']) {
      const ui = await fetch(`${base}${uiPath}`);
      assert.equal(ui.status, 200, `${uiPath} must be served`);
      if (uiPath.endsWith('.js')) assert.match(ui.headers.get('content-type'), /javascript/);
      if (uiPath.endsWith('.css')) assert.match(ui.headers.get('content-type'), /text\/css/);
    }
    const html = await (await fetch(`${base}/ui/`)).text();
    assert.match(html, /ENTROPY/);
    assert.match(html, /\/ui\/hud\.js/, 'the HUD references its assets by absolute /ui/ path');
    assert.match(html, /color-scheme|chromium\.css/);
    // Path traversal is refused, not served.
    const traversal = await fetch(`${base}/ui/../core/keyring.js`);
    assert.ok([403, 404].includes(traversal.status), `traversal returned ${traversal.status}`);

    const svg = await fetch(`${base}/v1/ar/overlay.svg?w=640&h=360&title=TEST`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
    const svgText = await svg.text();
    assert.match(svgText, /<svg/);
    assert.match(svgText, /TEST/);
    assert.match(svgText, /<\/svg>/);

    // The root token still reads fine (auth is a floor, not a wall).
    const consensus = await call(base, 'GET', '/v1/miners/consensus', { token: root.token });
    assert.equal(consensus.status, 200);
    assert.equal(consensus.payload.data.consensus.genesisDifficultyBits, FAST.genesisDifficultyBits);
  });
});

test('api: every content handler is registered, addressed and resolvable', async () => {
  await withServer(async ({ base, root, app, memory, miners }) => {
    const handlers = await call(base, 'GET', '/v1/handlers', { token: root.token });
    assert.equal(handlers.status, 200);
    const data = handlers.payload.data;
    assert.ok(data.count >= 60, `handler registry looks thin: ${data.count}`);
    assert.ok(data.groups.length >= 8);

    const all = data.groups.flatMap((g) => g.handlers);
    assert.equal(all.length, data.count);
    assert.ok(all.every((h) => core.isAddress(h.entropyAddress)), 'every handler has a checksummed entropy address');
    assert.ok(all.every((h) => /^0x[0-9a-f]{40}$/.test(h.evmAddress)), 'and an EVM form for the Solidity side');
    assert.ok(all.every((h) => h.entropyAddress.startsWith('EX-HND-')));
    assert.equal(new Set(all.map((h) => h.entropyAddress)).size, all.length, 'handler addresses are unique per method+path');
    assert.ok(all.every((h) => h.method && h.path && h.url));
    assert.ok(all.filter((h) => h.risk).every((h) => h.requiredSmartValue > 0 && h.pendingCapable), 'risk ⇒ a smart-value gate');
    assert.ok(all.some((h) => h.handler === 'weave.fuse' && h.risk === 'HIGH'));

    const one = all.find((h) => h.handler === 'weave.fuse');
    const detail = await call(base, 'GET', `/v1/handlers/${encodeURIComponent(one.handler)}`, { token: root.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.payload.data.entropyAddress, one.entropyAddress);
    assert.deepEqual(detail.payload.data.scopes, ['weave:write']);
    const missingHandler = await call(base, 'GET', '/v1/handlers/nope.nope', { token: root.token });
    assert.equal(missingHandler.status, 404);

    // The reverse index: any address resolves back to the record that owns it.
    const resolved = await call(base, 'GET', `/v1/addresses/${encodeURIComponent(one.entropyAddress)}`, { token: root.token });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.payload.data.parsed.domain, 'HND');
    assert.equal(resolved.payload.data.parsed.checksumValid, true);
    assert.equal(resolved.payload.data.resolved, true);
    assert.equal(resolved.payload.data.recordType, 'handler');
    assert.equal(resolved.payload.data.record.handler, 'weave.fuse');
    assert.equal(resolved.payload.data.record.method, 'POST');

    const profile = memory.ensureProfile('addressable');
    const byProfile = await call(base, 'GET', `/v1/addresses/${encodeURIComponent(profile.address)}`, { token: root.token });
    assert.equal(byProfile.payload.data.recordType, 'profile');
    assert.equal(byProfile.payload.data.record.profileId, profile.profileId);

    const blockAddress = miners.chain({ limit: 1 }).blocks[0].address;
    const byBlock = await call(base, 'GET', `/v1/addresses/${encodeURIComponent(blockAddress)}`, { token: root.token });
    assert.equal(byBlock.payload.data.recordType, 'block');
    assert.equal(byBlock.payload.data.record.height, 0);

    const alloy = app.alloy();
    const byAlloy = await call(base, 'GET', `/v1/addresses/${encodeURIComponent(alloy.address)}`, { token: root.token });
    assert.equal(byAlloy.payload.data.recordType, 'alloy');
    assert.equal(byAlloy.payload.data.record.grade, alloy.grade.grade);

    const byPool = await call(base, 'GET', `/v1/addresses/${encodeURIComponent(miners.pool().address)}`, { token: root.token });
    assert.equal(byPool.payload.data.recordType, 'pool');

    // A well-formed address with a broken checksum is rejected, not resolved.
    const corrupted = `${profile.address.slice(0, -1)}${profile.address.slice(-1) === 'A' ? 'B' : 'A'}`;
    const bad = await call(base, 'GET', `/v1/addresses/${encodeURIComponent(corrupted)}`, { token: root.token });
    assert.equal(bad.payload.data.parsed.checksumValid, false);
    assert.equal(bad.payload.data.resolved, false);

    const nonsense = await call(base, 'GET', '/v1/addresses/not-an-address', { token: root.token });
    assert.equal(nonsense.status, 400);
    assert.equal(nonsense.payload.error.code, 'bad_request');
  });
});

/* ══════════════════════════════ auth ═══════════════════════════════ */

test('api: tokens are required, verified, scoped and refreshable', async () => {
  await withServer(async ({ base, root }) => {
    const anon = await call(base, 'GET', '/v1/status');
    assert.equal(anon.status, 401);
    assert.equal(anon.payload.ok, false);
    assert.equal(anon.payload.error.code, 'token_missing');
    assert.match(anon.payload.error.hint, /POST \/v1\/auth\/token/);
    assert.ok(anon.payload.meta.entropyAddress, 'even a rejection names the handler address');

    const garbage = await call(base, 'GET', '/v1/status', { token: 'not-a-token' });
    assert.equal(garbage.status, 401);
    assert.equal(garbage.payload.error.code, 'token_malformed');

    // Dev mode issues tokens openly; the response is the full smart-value card.
    const issued = await call(base, 'POST', '/v1/auth/token', {
      body: { subject: 'integration-one', tier: 'operator', scopes: ['entropy:read', 'memory:write'], ttlSeconds: 900 },
    });
    assert.equal(issued.status, 200);
    assert.match(issued.payload.data.token, /^entk\.v1\./);
    assert.match(issued.payload.data.address, /^EX-KEY-/);
    assert.ok(issued.payload.data.smartValue > 0);
    assert.ok(issued.payload.data.warning, 'dev mode must warn that issuance is open');

    const token = issued.payload.data.token;
    const me = await call(base, 'GET', '/v1/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.payload.data.subject, 'integration-one');
    assert.equal(me.payload.data.tier, 'operator');
    assert.match(me.payload.data.address, /^EX-KEY-/);
    assert.deepEqual(me.payload.data.scopes, ['entropy:read', 'memory:write']);
    assert.ok(me.payload.data.smartValue.live <= me.payload.data.smartValue.base, 'live value decays from base');
    assert.ok(me.payload.data.smartValue.decay >= 0 && me.payload.data.smartValue.decay <= 1);

    const verified = await call(base, 'POST', '/v1/auth/verify', { token, body: { token, opScopes: ['memory:write'] } });
    assert.equal(verified.status, 200);
    assert.equal(verified.payload.data.valid, true);

    // Reads inside the held scopes work…
    const pool = await call(base, 'GET', '/v1/pending?limit=5', { token });
    assert.equal(pool.status, 200);
    // …but unmasking needs unmask:seal, which this token does not carry.
    const scoped = await call(base, 'POST', '/v1/pending/anything/unmask', { token, body: {} });
    assert.equal(scoped.status, 403);
    assert.equal(scoped.payload.error.code, 'token_scope');
    assert.deepEqual(scoped.payload.error.detail.scopes, ['entropy:read', 'memory:write'], 'the rejection names what the token does hold');
    assert.equal(scoped.payload.error.detail.tier, 'operator');

    const refreshed = await call(base, 'POST', '/v1/auth/refresh', { token });
    assert.equal(refreshed.status, 200);
    assert.match(refreshed.payload.data.token, /^entk\.v1\./);

    const catalog = await call(base, 'GET', '/v1/auth/catalog', { token: root.token });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.payload.data.tiers.length, 6);
    assert.equal(catalog.payload.data.risk.length, 6);
    assert.ok(catalog.payload.data.scopes.length >= 10);
  });
});

test('api: production mode closes open token issuance', async () => {
  await withServer(async ({ base }) => {
    const issued = await call(base, 'POST', '/v1/auth/token', { body: { subject: 'intruder', tier: 'sovereign' } });
    assert.equal(issued.status, 401, 'prod mode requires admin:root to mint tokens');
    assert.equal(issued.payload.error.code, 'token_missing');
  }, { mode: 'prod' });
});

/* ══════════════════════ the pending gate / unmask ═══════════════════ */

test('api: a weak token parks the write as 202 pending, and authority unmasks it', async () => {
  await withServer(async ({ base, root, memory }) => {
    const issued = await call(base, 'POST', '/v1/auth/token', {
      body: { subject: 'scout', tier: 'observer', scopes: ['entropy:read', 'memory:write'], ttlSeconds: 900, pendingBudget: 2 },
    });
    const weak = issued.payload.data.token;
    assert.ok(issued.payload.data.smartValue > 0, 'the token card reports its smart value');

    const profile = memory.ensureProfile('scout');
    const trace = { kind: 'loadout', text: 'Parked by the pending gate test', tags: ['test'], resonance: 1.2 };

    // 1. Weak authority → HTTP 202 with a seal, not a silent failure.
    const parked = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember`, { token: weak, body: trace });
    assert.equal(parked.status, 202);
    assert.equal(parked.payload.ok, true);
    assert.equal(parked.payload.data.status, 'pending');
    assert.equal(parked.payload.meta.sealed, false);
    assert.equal(parked.payload.meta.risk, 'LOW');
    assert.match(parked.payload.data.sealAddress, /^EX-PND-/);
    assert.equal(parked.payload.data.requiredSmartValue, 180);
    assert.ok(parked.payload.data.offeredSmartValue < 180);
    assert.equal(parked.payload.data.coSignRequired, 1);
    assert.ok(Date.parse(parked.payload.data.expiresAt) > Date.now());
    assert.equal(parked.payload.data.nextSteps.length, 4);
    assert.ok(parked.payload.data.nextSteps[0].includes(parked.payload.data.sealId));

    // The effect was NOT applied.
    assert.equal(memory.recall(profile.profileId, { query: 'parked pending gate' }).count, 0);

    const sealId = parked.payload.data.sealId;

    // 2. The pool shows it, with an integrity address.
    const listed = await call(base, 'GET', '/v1/pending?status=pending', { token: root.token });
    assert.equal(listed.status, 200);
    assert.ok(listed.payload.data.seals.some((s) => s.sealId === sealId));
    const stats = await call(base, 'GET', '/v1/pending/stats');
    assert.equal(stats.status, 200, 'pool depth is public');
    assert.equal(stats.payload.data.pending, 1);

    // 3. A co-signature from real authority clears and applies it in one call.
    const cosigned = await call(base, 'POST', `/v1/pending/${sealId}/cosign`, { token: root.token, body: { note: 'test authority' } });
    assert.equal(cosigned.status, 200);
    assert.equal(cosigned.payload.data.coSigned, true);
    assert.equal(cosigned.payload.data.autoUnmasked, true, 'the threshold was met, so the seal applied itself');

    const recalled = memory.recall(profile.profileId, { query: 'parked pending gate' });
    assert.equal(recalled.results[0].text, trace.text, 'the parked trace is now canonical memory (and the top hit)');
    assert.ok(recalled.count >= 1);

    // 4. Explicit unmask path on a fresh seal.
    const second = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember`, { token: weak, body: { kind: 'lore', text: 'second parked trace' } });
    assert.equal(second.status, 202);
    const unmasked = await call(base, 'POST', `/v1/pending/${second.payload.data.sealId}/unmask`, { token: root.token, body: { note: 'genesis unmask' } });
    assert.equal(unmasked.status, 200);
    assert.equal(unmasked.payload.data.status, 'unmasked');
    assert.equal(unmasked.payload.data.unmaskedBy, 'test-commander');
    assert.equal(unmasked.payload.data.kind, 'memory.remember');
    assert.match(unmasked.payload.data.sealAddress, /^EX-PND-/);
    assert.ok(unmasked.payload.data.authority >= unmasked.payload.data.required);
    assert.ok(unmasked.payload.data.result.traceId, 'the applier result travels back to the caller');
    assert.ok(
      memory.recall(profile.profileId, { query: 'second parked trace' }).results.some((r) => r.text === 'second parked trace'),
      'the second parked trace landed too',
    );

    // 5. Voiding is terminal, and only the requester or an authority may do it.
    const third = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember`, { token: weak, body: { kind: 'lore', text: 'third parked trace' } });
    assert.equal(third.status, 202, 'the same weak token keeps parking');
    const voided = await call(base, 'POST', `/v1/pending/${third.payload.data.sealId}/void`, { token: root.token, body: { reason: 'test cancel' } });
    assert.equal(voided.status, 200);
    assert.equal(voided.payload.data.seal.status, 'voided');
    const reUnmask = await call(base, 'POST', `/v1/pending/${third.payload.data.sealId}/unmask`, { token: root.token, body: {} });
    assert.equal(reUnmask.status, 409, 'a voided seal can never be applied');

    const unknown = await call(base, 'POST', '/v1/pending/nope/unmask', { token: root.token, body: {} });
    assert.equal(unknown.status, 404);
  });
});

test('api: x-entropy-pending forces or forbids parking', async () => {
  await withServer(async ({ base, root, memory }) => {
    const issued = await call(base, 'POST', '/v1/auth/token', {
      body: { subject: 'scout', tier: 'observer', scopes: ['entropy:read', 'memory:write'], ttlSeconds: 900 },
    });
    const weak = issued.payload.data.token;
    const profile = memory.ensureProfile('scout');

    // Even root authority parks when the caller asks for a reviewable seal.
    const forced = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember`, {
      token: root.token,
      body: { kind: 'lore', text: 'forced pending' },
      headers: { 'x-entropy-pending': 'force' },
    });
    assert.equal(forced.status, 202);
    assert.equal(forced.payload.data.status, 'pending');
    assert.equal(memory.recall(profile.profileId, { query: 'forced pending' }).count, 0);

    // The query-string form works for browsers that cannot set headers.
    const forcedQuery = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember?pending=force`, {
      token: root.token,
      body: { kind: 'lore', text: 'forced via query' },
    });
    assert.equal(forcedQuery.status, 202);

    // `never` makes an under-funded write a hard 403 instead of a seal.
    const forbidden = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember`, {
      token: weak,
      body: { kind: 'lore', text: 'never pending' },
      headers: { 'x-entropy-pending': 'never' },
    });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.payload.error.message, /pending is disabled/);
    assert.equal(forbidden.payload.error.detail.required, 180);

    // Root without any header applies immediately.
    const sealed = await call(base, 'POST', `/v1/memory/${profile.profileId}/remember`, { token: root.token, body: { kind: 'lore', text: 'applied now' } });
    assert.equal(sealed.status, 200);
    assert.equal(sealed.payload.meta.sealed, true);
    assert.equal(sealed.payload.data.status === 'pending', false);
    assert.equal(memory.recall(profile.profileId, { query: 'applied now' }).count, 1);
  });
});

/* ══════════════════════ writes, mining, streaming ═══════════════════ */

test('api: mining over HTTP seals blocks and the chain verifies remotely', async () => {
  await withServer(async ({ base, root, memory }) => {
    const profile = memory.ensureProfile('remote-miner');
    const mined = await call(base, 'POST', '/v1/miners/mine', {
      token: root.token,
      body: { profileId: profile.profileId, seconds: 4, blocks: 2, workerId: 'http-rig' },
    });
    assert.equal(mined.status, 200);
    assert.equal(mined.payload.data.blocksMined, 2);
    assert.ok(mined.payload.data.mined.every((b) => core.isAddress(b.address)));
    assert.equal(mined.payload.meta.risk, 'MEDIUM');
    assert.equal(mined.payload.meta.sealed, true);

    const chain = await call(base, 'GET', '/v1/miners/chain?limit=5', { token: root.token });
    assert.equal(chain.status, 200);
    assert.equal(chain.payload.data.height, 2);
    assert.equal(chain.payload.data.blocks.length, 3, 'genesis + two mined');

    const verified = await call(base, 'POST', '/v1/miners/verify', { token: root.token, body: { sampleReality: 3 } });
    assert.equal(verified.status, 200);
    assert.equal(verified.payload.data.valid, true);
    assert.equal(verified.payload.data.problems.length, 0);

    const wallet = await call(base, 'GET', `/v1/miners/wallet/${profile.profileId}`, { token: root.token });
    assert.equal(wallet.status, 200);
    assert.ok(wallet.payload.data.rlu > 0);
    assert.equal(wallet.payload.data.unit.monetary, false, 'RLU is never presented as money');

    const pool = await call(base, 'GET', '/v1/miners/pool', { token: root.token });
    assert.equal(pool.status, 200);
    assert.ok(pool.payload.data.shareDifficultyBits < pool.payload.data.difficultyBits);

    const block = await call(base, 'GET', '/v1/miners/blocks/1', { token: root.token });
    assert.equal(block.status, 200);
    assert.equal(block.payload.data.height, 1);
    assert.ok(block.payload.data.reality.fragments.length >= 1);

    const missing = await call(base, 'GET', '/v1/miners/blocks/9999', { token: root.token });
    assert.equal(missing.status, 404);
  });
});

test('api: the SSE stream carries live events to integrations', async () => {
  await withServer(async ({ base, root, memory }) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const readUntil = async (pattern, timeoutMs = 5000) => {
      let buffer = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pending = Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(50, deadline - Date.now()))),
        ]);
        const chunk = await pending;
        if (chunk.timeout) break;
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (pattern.test(buffer)) return buffer;
      }
      return buffer;
    };

    const hello = await readUntil(/event: hello/);
    assert.match(hello, /event: hello/);
    assert.match(hello, /"protocol":"ENTROPY\/1\.0\.0"/);

    // Drive state over HTTP and watch it arrive on the stream.
    const profile = memory.ensureProfile('streamer');
    await call(base, 'POST', '/v1/miners/mine', { token: root.token, body: { profileId: profile.profileId, seconds: 3, blocks: 1 } });
    const streamed = await readUntil(/event: miners\.block/);
    assert.match(streamed, /event: miners\.block/);
    assert.match(streamed, /"height":1/);

    controller.abort();
    await assert.rejects(() => reader.closed.then((v) => v), () => true).catch(() => {});
  });
});

/* ════════════════════════ errors + throttling ══════════════════════ */

test('api: unknown routes and wrong methods return enveloped errors', async () => {
  await withServer(async ({ base, root }) => {
    const missing = await call(base, 'GET', '/v1/definitely-not-here', { token: root.token });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.ok, false);
    assert.equal(missing.payload.error.code, 'route_not_found');
    assert.match(missing.payload.error.hint, /GET \/v1\/handlers/);

    const wrongMethod = await call(base, 'POST', '/v1/handlers', { token: root.token, body: {} });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.payload.error.code, 'method_not_allowed');

    const badBody = await call(base, 'POST', '/v1/memory/profiles', { token: root.token, body: { nonsense: true } });
    assert.ok([400, 200].includes(badBody.status), 'a body without a subject is rejected or defaults, never 500');
    if (badBody.status === 400) assert.equal(badBody.payload.ok, false);

    const raw = await fetch(`${base}/v1/status`, { method: 'GET', headers: { authorization: 'Bearer nope' } });
    assert.equal(raw.headers.get('content-type').includes('application/json'), true, 'errors are JSON, not HTML');
  });
});

test('api: the rate limiter throttles per subject and says when to retry', async () => {
  await withServer(async ({ base, root }) => {
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await call(base, 'GET', '/v1/miners/consensus', { token: root.token });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(res.payload.error.code, 'rate_limited');
        assert.ok(res.payload.error.detail.retryInMs > 0);
        assert.ok(Number(res.res.headers.get('retry-after')) >= 1, 'retry-after is set in whole seconds');
        break;
      }
    }
    assert.ok(statuses.includes(429), `expected throttling, got ${statuses.join(',')}`);
    assert.equal(statuses[0], 200, 'the first requests always pass');
  }, { env: { ENTROPY_RATE_CAPACITY: '4', ENTROPY_RATE_REFILL: '1' } });
});

/* ═══════════════════════════════ SDK ══════════════════════════════ */

test('sdk: EntropyClient logs in, drives systems and surfaces errors', async () => {
  await withServer(async ({ base }) => {
    const client = new EntropyClient({
      baseUrl: base,
      subject: 'sdk-integration',
      tier: 'sovereign',
      scopes: ['entropy:read', 'memory:write', 'weave:write', 'squad:write', 'mission:write', 'lobby:write', 'miner:work', 'unmask:seal', 'ar:write'],
      pendingMode: 'auto',
    });

    const session = await client.login({ ttlSeconds: 1800 });
    assert.match(session.token, /^entk\.v1\./);
    assert.equal(client.claims.sub, 'sdk-integration');
    assert.equal(client.claims.tier, 'sovereign');
    assert.ok(client.expiresAt > Date.now());
    assert.equal(client.decodeToken().sub, 'sdk-integration');

    const status = await client.system.status();
    assert.ok(status.systems.miners && status.systems.memory, 'status returns the aggregate card');
    assert.equal(typeof status.pending.total, 'number');
    assert.ok(status.season.seasonId);

    const handlers = await client.system.handlers();
    assert.ok(handlers.count >= 60);

    const bootstrapped = await client.bootstrapPlayer('sdk-player', { alias: 'SDK Player', recruitCompanions: 2 });
    assert.ok(bootstrapped.profileId, 'the one-shot flow returns the new identity');
    assert.match(bootstrapped.address, /^EX-MEM-/);
    assert.equal(bootstrapped.recruited.length, 2);
    assert.ok(bootstrapped.missions >= 4, 'the daily + weekly board was offered');

    const profileId = bootstrapped.profileId;
    const remembered = await client.memory.remember(profileId, { kind: 'integration', text: 'written through the SDK client', tags: ['sdk'] });
    assert.equal(remembered.status === 'pending', false, 'a sovereign token seals immediately');
    const recalled = await client.memory.recall(profileId, { query: 'written through the SDK client' });
    assert.equal(recalled.results[0].text, 'written through the SDK client', 'recall ranks the exact phrase first');

    const mined = await client.miners.mine({ profileId, seconds: 3, blocks: 1 });
    assert.equal(mined.blocksMined, 1);
    const verified = await client.miners.verify();
    assert.equal(verified.valid, true);

    const poolStats = await client.pending.stats();
    assert.ok(typeof poolStats.total === 'number');

    assert.ok(client.stats.calls >= 6);
    assert.equal(client.stats.errors, 0);

    // Errors become typed, inspectable objects — never raw fetch responses.
    await assert.rejects(
      () => client.get('/v1/memory/does-not-exist-at-all'),
      (err) => {
        assert.ok(err instanceof EntropyApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'not_found');
        assert.ok(err.meta.requestId);
        return true;
      },
    );
    assert.equal(client.stats.errors, 1);
  });
});
