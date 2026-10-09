'use strict';

/**
 * Core primitives: content addressing, deterministic RNG, vault persistence,
 * Entropy Chromium (theme + integrity plating) and the reality generator.
 *
 * Run: node --test entropy/test/core.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/core/entropy-core');
const { Vault } = require('../src/core/vault');
const chromium = require('../src/core/chromium');
const reality = require('../src/core/reality-gen');

const SEED = 'test-seed-genesis-unmask';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-core-'));

test('entropy-core: sha256 is domain-separated and length-prefixed', () => {
  const a = core.hashHex('alpha', 'beta');
  const b = core.hashHex('alphabeta'); // naive concatenation would collide with `a`
  assert.notEqual(a, b, 'length prefixing must prevent concat collisions');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(core.sha256('alpha', 'beta').length, 32, 'sha256 returns raw bytes');
});

test('entropy-core: deriveAddress is deterministic, checksummed and reversible', () => {
  const one = core.deriveAddress({ domain: 'MEM', seed: SEED, label: 'player-1', sublabel: 'profile' });
  const two = core.deriveAddress({ domain: 'MEM', seed: SEED, label: 'player-1', sublabel: 'profile' });
  assert.deepEqual(one, two, 'same inputs must produce the same address');
  assert.equal(one.checksum.length, 8, 'checksum is 4 bytes hex');
  assert.match(one.address, /^EX-MEM-[1-9A-HJ-NP-Za-km-z]{30,36}$/);
  assert.match(one.evm, /^0x[0-9a-f]{40}$/, 'evm form binds to the Solidity contracts');
  assert.match(one.digest, /^[0-9a-f]{64}$/);

  const parsed = core.parseAddress(one.address);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.checksumValid, true);
  assert.equal(parsed.domain, 'MEM');
  assert.equal(parsed.domainLabel, one.domainLabel);
  assert.equal(parsed.evm, one.evm);
  assert.equal(core.isAddress(one.address), true);
  assert.equal(core.isAddress('EX-MEM-not-a-real-address'), false);
  assert.equal(core.parseAddress('nope'), null);

  // A single flipped character must invalidate the checksum.
  const tail = one.address.slice(-1);
  const replacement = tail === 'A' ? 'B' : 'A';
  const corrupted = `${one.address.slice(0, -1)}${replacement}`;
  const bad = core.parseAddress(corrupted);
  assert.equal(bad.checksumValid, false, 'checksum must reject corruption');
  assert.equal(core.isAddress(corrupted), false);
});

test('entropy-core: distinct domains/labels never collide', () => {
  const seen = new Set();
  for (const domain of Object.keys(core.DOMAINS)) {
    for (const label of ['a', 'b', 'player-1', 'player-2']) {
      const { address } = core.deriveAddress({ domain, seed: SEED, label, sublabel: 'x' });
      assert.equal(seen.has(address), false, `collision on ${domain}/${label}`);
      seen.add(address);
    }
  }
});

test('entropy-core: createRng is a deterministic, well-distributed PRNG', () => {
  const a = core.createRng(`${SEED}|rng`);
  const b = core.createRng(`${SEED}|rng`);
  const seqA = Array.from({ length: 32 }, () => a.float(0, 1));
  const seqB = Array.from({ length: 32 }, () => b.float(0, 1));
  assert.deepEqual(seqA, seqB);

  const rng = core.createRng(`${SEED}|dist`);
  const mean = Array.from({ length: 4000 }, () => rng.float(0, 1)).reduce((s, v) => s + v, 0) / 4000;
  assert.ok(mean > 0.45 && mean < 0.55, `mean ${mean} should be ~0.5`);

  const picked = core.createRng(`${SEED}|pick`).shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual(picked.slice().sort(), [1, 2, 3, 4, 5], 'shuffle must be a permutation');

  const weighted = core.createRng(`${SEED}|w`);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i += 1) counts[weighted.weighted([['a', 9], ['b', 1]])] += 1;
  assert.ok(counts.a > counts.b * 3, 'weighted pick must respect weights');
});

test('entropy-core: cadence seeds are stable and differ across windows', () => {
  const day = 20734;
  assert.equal(core.dailySeed(SEED, day), core.dailySeed(SEED, day));
  assert.notEqual(core.dailySeed(SEED, day), core.dailySeed(SEED, day + 1));
  assert.notEqual(core.weeklySeed(SEED, '2026-W41'), core.weeklySeed(SEED, '2026-W42'));
  assert.match(core.weekKey(new Date(Date.UTC(2026, 9, 8))), /^\d{4}-W\d{2}$/);
});

test('entropy-core: ewma, clamp, round and safeEqual behave', () => {
  assert.equal(core.clamp(5, 0, 1), 1);
  assert.equal(core.clamp(-5, 0, 1), 0);
  assert.equal(core.round(1.23456, 2), 1.23);
  let value = 0;
  for (let i = 0; i < 40; i += 1) value = core.ewma(value, 1, 0.25);
  assert.ok(value > 0.99, 'ewma must converge on a constant sample');
  assert.equal(core.safeEqual('abc', 'abc'), true);
  assert.equal(core.safeEqual('abc', 'abd'), false);
  assert.equal(core.safeEqual('abc', 'abcd'), false);
});

test('vault: atomic writes, content addressing, journal and CAS', () => {
  const dir = tmp();
  const vault = new Vault({ root: dir });
  const events = [];
  vault.onEvent = (e) => events.push(e);

  const written = vault.write('memory', { hello: 'world', n: 1 }, { actor: 'test', kind: 'test.write' });
  assert.match(written.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'memory.json')));
  assert.deepEqual(vault.read('memory'), { hello: 'world', n: 1 });

  // No temp files may survive a write (atomic rename contract).
  assert.deepEqual(fs.readdirSync(path.join(dir, 'state')).filter((f) => f.endsWith('.tmp')), []);

  vault.update('memory', (doc) => ({ ...doc, n: doc.n + 1 }), { actor: 'test', kind: 'test.update' });
  assert.equal(vault.read('memory').n, 2);

  const key = vault.cas({ immutable: true, id: 7 });
  assert.deepEqual(vault.getCas(key), { immutable: true, id: 7 });
  assert.equal(vault.getCas('0'.repeat(64)), null);

  const tail = vault.tail(5);
  assert.ok(tail.length >= 2);
  assert.ok(tail.every((e) => typeof e.seq === 'number' && e.at));
  assert.ok(events.some((e) => e.type === 'vault.journal'), 'journal must tap the event bus');
  assert.ok(events.at(-1).payload.kind === 'test.update');

  const inspected = vault.inspect();
  assert.ok(inspected.bytes.state > 0);
  assert.ok(inspected.bytes.journal > 0);
  assert.ok(inspected.domains.includes('memory'));
  assert.equal(inspected.cached.includes('weave'), false);

  // Keyring file must be private (it can hold a master key).
  vault.writeKeyring({ keyId: 'k1', masterKey: 'aa' });
  const mode = fs.statSync(path.join(dir, 'keyring.json')).mode & 0o777;
  assert.equal(mode, 0o600, `keyring.json mode should be 0600, got ${mode.toString(8)}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('vault: genesis is written once and reused', () => {
  const dir = tmp();
  const vault = new Vault({ root: dir });
  const first = vault.genesis({ seed: SEED, meta: { network: 'test' } });
  const second = vault.genesis({ seed: 'something-else' });
  assert.equal(second.genesisSeed, SEED, 'existing genesis must win');
  assert.equal(first.seedFingerprint, second.seedFingerprint);
  assert.equal(first.network, 'test');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chromium: alloy is deterministic per seed/surface/grade and accessible', () => {
  const a = chromium.deriveAlloy({ seed: SEED, surface: 'bright', grade: 'Cr-7' });
  const b = chromium.deriveAlloy({ seed: SEED, surface: 'bright', grade: 'Cr-7' });
  assert.deepEqual(a, b);

  const other = chromium.deriveAlloy({ seed: `${SEED}-fork`, surface: 'bright', grade: 'Cr-7' });
  assert.notEqual(a.id, other.id, 'a different seed must re-tint the product');
  assert.notEqual(a.colors.accent, other.colors.accent);

  assert.equal(a.surface.base, 'light', 'bright surface is a light theme');
  assert.ok(a.contrast.inkOnPanel >= 7, `ink contrast ${a.contrast.inkOnPanel} should reach AAA`);
  assert.ok(a.contrast.accentOnPanel >= 4.5, `accent contrast ${a.contrast.accentOnPanel} should reach AA`);
  assert.equal(a.contrast.aaa, true);
  assert.match(a.address, /^EX-CHR-/);
  assert.ok(a.arHud.layers.scan.tint.startsWith('#'));
  assert.equal(a.grade.grade, 'Cr-7');

  const dusk = chromium.deriveAlloy({ seed: SEED, surface: 'dusk', grade: 'Cr-9' });
  assert.equal(dusk.surface.base, 'dark');
  assert.ok(dusk.contrast.inkOnPanel >= 7, 'dark surface must stay AAA too');
});

test('chromium: toCss emits custom properties for the whole design system', () => {
  const css = chromium.toCss(chromium.deriveAlloy({ seed: SEED, surface: 'bright', grade: 'Cr-5' }));
  for (const token of ['--bg:', '--panel:', '--ink:', '--accent:', '--glass:', '--blur:', '--sheen:', '--font-mono:', '--ar-reticle:', '--ar-layer-threat:']) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  assert.ok(css.includes('prefers-reduced-motion'), 'must respect reduced motion');
  assert.ok(css.includes('generated, do not edit'), 'must be labelled generated');
});

test('chromium: plating seals a payload and rejects tampering', () => {
  const masterKey = Buffer.from('test-master-key');
  const payload = { kind: 'scene', title: 'Mirror Basin', n: 3 };
  const stamp = chromium.plate(payload, { seed: SEED, masterKey, subject: 'player-1', kind: 'ar.scan', grade: 'Cr-7' });
  assert.match(stamp.plate, /^chrp\.v1\.Cr-7\.[0-9a-f]{16}\.[0-9a-f]{16}$/);
  assert.match(stamp.address, /^EX-CHR-/);

  const ok = chromium.verifyPlate(stamp.plate, payload, { masterKey, subject: 'player-1', kind: 'ar.scan' });
  assert.equal(ok.valid, true);

  const tampered = chromium.verifyPlate(stamp.plate, { ...payload, n: 4 }, { masterKey, subject: 'player-1', kind: 'ar.scan' });
  assert.equal(tampered.valid, false);
  assert.equal(tampered.reason, 'payload hash mismatch');

  const wrongKey = chromium.verifyPlate(stamp.plate, payload, { masterKey: Buffer.from('other'), subject: 'player-1', kind: 'ar.scan' });
  assert.equal(wrongKey.valid, false);

  const wrongSubject = chromium.verifyPlate(stamp.plate, payload, { masterKey, subject: 'player-2', kind: 'ar.scan' });
  assert.equal(wrongSubject.valid, false);
  assert.equal(chromium.verifyPlate('nonsense', payload, { masterKey }).valid, false);
});

test('reality-gen: fragments are deterministic, signed and typed', () => {
  const digest = 'a'.repeat(64);
  const one = reality.fragmentFromHash({ hash: digest, seed: SEED, index: 0 });
  const two = reality.fragmentFromHash({ hash: digest, seed: SEED, index: 0 });
  assert.deepEqual(one, two);
  assert.match(one.address, /^EX-RLT-/);
  assert.ok(reality.FRAGMENT_KINDS.includes(one.kind));
  assert.ok(one.title && one.text, 'fragment must carry prose');
  assert.ok(one.rlu > 0, 'fragment must carry a Reality Unit value');
  assert.notDeepEqual(reality.fragmentFromHash({ hash: digest, seed: SEED, index: 1 }), one, 'index must change the output');

  assert.throws(() => reality.fragmentFromHash({ hash: 'nope', seed: SEED }), /64-hex/);

  const forced = reality.fragmentFromHash({ hash: digest, seed: SEED, index: 0, kind: 'terrain' });
  assert.equal(forced.kind, 'terrain');
  assert.equal(forced.heightfield.length, 8);
  assert.equal(forced.heightfield[0].length, 8);
});

test('reality-gen: a block yields 1-4 fragments with rarity distribution', () => {
  const blockHash = 'b'.repeat(64);
  const reward = reality.realityFromBlock({ blockHash, seed: SEED, blockAddress: 'EX-BLK-test' });
  assert.ok(reward.count >= 1 && reward.count <= 4);
  assert.equal(reward.fragments.length, reward.count);
  assert.ok(reward.rlu > 0);
  assert.ok(reward.fragments.every((f) => f.parent === 'EX-BLK-test'));

  const counts = {};
  for (let i = 0; i < 400; i += 1) {
    const r = reality.realityFromBlock({ blockHash: core.hashHex('blk', i), seed: SEED });
    for (const f of r.fragments) counts[f.rarity] = (counts[f.rarity] || 0) + 1;
  }
  assert.ok(counts.common > counts.unmasked, 'common must dominate the tail');
  assert.ok(Object.keys(counts).length >= 3, 'rarity ladder should be exercised');
});

test('reality-gen: conversation and briefs are reproducible', () => {
  const a = reality.conversationFrom({ seed: SEED, speakers: ['Evolynn', 'Tru'], turns: 5, context: 'raid' });
  const b = reality.conversationFrom({ seed: SEED, speakers: ['Evolynn', 'Tru'], turns: 5, context: 'raid' });
  assert.deepEqual(a, b);
  assert.equal(a.lines.length, 5);
  assert.ok(a.lines.every((l) => l.speaker && l.text && l.address));

  const brief = reality.briefFrom({ seed: SEED, fragments: a.lines.map(() => reality.fragmentFromHash({ hash: 'c'.repeat(64), seed: SEED, kind: 'scene' })) });
  assert.ok(brief.title && brief.venue && brief.text.length > 20);
});
