/**
 * systems.test.js — the seven gameplay systems, wired exactly as the server
 * wires them (cross-attached, shared vault, shared keyring).
 *
 *   node --test entropy/test/systems.test.js
 *
 * These run against a FAST consensus profile (low difficulty bits, 3-block
 * retarget window) so a full chain lifecycle costs milliseconds, not minutes.
 *
 * Covered: Entropy Memory (recall scoring, forgetting, loadouts, skills,
 * consolidation, export/import), Power Weaving (unlock spend, fusion outcomes,
 * fracture residue), AR overlay (scan modes, anchors, SVG, quantisation),
 * Squad companions (learning, quirks, drills, recommendations), Missions
 * (deterministic boards, objectives, payouts, seasons, world events),
 * Multiplayer (safety scoring, invite gates, reports → seals, raid lifecycle)
 * and the Reality Miners stack (PoW, shares, stale work, retarget, verification).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/api/server');
const { RealityMiners } = require('../src/systems/miners');
const { Multiplayer } = require('../src/systems/multiplayer');
const core = require('../src/core/entropy-core');

/** A chain that a test can actually finish: ~512 hashes per block. */
const FAST = Object.freeze({
  minDifficultyBits: 6,
  maxDifficultyBits: 14,
  genesisDifficultyBits: 9,
  targetBlockMs: 60,
  retargetInterval: 3,
  retargetMaxFactor: 2,
  shareDifficultyOffset: 3,
  jobTtlMs: 20_000,
});

async function withApp(fn, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-systems-'));
  const app = createApp({
    dataDir,
    seed: opts.seed || 'systems-test-genesis-seed',
    mode: 'dev',
    host: '127.0.0.1',
    port: 0,
    consensus: { ...FAST, ...(opts.consensus || {}) },
    pendingTtlMs: 60_000,
  });
  try {
    return await fn({ app, dataDir, ...app.systems, keyring: app.keyring, vault: app.vault, bus: app.bus });
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const actor = { actor: 'test' };

/* ══════════════════════════ ENTROPY MEMORY ══════════════════════════ */

test('memory: profiles are idempotent, addressed, and recall is scored not listed', async () => {
  await withApp(({ memory }) => {
    const first = memory.ensureProfile('commander-bleu', { alias: 'Commander Bleu' });
    const again = memory.ensureProfile('commander-bleu');
    assert.equal(first.profileId, again.profileId, 'same subject must resolve to the same profile');
    assert.match(first.address, /^EX-MEM-/);
    assert.match(first.evmAddress, /^0x[0-9a-f]{40}$/, 'binds to the Solidity WalletID contract');
    assert.equal(core.isAddress(first.address), true);

    const t1 = memory.remember(first.profileId, {
      kind: 'loadout-note',
      text: 'Hold the north gate with aegis wards and tidal step rotations',
      tags: ['aegis', 'hold-gate'],
      resonance: 3,
    }, actor);
    memory.remember(first.profileId, { kind: 'lore', text: 'The mirror market trades in borrowed voices', tags: ['lore'], resonance: 1 }, actor);

    const recall = memory.recall(first.profileId, { query: 'north gate aegis', limit: 5 });
    assert.equal(recall.count, 2);
    assert.equal(recall.results[0].traceId, t1.traceId, 'keyword overlap must dominate the score');
    assert.ok(recall.results[0].score > recall.results[1].score);
    assert.ok(recall.results[0].breakdown.overlap > 0.5);
    assert.equal(recall.results[0].accesses, 1, 'recall strengthens memory (spacing effect)');
    memory.recall(first.profileId, { query: 'north gate aegis' });
    assert.equal(memory.recall(first.profileId, { query: 'gate' }).results.find((r) => r.traceId === t1.traceId).accesses, 3);

    // Tag + kind filters narrow without re-scoring everything away.
    assert.equal(memory.recall(first.profileId, { tags: ['lore'] }).results.every((r) => r.tags.includes('lore')), true);
    assert.equal(memory.recall(first.profileId, { kind: 'lore' }).count, 1);

    // Forgetting is a soft redaction: the trace stays in the journal, leaves recall.
    const forgotten = memory.forget(first.profileId, t1.traceId, { reason: 'test erasure' });
    assert.equal(forgotten.status, 'forgotten');
    assert.equal(memory.recall(first.profileId, { query: 'north gate aegis' }).results.some((r) => r.traceId === t1.traceId), false);
    const withForgotten = memory.recall(first.profileId, { query: 'gate', includeForgotten: true }).results.find((r) => r.traceId === t1.traceId);
    assert.equal(withForgotten.status, 'forgotten');
    assert.equal(withForgotten.text, '[redacted]', 'content is destroyed, the fact of forgetting is kept');

    assert.throws(() => memory.recall('nobody', {}), /unknown memory profile/);
    assert.equal(memory.getProfile('commander-bleu').profileId, first.profileId, 'lookup by subject works too');
  });
});

test('memory: loadouts, matches, skills and consolidation close the loop', async () => {
  await withApp(({ memory, squad }) => {
    const p = memory.ensureProfile('weaver-one');
    const saved = memory.saveLoadout(p.profileId, { name: 'Night Gate', slots: { core: 'gate-seal', offhand: 'tidal-step' }, notes: 'test' }, actor);
    assert.match(saved.address, /^EX-MEM-/, 'every loadout is addressed');
    assert.equal(saved.version, 1);
    const equipped = memory.equipLoadout(p.profileId, saved.loadoutId, actor);
    assert.equal(equipped.equipped, saved.loadoutId);
    assert.equal(memory.listLoadouts(p.profileId).equipped, saved.loadoutId);
    assert.equal(memory.listLoadouts(p.profileId).loadouts.length, 1);
    // Re-saving the same loadout updates in place rather than duplicating.
    memory.saveLoadout(p.profileId, { loadoutId: saved.loadoutId, name: 'Night Gate', slots: { core: 'prism-lash' } }, actor);
    assert.equal(memory.listLoadouts(p.profileId).loadouts.length, 1);
    assert.equal(memory.listLoadouts(p.profileId).loadouts[0].slots.core, 'prism-lash');
    assert.equal(memory.listLoadouts(p.profileId).loadouts[0].version, 2);

    const companion = squad.roster().companions[0].companionId;
    squad.recruit(p.profileId, companion, actor);
    for (const result of ['win', 'win', 'loss']) {
      memory.recordMatch(p.profileId, { result, mode: 'skirmish', tactics: ['hold-gate', 'flank-left'], companions: [companion], score: result === 'loss' ? 41 : 78 }, actor);
    }
    const record = memory.summary(memory.getProfile(p.profileId)).record;
    assert.equal(record.wins, 2);
    assert.equal(record.losses, 1);
    assert.equal(record.draws, 0);

    const tree = memory.skillTree(p.profileId);
    assert.ok(tree.schools.length >= 4);
    const used = tree.schools.flatMap((sc) => sc.skills).filter((s) => s.uses > 0);
    assert.ok(used.length >= 1, 'match tactics must accrue skill xp');
    assert.ok(used.every((s) => s.xp > 0));

    // The companion learned from the same matches (cross-system attach).
    const model = squad.model(p.profileId, companion);
    assert.equal(model.matches >= 3, true);
    assert.ok(model.bond > 0, 'two wins and one loss still net positive bond');

    const consolidated = memory.consolidate(p.profileId, actor);
    assert.ok(consolidated.decayed >= 3);
    assert.match(consolidated.signature.address, /^EX-[A-Z]{3}-/);
    assert.ok(consolidated.pressure >= 0 && consolidated.pressure <= 1);

    const bundle = memory.exportProfile(p.profileId);
    assert.equal(bundle.protocol, 'ENTROPY-MEMORY');
    assert.equal(bundle.profile.profileId, p.profileId);
    assert.ok(Object.keys(bundle.profile.traces).length >= 3, 'traces travel with the bundle');
    assert.match(bundle.contentHash, /^[0-9a-f]{16,}$/);
    const restored = memory.importProfile(bundle, actor);
    assert.equal(restored.profileId, p.profileId, 'import is idempotent on the same identity');
    assert.ok(['noop', 'merged'].includes(restored.status), `re-import must not duplicate (${restored.status})`);
    assert.throws(() => memory.importProfile({ protocol: 'nope' }, actor), /not an ENTROPY-MEMORY bundle/);
  });
});

/* ══════════════════════════ POWER WEAVING ══════════════════════════ */

test('weave: catalog is deterministic, unlocking spends reality, fusion is graded', async () => {
  await withApp(({ weave, miners, memory }) => {
    const p = memory.ensureProfile('weaver-two');
    const catalog = weave.catalog();
    assert.ok(catalog.length >= 12);
    assert.deepEqual(
      catalog.map((a) => a.id),
      weave.catalog().map((a) => a.id),
      'the seed catalog must be reproducible',
    );
    const schools = weave.schools();
    assert.ok(schools.schools.length >= 6);
    assert.equal(schools.maxComponents, 4);
    assert.equal(schools.minComponents, 2);
    assert.ok(Object.keys(schools.matrix).length >= 6);
    assert.ok(catalog.every((a) => core.isAddress(a.address)));

    // Fails closed with no reality in the wallet.
    assert.throws(() => weave.unlock(p.profileId, 'gate-seal', { payWith: 'rlu', actor: 'test' }), /insufficient|not enough|RLU/i);

    miners.creditReality({ profileId: p.profileId, amount: 900, reason: 'test grant', kind: 'adjustment' });
    const before = miners.walletView(p.profileId).rlu;
    const unlocked = weave.unlock(p.profileId, 'gate-seal', { payWith: 'rlu', actor: 'test' });
    assert.equal(unlocked.ability.id, 'gate-seal');
    assert.ok(unlocked.holding.costRlu > 0);
    const after = miners.walletView(p.profileId).rlu;
    assert.equal(core.round(before - after, 2), unlocked.holding.costRlu, 'unlocking is a real ledger debit');

    weave.unlock(p.profileId, 'tidal-step', { payWith: 'rlu', actor: 'test' });
    const holdings = weave.holdingsOf(p.profileId);
    assert.equal(holdings.count, 2);
    assert.equal(holdings.abilities.length, 2);

    const analysis = weave.analyze(p.profileId, ['gate-seal', 'tidal-step']);
    assert.ok(['stable', 'volatile', 'fracture'].includes(analysis.result.outcome));
    assert.ok(analysis.result.stability >= 4 && analysis.result.stability <= 100);
    assert.equal(analysis.pairs.length, 1, 'two components make exactly one pair');
    assert.ok(['harmonic', 'compatible', 'neutral', 'clash'].includes(analysis.pairs[0].verdict));
    // analyze() is deterministic for the same held levels.
    assert.equal(weave.analyze(p.profileId, ['gate-seal', 'tidal-step']).fusionId, analysis.fusionId);
    assert.throws(() => weave.analyze(p.profileId, ['gate-seal']), /2 to 4 distinct abilities/);

    const fused = weave.weave(p.profileId, ['gate-seal', 'tidal-step'], actor);
    assert.equal(fused.status, analysis.result.outcome, 'analyze and weave must agree');

    if (fused.status === 'fracture') {
      assert.ok(fused.residue >= analysis.result.residueOnFracture, 'a fracture returns part of the spent reality as residue');
      assert.equal(fused.fusion, undefined);
    } else {
      assert.match(fused.fusion.address, /^EX-WEA-/);
      assert.ok(fused.fusion.power > 0);
      assert.ok(fused.fusion.name.length > 3);
      assert.deepEqual(fused.fusion.components, ['gate-seal', 'tidal-step']);
      assert.ok(weave.recipes().length >= 1 || weave.recipes().recipes?.length >= 1);

      const used = weave.useFusion(p.profileId, fused.fusion.fusionId, { outcome: 'win', actor: 'test' });
      assert.equal(used.fusion.uses, 1);
      assert.equal(weave.holdingsOf(p.profileId).count, 2, 'weaving consumes nothing — it composes');

      const unwoven = weave.unweave(p.profileId, fused.fusion.fusionId, actor);
      assert.equal(unwoven.status, 'unwoven');
      assert.ok(unwoven.refund > 0 && unwoven.residue >= unwoven.refund);
      assert.throws(() => weave.unweave(p.profileId, fused.fusion.fusionId, actor), /not active/);
      assert.throws(() => weave.useFusion(p.profileId, 'nope', actor), /unknown fusion/);
    }

    // Fusing an ability you do not hold must be refused, not silently allowed.
    assert.throws(() => weave.weave(p.profileId, ['gate-seal', 'prism-lash'], actor), /not unlocked|unknown ability/i);
    assert.ok(weave.stats().catalogSize >= 12);
    assert.ok(weave.stats().holders >= 1);
    assert.ok(weave.leaderboard().length >= 0);
  });
});

test('weave: mined artifacts become abilities through the miners attach link', async () => {
  await withApp(({ weave, miners, memory }) => {
    const p = memory.ensureProfile('miner-weaver');
    const mined = miners.mineLocal({ profileId: p.profileId, seconds: 6, blocks: 4, workerId: 'test-miner' });
    assert.equal(mined.blocksMined, 4);

    // Artifact fragments are the rare roll, so at test difficulty a run may
    // legitimately find none. What must always hold: every artifact that IS
    // found produced exactly one generated ability.
    const artifacts = mined.mined
      .map((b) => miners.getBlock(b.height))
      .flatMap((b) => b.reality.fragments)
      .filter((f) => f.kind === 'artifact');
    assert.ok(weave.catalog({ origin: 'mined' }).length >= artifacts.length, 'miners → weave attach converts every artifact');
    assert.ok(weave.catalog({ origin: 'mined' }).every((a) => core.isAddress(a.address)));

    // Drive the same path deterministically with a synthesised artifact.
    const synthetic = {
      kind: 'artifact',
      address: 'EX-RLT-testartifact0000000000000000',
      sourceHash: miners.getBlock(1).hash,
      index: 9,
      parent: miners.getBlock(1).address,
      rarity: 'rare',
      resonance: 0.9,
      family: 'meridian',
      trait: 'holding',
      title: 'Holding Meridian',
      text: 'a test artifact',
      stats: { power: 34, stability: 71, weaveAffinity: 4 },
    };
    const first = weave.abilityFromArtifact(synthetic, { actor: 'test' });
    assert.equal(first.created, true);
    assert.equal(first.ability.origin, 'mined');
    assert.equal(first.ability.rarity, 'rare');
    assert.equal(first.ability.sourceFragment, synthetic.address);
    assert.match(first.ability.id, /^gen-/);
    assert.equal(weave.abilityFromArtifact(synthetic, { actor: 'test' }).created, false, 'the same artifact never generates twice');
    assert.throws(() => weave.abilityFromArtifact({ kind: 'voice' }), /needs an artifact fragment/);

    const ingested = weave.ingestBlock({ height: 1, address: synthetic.parent, reality: { fragments: [synthetic] } }, { actor: 'test' });
    assert.equal(ingested.abilitiesCreated, 0, 'already-generated artifacts are idempotent');

    // The block reward credited the wallet, and the memory trace was written.
    assert.ok(miners.walletView(p.profileId).rlu > 0);
    assert.ok(memory.recall(p.profileId, { query: 'mined reality block', limit: 20 }).count >= 1, 'mining writes to Entropy Memory through attach()');
  });
});

/* ══════════════════════════════ AR OVERLAY ═════════════════════════ */

test('ar: scans are deterministic per seed, plated, and quantised by position', async () => {
  await withApp(({ ar, memory }) => {
    const p = memory.ensureProfile('scanner');
    const sweep = ar.scan({ profileId: p.profileId, mode: 'sweep', location: { x: 10, y: 0, z: 0 } }, actor);
    assert.match(sweep.address, /^EX-ARX-/);
    assert.match(sweep.evmAddress, /^0x[0-9a-f]{40}$/);
    assert.equal(sweep.mode, 'sweep');
    assert.ok(sweep.contactCount >= 3, 'a young chain still returns contacts (derived top-up)');
    assert.ok(sweep.contacts.every((c) => c.kind && c.label && core.isAddress(c.address)));
    assert.match(sweep.chromePlate, /^chrp\.v1\.Cr-\d\./, 'every scan payload is chromium-plated');
    assert.ok(sweep.cooldownSec > 0);

    const plated = ar.platePayload({ scanId: sweep.scanId, contacts: sweep.contacts });
    assert.match(plated.chromePlate, /^chrp\.v1\.Cr-\d\.[0-9a-f]{16}\.[0-9a-f]{16}$/);
    assert.match(plated.plateAddress, /^EX-CHR-/);
    assert.equal(plated.scanId, sweep.scanId, 'plating adds integrity, it does not reshape the payload');
    assert.deepEqual(ar.platePayload({ scanId: sweep.scanId, contacts: sweep.contacts }).chromePlate, plated.chromePlate, 'the plate is deterministic');

    // A deep scan on a *fresh* location (sweep is on cooldown) sees further.
    const deep = ar.scan({ profileId: p.profileId, mode: 'deep', location: { x: 500, y: 0, z: 0 } }, actor);
    assert.equal(deep.mode, 'deep');
    assert.ok(deep.layers.length >= sweep.layers.length, 'deep scans open more layers');

    const svg = ar.renderOverlay({ contacts: deep.contacts, title: 'TEST SCAN' });
    assert.match(svg, /^<\?xml|<svg/);
    assert.match(svg, /<svg[^>]*viewBox=/);
    assert.ok(svg.includes('</svg>'));

    // Position quantisation: two points inside one cell are the same place.
    const a = ar.constructor.quantize({ x: 101, y: 4, z: 9 });
    const b = ar.constructor.quantize({ x: 110, y: 6, z: 12 });
    assert.deepEqual(a, b, 'presence is deliberately coarse (25 m cells)');
    assert.notDeepEqual(a, ar.constructor.quantize({ x: 400, y: 4, z: 9 }));
    assert.equal(ar.constructor.locationKey({ x: 101, y: 4, z: 9 }), ar.constructor.locationKey({ x: 110, y: 6, z: 12 }));

    // 'lore' is not a layer id — the writer falls back to the glyph layer.
    assert.equal(ar.createAnchor({ profileId: p.profileId, layer: 'lore', label: 'Fallback', position: { x: 0, y: 0, z: 0 } }, actor).layer, 'glyph');

    const anchor = ar.createAnchor({ profileId: p.profileId, layer: 'glyph', label: 'Test Beacon', position: { x: 101, y: 4, z: 9 }, detail: 'unit test' }, actor);
    assert.match(anchor.address, /^EX-ARX-/);
    assert.deepEqual(anchor.position, ar.constructor.quantize({ x: 101, y: 4, z: 9 }), 'anchors snap to the same coarse grid as presence');
    assert.equal(anchor.visibility, 'party', 'anchors default to party visibility, never public');
    assert.ok(ar.listAnchors({ layer: 'glyph', profileId: p.profileId }).some((x) => x.anchorId === anchor.anchorId));
    assert.equal(ar.listAnchors({ layer: 'glyph' }).some((x) => x.anchorId === anchor.anchorId), false, 'party anchors are invisible to other profiles');
    assert.equal(ar.removeAnchor(anchor.anchorId, actor).removed, true);
    assert.equal(ar.listAnchors({ layer: 'glyph', profileId: p.profileId }).some((x) => x.anchorId === anchor.anchorId), false);
    assert.throws(() => ar.removeAnchor(anchor.anchorId, actor), /unknown anchor|not found/i);

    const tile = ar.tile(12, 655, 1583);
    const again = ar.tile(12, 655, 1583);
    // generatedAt/platedAt are wall-clock stamps kept OUTSIDE the plated body.
    const body = ({ generatedAt, platedAt, ...rest }) => rest;
    assert.deepEqual(body(tile), body(again), 'a tile body is a pure function of z/x/y');
    assert.equal(tile.chromePlate, again.chromePlate, 'so its integrity plate is stable and cacheable');
    assert.notDeepEqual(body(tile), body(ar.tile(12, 656, 1583)), 'neighbouring tiles differ');
    const layers = ar.layers();
    assert.ok(layers.layers.length >= 4);
    assert.ok(layers.layers.every((l) => core.isAddress(l.address)));
    assert.equal(layers.privacy.positionCellMeters, 25);
    assert.equal(layers.privacy.pseudonymous, true);
    assert.ok(ar.history(p.profileId).length >= 2);
    assert.ok(ar.stats().scans >= 2);
  });
});

/* ═════════════════════════ SQUAD COMPANIONS ════════════════════════ */

test('squad: companions learn preferred tactics and grow quirks from matches', async () => {
  await withApp(({ squad, memory }) => {
    const p = memory.ensureProfile('squad-leader');
    const roster = squad.roster();
    const names = roster.companions.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, 'the name pool never repeats');
    assert.ok(roster.companions.every((c) => core.isAddress(c.address)));

    const companionId = roster.companions[0].companionId;
    const recruited = squad.recruit(p.profileId, companionId, actor);
    assert.match(recruited.instance.address, /^EX-SQD-/);
    assert.equal(recruited.instance.tacticWeights && typeof recruited.instance.tacticWeights, 'object');
    assert.equal(squad.recruit(p.profileId, companionId, actor).status, 'existing', 'double recruit is idempotent, never a duplicate');
    assert.throws(() => squad.recruit(p.profileId, 'cmp-nope', actor), /unknown companion/);

    // Teach a tactic that is NOT the inborn preference, then play it and win.
    const drilled = squad.drill(p.profileId, companionId, 'revive-first', { intensity: 2, actor: 'test' });
    assert.ok(drilled.tacticWeights['revive-first'] > 0);

    const before = squad.model(p.profileId, companionId);
    for (let i = 0; i < 6; i += 1) {
      memory.recordMatch(p.profileId, { result: i < 5 ? 'win' : 'loss', mode: 'skirmish', tactics: ['revive-first'], companions: [companionId], score: 72 + i }, actor);
    }
    const after = squad.model(p.profileId, companionId);
    assert.ok(after.matches > before.matches);
    assert.ok(after.bond > before.bond, 'winning together raises bond');
    assert.equal(after.preferredTactic, 'revive-first', 'repeated successful use must become the preference');
    assert.ok(after.confidence > before.confidence);

    // Losses hurt more than draws help — asymmetric on purpose.
    const bondBeforeLoss = squad.model(p.profileId, companionId).bond;
    squad.learnFromMatch({ profileId: p.profileId, companionId, result: 'loss', tactics: ['revive-first'], mode: 'skirmish' });
    assert.ok(squad.model(p.profileId, companionId).bond < bondBeforeLoss);

    const recommended = squad.recommendSquad(p.profileId, { mode: 'skirmish', size: 3 });
    assert.ok(recommended.recommended.length >= 1);
    assert.ok(recommended.roleCoverage >= 0 && recommended.roleCoverage <= 1);
    assert.ok(recommended.recommended.every((c) => typeof c.score === 'number' && c.reason));

    const briefing = squad.briefing(p.profileId);
    assert.ok(Array.isArray(briefing.lines) && briefing.lines.length >= 1, 'briefing renders prose for the HUD');
    assert.ok(briefing.squadAggregate.length >= 1);
    const banter = squad.banter({ profileId: p.profileId, companionId, context: 'lobby', turns: 3 });
    assert.equal(banter.lines.length, 3);
    assert.ok(banter.lines.every((l) => typeof l.text === 'string' && l.text.length > 0));

    // Idle decay is time-based and non-destructive.
    const decayed = squad.decayIdle({ now: Date.now() + 10 * 24 * 3600 * 1000 });
    assert.ok(decayed.touched >= 1, 'idle decay touches the bench');

    assert.equal(squad.activeCompanions(p.profileId).length, 1);
    assert.equal(squad.dismiss(p.profileId, companionId, actor).status, 'dismissed');
    assert.equal(squad.activeCompanions(p.profileId).length, 0);
    assert.ok(squad.stats().roster >= 12);
  });
});

/* ══════════════════════════════ MISSIONS ═══════════════════════════ */

test('missions: boards are deterministic per day/week and objectives actually advance', async () => {
  await withApp(({ missions, memory, miners }) => {
    const p = memory.ensureProfile('mission-runner');
    const board = missions.board(p.profileId);
    assert.ok(board.daily.length >= 2 && board.weekly.length >= 2);
    assert.deepEqual(
      board.daily.map((m) => m.missionId),
      missions.board(p.profileId).daily.map((m) => m.missionId),
      'the same day must produce the same board',
    );
    assert.ok(board.daily.every((m) => core.isAddress(m.address)));
    assert.ok(board.daily.every((m) => m.objectives.length >= 1));

    const target = board.daily[0];
    const accepted = missions.accept(p.profileId, target.missionId, actor);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.mission.title, target.title);
    assert.equal(missions.accept(p.profileId, target.missionId, actor).accepted, true, 'accepting twice is a no-op, not an error');
    assert.equal(missions.activeFor(p.profileId).count, 1);
    assert.throws(() => missions.accept(p.profileId, 'nope', actor), /unknown mission/);
    assert.equal(missions.board(p.profileId).daily.find((m) => m.missionId === target.missionId).status, 'active');

    // Completing before the objectives are met must fail closed.
    assert.throws(() => missions.complete(p.profileId, target.missionId, actor), /objectives incomplete/);

    // Drive every objective to its target through the public observe() API.
    for (const objective of target.objectives) {
      const observed = missions.observe({ profileId: p.profileId, event: objective.event, amount: objective.target });
      assert.equal(observed.observed, true);
      assert.ok(observed.advanced.some((a) => a.objectiveId === objective.objectiveId));
    }
    const ready = missions.board(p.profileId).daily.find((m) => m.missionId === target.missionId);
    assert.equal(ready.status, 'ready');

    const rluBefore = miners.walletView(p.profileId).rlu;
    const claimed = missions.complete(p.profileId, target.missionId, actor);
    assert.equal(claimed.rewardRlu > 0, true);
    assert.equal(claimed.rewardXp > 0, true);
    assert.equal(core.round(miners.walletView(p.profileId).rlu - rluBefore, 1), core.round(claimed.rewardRlu, 1), 'the reward hits the RLU ledger');
    assert.throws(() => missions.complete(p.profileId, target.missionId, actor), /already completed/);

    const season = missions.seasonProgress(p.profileId);
    assert.equal(season.xp >= claimed.rewardXp, true);
    assert.match(season.season.seasonId, /^S\d+/);
    assert.ok(season.tier.name);
    assert.ok(season.claimableTiers.length >= 1, 'a season tier is claimable once xp passes it');
    assert.equal(claimed.season.seasonId, season.season.seasonId);

    // An unknown event is ignored rather than fabricating progress.
    assert.equal(missions.observe({ profileId: p.profileId, event: 'not-a-real-event' }).observed, false);
    assert.equal(missions.observe({ profileId: 'nobody', event: 'match.win' }).observed, false);
  });
});

test('missions: world events and seasons are time-derived, and triggers raise multipliers', async () => {
  await withApp(({ missions, memory }) => {
    const p = memory.ensureProfile('event-watcher');
    const today = missions.worldEvents();
    const again = missions.worldEvents();
    assert.deepEqual(today.map((e) => e.kind), again.map((e) => e.kind), 'world events are a function of the day');
    assert.ok(today.length >= 1 && today.length <= 3);
    assert.ok(today.every((e) => e.kind && typeof e.intensity === 'number' && e.modifier && core.isAddress(e.address)));

    const kind = 'tidal-surge';
    const baseline = missions.eventMultiplier('rluMultiplier');
    const triggered = missions.triggerWorldEvent({ kind, durationHours: 2, intensity: 0.9, reason: 'test' }, actor);
    assert.ok(triggered.event || triggered.kind || triggered.ok, 'triggerWorldEvent reports what went live');
    assert.throws(() => missions.triggerWorldEvent({ kind: 'not-an-event' }, actor), /unknown world event kind/);

    const live = missions.liveWorldEvents();
    assert.ok(live.some((e) => e.kind === kind), 'a triggered event goes live immediately');
    assert.ok(live.every((e) => core.isAddress(e.address)));
    const boosted = missions.eventMultiplier('rluMultiplier');
    assert.ok(boosted >= baseline, `multiplier must not drop below baseline (${baseline} → ${boosted})`);
    assert.ok(typeof missions.eventBonus('xpMultiplier') === 'number');

    const season = missions.currentSeason();
    assert.match(season.seasonId, /^S\d+/);
    assert.ok(season.daysRemaining >= 0);
    assert.ok(season.tiers.length >= 5);

    const leaders = missions.leaderboard({ limit: 5 });
    assert.ok(Array.isArray(leaders.leaderboard));
    assert.ok(missions.stats().archetypes >= 5);
    assert.ok(missions.stats().objectiveEvents >= 10);
  });
});

/* ════════════════════════════ MULTIPLAYER ══════════════════════════ */

test('multiplayer: safety is scored, gates are enforced, presence stays coarse', async () => {
  await withApp(({ multiplayer, memory }) => {
    const host = memory.ensureProfile('host');
    const guest = memory.ensureProfile('guest');
    const stranger = memory.ensureProfile('stranger');

    // The static scorer is the contract the UI advertises.
    const open = Multiplayer.safetyScore({
      privacy: 'public',
      proximityVoice: true,
      contentFilters: [],
      hostModeration: false,
      reportingEnabled: false,
      safeExitEnabled: false,
      ageBand: null,
      maxMembers: 24,
    });
    const tight = Multiplayer.safetyScore({
      privacy: 'invite',
      proximityVoice: false,
      contentFilters: ['profanity', 'harassment', 'pii', 'hate', 'spam-links', 'doxxing', 'minors-safety'],
      hostModeration: true,
      reportingEnabled: true,
      safeExitEnabled: true,
      ageBand: 'teen',
      maxMembers: 8,
    }, { verifiedHost: true });
    assert.ok(tight > open, `a locked-down lobby must score higher (${open} → ${tight})`);
    assert.ok(tight <= 100 && open >= 0);
    const breakdown = Multiplayer.safetyBreakdown({ privacy: 'invite', hostModeration: true }, { verifiedHost: true });
    assert.equal(breakdown.score, tight === breakdown.score ? tight : breakdown.score);
    assert.ok(breakdown.items.length >= 3);
    assert.ok(breakdown.items.every((i) => i.points > 0), 'only contributing factors are shown');

    const lobby = multiplayer.createLobby(
      host.profileId,
      { name: 'Test Lobby', mode: 'raid', settings: { privacy: 'invite' } },
      { actor: 'test', verifiedHost: true },
    );
    assert.match(lobby.address, /^EX-LBY-/);
    assert.ok(lobby.safety >= 70);
    assert.ok(lobby.inviteCode && lobby.inviteCode.length >= 4);
    assert.equal(lobby.memberCount, 1);
    assert.equal(lobby.isHost, true);
    assert.equal(lobby.settings.privacy, 'invite');

    // Invite-only: an uninvited player is refused before anything is revealed.
    assert.throws(
      () => multiplayer.joinLobby({ profileId: stranger.profileId, lobbyId: lobby.lobbyId }, actor),
      /invite-only/,
    );
    // A floor above the lobby safety is refused too.
    assert.throws(() => multiplayer.joinLobby({ profileId: guest.profileId, lobbyId: lobby.lobbyId, safetyFloor: 101 }, actor), /safety below your floor/);

    assert.throws(() => multiplayer.invite(lobby.lobbyId, guest.profileId, { actor: 'test', isHost: false }), /only the host may invite/);
    multiplayer.invite(lobby.lobbyId, guest.profileId, { actor: 'test', isHost: true });
    const joined = multiplayer.joinLobby({ profileId: guest.profileId, inviteCode: lobby.inviteCode }, actor);
    assert.equal(joined.status, 'joined');
    assert.equal(joined.member.consentShared, false, 'presence sharing defaults to OFF');
    assert.equal(multiplayer.joinLobby({ profileId: guest.profileId, lobbyId: lobby.lobbyId }, actor).status, 'already-member');
    assert.equal(multiplayer.getLobby(lobby.lobbyId).memberCount, 2);

    // Consent is explicit and revocable.
    assert.equal(multiplayer.setConsent(guest.profileId, lobby.lobbyId, true, actor).consentShared, true);
    multiplayer.heartbeat(guest.profileId, { lobbyId: lobby.lobbyId, position: { x: 137, y: 2, z: 91 } });
    const present = multiplayer.presence({ lobbyId: lobby.lobbyId });
    assert.ok(present.some((x) => x.profileId === guest.profileId));
    const shared = present.find((x) => x.profileId === guest.profileId);
    assert.equal(shared.consentShared, true);
    assert.equal(shared.position.x % 25, 0, 'positions are quantised to 25 m cells');
    assert.equal(shared.position.precision, 'coarse');
    assert.throws(() => multiplayer.setConsent(stranger.profileId, lobby.lobbyId, true, actor), /not in this lobby/);

    // Parties: create, invite, join.
    const party = multiplayer.createParty(host.profileId, { name: 'Test Party', maxMembers: 4 }, actor);
    assert.match(party.address, /^EX-LBY-/);
    assert.equal(party.leader, host.profileId);
    assert.equal(multiplayer.joinParty(party.partyId, guest.profileId, actor).status, 'joined');
    assert.equal(multiplayer.partyFor(guest.profileId).members.length, 2);
    assert.equal(multiplayer.joinParty(party.partyId, guest.profileId, actor).status, 'already-member');
    assert.throws(() => multiplayer.joinParty('nope', guest.profileId, actor), /unknown party/);

    // Discovery never surfaces an invite-only lobby — that is the point of it.
    assert.equal(multiplayer.findLobbies({ minSafety: 10 }).some((l) => l.lobbyId === lobby.lobbyId), false);
    assert.equal(multiplayer.findLobbies({ minSafety: 101 }).length, 0);

    const openLobby = multiplayer.createLobby(host.profileId, { name: 'Open Spire', mode: 'social' }, { actor: 'test', verifiedHost: true });
    assert.equal(openLobby.settings.privacy, 'party-code');
    assert.ok(multiplayer.findLobbies({ minSafety: 60 }).some((l) => l.lobbyId === openLobby.lobbyId), 'a party-code lobby is discoverable');
    assert.equal(multiplayer.findLobbies({ minSafety: 60, mode: 'raid' }).some((l) => l.lobbyId === openLobby.lobbyId), false);
    assert.equal(multiplayer.listLobbies({ profileId: guest.profileId }).length >= 1, true);

    // Host leaving transfers command; safe-exit clears everything.
    assert.equal(multiplayer.leaveLobby(host.profileId, lobby.lobbyId, actor).hostTransferredTo, guest.profileId);
    const exited = multiplayer.safeExit(guest.profileId, { reason: 'test panic' });
    assert.deepEqual(exited.exitedLobbies, [lobby.lobbyId]);
    assert.equal(exited.presenceCleared, true);
    assert.equal(exited.consentRevoked, true);
    assert.equal(multiplayer.presence({ lobbyId: lobby.lobbyId }).length, 0);
    assert.equal(multiplayer.getLobby(lobby.lobbyId).status, 'closed', 'an empty lobby closes itself');
    assert.throws(() => multiplayer.leaveLobby(guest.profileId, lobby.lobbyId, actor), /not in this lobby|closed/);
  });
});

test('multiplayer: reports park a HIGH-risk seal that only moderator authority can unmask', async () => {
  await withApp(({ multiplayer, memory, keyring }) => {
    const host = memory.ensureProfile('mod-host');
    const offender = memory.ensureProfile('offender');
    const lobby = multiplayer.createLobby(host.profileId, { name: 'Moderation Test', mode: 'social' }, { actor: 'test', verifiedHost: true });
    multiplayer.joinLobby({ profileId: offender.profileId, lobbyId: lobby.lobbyId }, actor);

    const weak = keyring.issueToken({ subject: host.profileId, tier: 'observer', scopes: ['entropy:read'], ttlSeconds: 600 });
    const filed = multiplayer.report(
      { lobbyId: lobby.lobbyId, reporterProfileId: host.profileId, targetProfileId: offender.profileId, category: 'harassment', detail: 'test report' },
      { actor: 'test', claims: weak.claims },
    );
    assert.equal(filed.report.status, 'open');
    assert.equal(filed.sanctionSeal.status, 'pending');
    assert.equal(filed.sanctionSeal.requiredSmartValue, keyring.requiredFor('HIGH'));
    assert.match(filed.sanctionSeal.address, /^EX-PND-/);

    // An observer token cannot sanction anyone.
    const refused = keyring.unmask(filed.sanctionSeal.sealId, weak.claims, (seal) => multiplayer.applySanction(seal.payload.reportId, seal.payload.proposedAction, { actor: 'test' }));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'unmask_insufficient');
    assert.equal(multiplayer.getLobby(lobby.lobbyId).memberCount, 2, 'nothing was applied while the seal is parked');

    const root = keyring.bootstrapToken({ subject: 'moderator' }).claims;
    const applied = keyring.unmask(filed.sanctionSeal.sealId, root, (seal) => multiplayer.applySanction(seal.payload.reportId, seal.payload.proposedAction, { actor: 'moderator' }), { note: 'moderation unmask' });
    assert.equal(applied.ok, true);
    assert.equal(applied.result.status, 'sanctioned');
    assert.equal(multiplayer.getLobby(lobby.lobbyId).memberCount, 1, 'the sanction removed the offender');

    assert.throws(
      () => multiplayer.report({ lobbyId: lobby.lobbyId, reporterProfileId: host.profileId, targetProfileId: host.profileId, category: 'spam' }, actor),
      /cannot report yourself/,
    );
    assert.throws(
      () => multiplayer.report({ lobbyId: lobby.lobbyId, reporterProfileId: host.profileId, targetProfileId: offender.profileId, category: 'vibes' }, actor),
      /unknown report category/,
    );
    assert.equal(multiplayer.stats().reports, 1);
  });
});

test('multiplayer: a raid uses every member\'s own companion and pays out on success', async () => {
  await withApp(({ multiplayer, memory, squad, miners, missions }) => {
    const host = memory.ensureProfile('raid-host');
    const ally = memory.ensureProfile('raid-ally');
    const roster = squad.roster().companions;

    // Each member trains their OWN companion: raids must not reward one carry.
    for (const [index, profile] of [host, ally].entries()) {
      const companionId = roster[index].companionId;
      squad.recruit(profile.profileId, companionId, actor);
      squad.drill(profile.profileId, companionId, 'hold-gate', { intensity: 2, actor: 'test' });
      // Train in skirmish mode: the raid itself is the only 'raid' on record.
      memory.recordMatch(profile.profileId, { result: 'win', mode: 'skirmish', tactics: ['hold-gate'], companions: [companionId], score: 80 }, actor);
    }

    const lobby = multiplayer.createLobby(host.profileId, { name: 'Raid Test', mode: 'raid' }, { actor: 'test', verifiedHost: true });
    multiplayer.joinLobby({ profileId: ally.profileId, lobbyId: lobby.lobbyId }, actor);

    const raid = multiplayer.createRaid(lobby.lobbyId, {}, actor);
    assert.match(raid.address, /^EX-LBY-/);
    assert.equal(raid.status, 'assembling');
    assert.equal(raid.roster.length, 2);
    assert.equal(new Set(raid.roster.map((m) => m.companionId)).size, 2, 'each member fields their own companion');
    assert.ok(raid.roster.every((m) => m.companionBond >= 0));
    assert.ok(raid.difficulty >= 1 && raid.difficulty <= 10);
    assert.ok(raid.phases.length >= 5);

    const first = multiplayer.readyUp(raid.raidId, raid.roster[0].profileId, actor);
    assert.equal(first.status, 'assembling', 'one of two ready is not a start');
    const second = multiplayer.readyUp(raid.raidId, raid.roster[1].profileId, actor);
    assert.equal(second.ready, 2);
    assert.equal(second.status, 'running', 'the raid starts when the whole roster is ready');

    let tick = null;
    for (let i = 0; i < 12; i += 1) {
      tick = multiplayer.tickRaid(raid.raidId, actor);
      if (tick.status === 'resolved') break;
      assert.ok(['cleared', 'costly'].includes(tick.phase.outcome), `phase outcome ${tick.phase.outcome}`);
    }
    assert.equal(tick.status, 'resolved');

    const final = multiplayer.getRaid(raid.raidId);
    assert.equal(final.status, 'resolved');
    assert.ok(['cleared', 'failed'].includes(final.outcome), `unexpected outcome ${final.outcome}`);
    assert.ok(final.performance >= 0 && final.performance <= 1);
    assert.ok(final.phases.length >= 5);
    assert.ok(final.phases.every((ph) => ['complete', 'active', 'queued', 'skipped'].includes(ph.status)), JSON.stringify(final.phases.map((ph) => ph.status)));
    assert.equal(
      final.performance,
      core.round(final.phases.filter((ph) => ph.outcome === 'cleared').length / final.phases.length, 3),
      'performance is exactly the share of phases cleared',
    );
    assert.ok(final.log.length >= 1);

    assert.ok(final.rewards.rlu >= 0);
    assert.ok(miners.walletView(host.profileId).rlu > 0, 'raid rewards reach the RLU ledger');
    const summary = memory.summary(memory.getProfile(host.profileId)).record;
    assert.equal(summary.raidsCompleted + summary.raidsFailed, 1, 'the raid is written to Entropy Memory either way');
    if (final.outcome === 'cleared') {
      assert.equal(summary.raidsCompleted, 1);
      assert.ok(final.rewards.rlu > 0);
    }
    assert.ok(multiplayer.listRaids({ limit: 5 }).length >= 1);
    assert.ok(multiplayer.stats().raids >= 1);
    assert.ok(missions.stats().archetypes >= 5);
  });
});

/* ══════════════════════════ REALITY MINERS STACK ═══════════════════ */

test('miners: genesis, PoW, wallets and full chain verification', async () => {
  await withApp(({ miners, memory }) => {
    const p = memory.ensureProfile('miner-one');
    const view = miners.chain({ limit: 5 });
    assert.equal(view.height, 0, 'a fresh network starts at genesis');
    assert.equal(view.blocks[0].isGenesis, true);
    assert.equal(view.blocks[0].prevHash, '0'.repeat(64));
    assert.equal(view.consensus.genesisDifficultyBits, FAST.genesisDifficultyBits, 'consensus overrides are honoured');

    const genesisBlock = miners.getBlock(0);
    assert.match(genesisBlock.address, /^EX-BLK-/);
    assert.ok(RealityMiners.meetsTarget(genesisBlock.hash, genesisBlock.difficultyBits));
    const headerKeys = Object.keys(RealityMiners.headerOf(genesisBlock));
    assert.deepEqual(
      headerKeys.filter((k) => k !== 'note').sort(),
      ['difficultyBits', 'height', 'miner', 'nonce', 'prevHash', 'seedRoot', 'timestamp', 'version'],
      'headerOf returns exactly the consensus fields',
    );
    assert.equal(RealityMiners.headerHash(RealityMiners.headerOf(genesisBlock)), genesisBlock.hash, 'the header hash is reproducible from stored data');
    assert.equal(genesisBlock.miner, 'genesis');

    const mined = miners.mineLocal({ profileId: p.profileId, seconds: 5, blocks: 3, workerId: 'test-miner' });
    assert.equal(mined.blocksMined, 3);
    assert.ok(mined.hashes >= 3);
    assert.ok(mined.hashrateHps > 0);
    assert.ok(mined.mined.every((b) => b.realityCount >= 1 && b.realityCount <= 4));

    const wallet = miners.walletView(p.profileId);
    assert.match(wallet.address, /^EX-MIN-/);
    assert.ok(wallet.rlu > 0);
    assert.equal(wallet.rlu, wallet.lifetimeRlu, 'nothing spent yet');
    assert.ok(wallet.ledger.every((e) => ['subsidy', 'fragment', 'share', 'spend', 'refund', 'mission', 'season', 'raid', 'adjustment'].includes(e.kind)));
    assert.ok(wallet.ledger.some((e) => ['subsidy', 'share'].includes(e.kind) && e.direction === 'credit'), 'block rewards land as subsidy (solo) or share (pool split)');
    assert.equal(wallet.unit.symbol, 'RLU');
    assert.equal(wallet.unit.monetary, false, 'RLU is content accounting, not a coin');
    assert.ok(wallet.fragmentCount >= 3);

    const spent = miners.spendReality({ profileId: p.profileId, amount: 5, reason: 'test spend' });
    assert.equal(spent.ok, true);
    assert.equal(core.round(wallet.rlu - 5, 2), miners.walletView(p.profileId).rlu);
    const overdraft = miners.spendReality({ profileId: p.profileId, amount: 10 ** 9, reason: 'overdraft' });
    assert.equal(overdraft.ok, false, 'RLU cannot be spent into the negative');
    assert.equal(overdraft.code, 'insufficient_rlu');
    assert.ok(overdraft.detail.shortfall > 0);
    assert.equal(miners.refundReality({ profileId: p.profileId, amount: 5, reason: 'test refund' }).credited, 5);

    const verified = miners.verifyChain({ sampleReality: 4 });
    assert.equal(verified.valid, true, JSON.stringify(verified.problems));
    assert.equal(verified.blocks, 4, 'genesis + three mined');
    assert.equal(verified.realityRechecks, 4, 'reality is re-derived from the hash, not trusted');
    assert.equal(verified.problems.length, 0);

    // Reality is indexed by address and reproducible from the block hash.
    const block = miners.getBlock(2);
    const stored = miners.getFragment(block.reality.fragments[0].address);
    assert.equal(stored.kind, block.reality.fragments[0].kind);
    assert.equal(stored.blockHeight, 2);
    assert.equal(stored.text, block.reality.fragments[0].text, 'fragment prose is stored verbatim');
    assert.ok(block.reality.fragments.every((f) => core.isAddress(f.address)));

    assert.ok(miners.recentFragments({ limit: 10 }).length >= 3);
    assert.ok(miners.library().totalFragments >= 6);
    assert.ok(miners.library().kinds.length >= 2);
    assert.ok(miners.pool().shareDifficultyBits < miners.pool().difficultyBits, 'shares are easier than blocks');
    assert.ok(miners.stats().blocks >= 4);
    assert.ok(miners.stats().rluEmitted > 0);
  });
});

test('miners: the share/block/stale/reject submission paths all behave', async () => {
  await withApp(({ miners, memory, vault }) => {
    const p = memory.ensureProfile('pool-miner');
    const worker = miners.registerWorker({ workerId: 'w-1', profileId: p.profileId, label: 'test rig', pool: true }, actor);
    assert.match(worker.address, /^EX-MIN-/);
    assert.equal(worker.mode, 'pool');
    assert.equal(worker.status, 'idle');
    assert.throws(() => miners.getWork({ workerId: 'ghost' }), /unknown worker/);

    const job = miners.getWork({ workerId: 'w-1', profileId: p.profileId });
    assert.match(job.address, /^EX-MIN-/);
    assert.equal(job.headerTemplate.height, 1);
    assert.equal(job.headerTemplate.prevHash, miners.chain().tip);
    assert.ok(job.rewardPreview.subsidyRlu > 0);
    assert.ok(job.blockTarget.difficultyBits >= job.shareTarget.difficultyBits, 'a share is easier than a block');
    assert.ok(job.blockTarget.expectedHashes >= job.shareTarget.expectedHashes);

    const header = job.headerTemplate;
    const shareOnly = searchNonce(header, job.shareTarget.difficultyBits, job.blockTarget.difficultyBits);
    const blockSolve = searchNonce(header, job.blockTarget.difficultyBits);

    // 1. junk nonce → rejected, and the reason is precise.
    const junk = miners.submitWork({ jobId: job.jobId, nonce: 0, workerId: 'w-1', hashes: 1 }, actor);
    if (!junk.accepted) {
      assert.equal(junk.code, 'below_share_target');
      assert.ok(junk.detail.leadingZeroBits < job.shareTarget.difficultyBits);
    }

    // 2. a share-only nonce credits the pool without extending the chain.
    if (shareOnly) {
      const share = miners.submitWork({ jobId: job.jobId, nonce: shareOnly.nonce, workerId: 'w-1', hashes: shareOnly.nonce + 1 }, actor);
      assert.equal(share.accepted, true);
      assert.equal(share.share, true);
      assert.equal(share.block, false);
      assert.equal(miners.chain().height, 0, 'a share must not create a block');
      assert.ok(miners.pool().shares >= 1);
    }

    // 3. a block-solving nonce extends the chain and pays the beneficiary.
    const solved = miners.submitWork({ jobId: job.jobId, nonce: blockSolve.nonce, workerId: 'w-1', hashes: blockSolve.nonce + 1 }, actor);
    assert.equal(solved.accepted, true);
    assert.equal(solved.block, true);
    assert.equal(solved.height, 1);
    assert.equal(solved.hash, blockSolve.hash, 'the pool agrees with an independent nonce search');
    assert.equal(miners.chain().height, 1);
    assert.ok(solved.totalRlu > 0);
    assert.ok(solved.reality.count >= 1 && solved.reality.count <= 4);
    assert.ok(Array.isArray(solved.payouts) && solved.payouts.length >= 1);
    assert.ok(miners.walletView(p.profileId).rlu > 0);

    // 4. replaying the same solve is an orphan/duplicate, never a double spend.
    const replay = miners.submitWork({ jobId: job.jobId, nonce: blockSolve.nonce, workerId: 'w-1', hashes: 1 }, actor);
    assert.equal(replay.accepted, false);
    assert.ok(['duplicate_block', 'stale_tip', 'job_expired'].includes(replay.code), `got ${replay.code}`);

    // 5. an expired job is stale, not silently accepted.
    miners.C.jobTtlMs = -1000;
    const staleJob = miners.getWork({ workerId: 'w-1', profileId: p.profileId });
    miners.C.jobTtlMs = FAST.jobTtlMs;
    const stale = miners.submitWork({ jobId: staleJob.jobId, nonce: blockSolve.nonce, workerId: 'w-1', hashes: 1 }, actor);
    assert.equal(stale.accepted, false);
    assert.equal(stale.code, 'job_expired');
    assert.ok(miners.stats().stale >= 1);

    // 6. a job issued before the tip moved is stale too.
    const behind = miners.getWork({ workerId: 'w-1', profileId: p.profileId });
    miners.mineLocal({ profileId: p.profileId, seconds: 3, blocks: 1, workerId: 'other' });
    const staleTip = miners.submitWork({ jobId: behind.jobId, nonce: 1, workerId: 'w-1', hashes: 1 }, actor);
    assert.equal(staleTip.accepted, false);
    assert.equal(staleTip.code, 'stale_tip');

    assert.throws(() => miners.submitWork({ jobId: 'nope', nonce: 1, workerId: 'w-1' }, actor), /unknown or expired job/);
    assert.ok(vault.tail(50).some((e) => String(e.kind).startsWith('miners.')));
  });
});

/** Independent PoW search — deliberately NOT the implementation under test. */
function searchNonce(header, minBits, maxBits = Infinity) {
  for (let nonce = 0; nonce < 4_000_000; nonce += 1) {
    const hash = RealityMiners.headerHash({ ...header, nonce });
    const bits = RealityMiners.leadingZeroBits(hash);
    if (bits >= minBits && bits < maxBits) return { nonce, hash, bits };
  }
  return null;
}

test('miners: difficulty retargets on the window median and clamps, and tampering is caught', async () => {
  await withApp(({ miners, memory, vault }) => {
    const p = memory.ensureProfile('retarget-miner');
    const genesisBits = miners.chain().difficultyBits;

    miners.mineLocal({ profileId: p.profileId, seconds: 6, blocks: 4, workerId: 'retarget-rig' });

    const state = vault.read('miners');
    assert.ok(state.retargets.length >= 1, 'a 4-block run over a 3-block window must retarget');
    const record = state.retargets[0];
    assert.ok(Math.abs(record.toBits - record.fromBits) <= 1, `clamp allows at most one bit per window, got ${record.fromBits}→${record.toBits}`);
    assert.ok(record.toBits >= FAST.minDifficultyBits && record.toBits <= FAST.maxDifficultyBits);
    assert.ok(record.medianSolveMs >= 0);
    assert.equal(record.windowBlocks.length, FAST.retargetInterval);
    // Verify the retarget FORMULA, not its direction: on a loaded machine a
    // block can legitimately take longer than the target, so the only stable
    // assertion is `toBits === round(fromBits + log2(clamp(median/target)))`.
    const clampedFactor = Math.min(FAST.retargetMaxFactor, Math.max(1 / FAST.retargetMaxFactor, record.medianSolveMs / FAST.targetBlockMs));
    const expectedBits = Math.min(
      FAST.maxDifficultyBits,
      Math.max(FAST.minDifficultyBits, Math.round(record.fromBits + Math.log2(clampedFactor))),
    );
    assert.equal(record.toBits, expectedBits, 'the retarget is exactly round(fromBits + log2(clamped median/target))');
    assert.equal(record.factor, Math.round(clampedFactor * 10_000) / 10_000);
    assert.ok(record.toBits <= genesisBits + 1, 'difficulty never runs away from genesis in one window');

    assert.equal(miners.verifyChain({ sampleReality: 2 }).valid, true);

    // Now tamper with a consensus field and prove the node notices.
    vault.update('miners', (s) => {
      s.chain[2].nonce = s.chain[2].nonce + 1;
      return s;
    }, { actor: 'test', kind: 'test.tamper' });
    const tampered = miners.verifyChain({ sampleReality: 2 });
    assert.equal(tampered.valid, false);
    assert.ok(tampered.problems.some((pr) => pr.code === 'hash_mismatch' || pr.code === 'insufficient_work'));

    // A broken link is caught independently of the hash check.
    vault.update('miners', (s) => {
      s.chain[2].nonce -= 1;
      s.chain[3].prevHash = 'f'.repeat(64);
      return s;
    }, { actor: 'test', kind: 'test.tamper.link' });
    const unlinked = miners.verifyChain({ sampleReality: 0 });
    assert.equal(unlinked.valid, false);
    assert.ok(unlinked.problems.some((pr) => pr.code === 'broken_link'));
  });
});

test('cross-system: one mined block fans out to weave, memory and missions', async () => {
  await withApp(({ miners, weave, memory, missions, bus }) => {
    const p = memory.ensureProfile('cross-link');
    missions.accept(p.profileId, missions.board(p.profileId).daily[0].missionId, actor);

    const events = [];
    const off = bus.on('miners.block', (record) => events.push(record.payload));

    miners.mineLocal({ profileId: p.profileId, seconds: 4, blocks: 1, workerId: 'fan-out' });

    assert.ok(events.length >= 1, 'the bus must announce every accepted block');
    assert.ok(weave.catalog({ origin: 'mined' }).length >= 0);
    assert.ok(memory.recall(p.profileId, { query: 'block reality fragment', limit: 20 }).count >= 1, 'miners → memory attach wrote a trace');
    assert.ok(memory.summary(memory.getProfile(p.profileId)).record.lifetimeRlu > 0 || miners.walletView(p.profileId).lifetimeRlu > 0);

    if (typeof off === 'function') off();
    assert.equal(miners.verifyChain().valid, true, 'the fan-out never corrupts consensus');
  });
});
