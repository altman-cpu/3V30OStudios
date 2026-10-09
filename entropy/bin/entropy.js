#!/usr/bin/env node
'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY CLI  —  one tool for the whole Genesis Unmask stack
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  The CLI boots the exact same wiring as the HTTP server (vault → keyring →
 *  chromium → systems → cross-links), so anything you do here is real state in
 *  the same data directory the API reads. No server required for offline work.
 *
 *  Usage:
 *      node entropy/bin/entropy.js <command> [options]
 *
 *  Commands:
 *      serve       start API + HUD              --port --host --surface --grade
 *      demo        guided end-to-end run        --profile --seconds
 *      status      network status               --json
 *      seed        genesis identity + phrase
 *      token       issue a key auth token       --subject --tier --scopes --ttl --json
 *      verify      verify the reality chain     --sample
 *      chain       print blocks                 --limit --json
 *      mine        mine reality                 --profile --seconds --blocks --threads --json
 *      reality     mined content library        --kind --limit
 *      wallet      RLU balance + ledger         --profile
 *      memory      profile summary              --profile --json
 *      remember    write a memory trace         --profile --kind --text --tags
 *      recall      scored recall                --profile --query --limit
 *      weave       analyze / fuse / unlock      --profile --abilities --action
 *      missions    today's board                --profile --cadence --json
 *      scan        run an AR scan               --profile --mode --layers
 *      squad       companion ops                --profile --action --companion --tactic
 *      lobby       lobby ops                    --profile --action --mode --name
 *      pending     unmask pool                  --action list|cosign|unmask|void --seal
 *      handlers    content handler addresses    --group --json
 *      addresses   derive/inspect an address    --domain --label --sublabel
 *      css         emit generated chromium CSS  --surface --grade --out
 *      openapi     emit the OpenAPI document    --out
 *      events      live world events
 *      journal     audit journal tail           --limit
 *
 *  Global:
 *      --data <dir>   state directory (default <repo>/data/entropy)
 *      --seed <seed>  genesis seed (default env ENTROPY_GENESIS_SEED or stored)
 *      --json         machine-readable output
 *      --help
 */

const path = require('node:path');
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { Worker } = require('node:worker_threads');

const { createApp, ENTROPY_ROOT } = require('../src/api/server');
const core = require('../src/core/entropy-core');
const chromium = require('../src/core/chromium');

const OPTIONS = {
  data: { type: 'string' },
  seed: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  surface: { type: 'string' },
  grade: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  profile: { type: 'string' },
  subject: { type: 'string' },
  tier: { type: 'string' },
  scopes: { type: 'string' },
  ttl: { type: 'string' },
  seconds: { type: 'string' },
  blocks: { type: 'string' },
  threads: { type: 'string' },
  limit: { type: 'string' },
  sample: { type: 'string' },
  kind: { type: 'string' },
  text: { type: 'string' },
  tags: { type: 'string' },
  query: { type: 'string' },
  abilities: { type: 'string' },
  action: { type: 'string' },
  cadence: { type: 'string' },
  mode: { type: 'string' },
  layers: { type: 'string' },
  companion: { type: 'string' },
  tactic: { type: 'string' },
  name: { type: 'string' },
  seal: { type: 'string' },
  domain: { type: 'string' },
  label: { type: 'string' },
  sublabel: { type: 'string' },
  out: { type: 'string' },
  group: { type: 'string' },
  amount: { type: 'string' },
  risk: { type: 'string' },
  note: { type: 'string' },
};

/** The usage block is the file's own header comment — one source of truth. */
const HELP = (fs.readFileSync(path.join(__dirname, 'entropy.js'), 'utf8').match(/\/\*\*([\s\S]*?)\*\//) || [, ''])[1]
  .split('\n')
  .map((line) => line.replace(/^\s*\*\s?/, ''))
  .join('\n')
  .trim();

function out(value, asJson) {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function heading(text) {
  process.stdout.write(`\n${'═'.repeat(Math.min(78, text.length + 6))}\n  ${text}\n${'═'.repeat(Math.min(78, text.length + 6))}\n`);
}

function kv(rows) {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}

async function main() {
  const { values: flags, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: false });
  const command = positionals[0] || 'help';
  const asJson = Boolean(flags.json);

  if (flags.help || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const appOptions = {};
  if (flags.data) appOptions.dataDir = path.resolve(flags.data);
  if (flags.seed) appOptions.seed = flags.seed;
  if (flags.surface) appOptions.surface = flags.surface;
  if (flags.grade) appOptions.grade = flags.grade;
  if (flags.port) appOptions.port = Number(flags.port);
  if (flags.host) appOptions.host = flags.host;

  /* serve keeps the process alive; everything else exits when done. */
  if (command === 'serve') return serve(appOptions);

  const app = createApp(appOptions);
  const { systems, keyring, vault, config } = app;
  const { memory, weave, ar, squad, missions, multiplayer, miners } = systems;
  const profile = flags.profile || flags.subject || 'commander';

  try {
    switch (command) {
      case 'status': {
        const status = {
          network: config.network,
          mode: config.mode,
          dataDir: config.dataDir,
          genesis: { fingerprint: app.genesis.seedFingerprint, phrase: core.entropyPhrase(config.seed, 6) },
          chromium: { alloy: app.alloy().label, grade: app.alloy().grade.grade, address: app.alloy().address },
          handlers: app.registry().count,
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
          season: missions.currentSeason(),
        };
        if (asJson) return out(status, true);
        heading('ENTROPY NETWORK STATUS');
        out(kv([
          ['network', `${config.network} · ${config.mode}`],
          ['data', config.dataDir],
          ['genesis', status.genesis.fingerprint],
          ['phrase', status.genesis.phrase],
          ['chromium', `${status.chromium.alloy} · ${status.chromium.grade}`],
          ['handlers', String(status.handlers)],
          ['chain', `height ${status.systems.miners.height} · ${status.systems.miners.difficultyBits} bits · ${status.systems.miners.fragments} fragments · ${status.systems.miners.rluEmitted} RLU`],
          ['memory', `${status.systems.memory.profiles} profiles · ${status.systems.memory.activeTraces} traces · ${status.systems.memory.totalWins} wins`],
          ['weave', `${status.systems.weave.catalogSize} abilities (${status.systems.weave.minedAbilities} mined) · ${status.systems.weave.activeFusions} fusions · ${status.systems.weave.fractures} fractures`],
          ['squad', `${status.systems.squad.instances} instances · avg bond ${status.systems.squad.averageBond} · ${status.systems.squad.sworn} sworn`],
          ['missions', `${status.systems.missions.completed} completed · ${status.systems.missions.rluPaid} RLU paid · season ${status.season.seasonId}`],
          ['multiplayer', `${status.systems.multiplayer.openLobbies} lobbies · avg safety ${status.systems.multiplayer.averageSafety} · ${status.systems.multiplayer.activeRaids} raids`],
          ['pending', `${status.pending.pending} parked · ${status.pending.unmasked} unmasked · outstanding value ${status.pending.outstandingValue}`],
        ]));
        return undefined;
      }

      case 'seed': {
        const doc = app.genesis;
        const payload = { ...doc, entropyPhrase: core.entropyPhrase(config.seed, 6), alloy: app.alloy() };
        if (asJson) return out(payload, true);
        heading('GENESIS IDENTITY');
        out(kv([
          ['seed fingerprint', doc.seedFingerprint],
          ['entropy phrase', core.entropyPhrase(config.seed, 6)],
          ['created', doc.createdAt],
          ['network', doc.network || config.network],
          ['genesis address', core.deriveAddress({ domain: 'GEN', seed: config.seed, label: 'genesis' }).address],
          ['keyring id', keyring.keyId],
          ['keyring address', keyring.subjectAddress.address],
          ['data dir', config.dataDir],
          ['note', doc.genesisSeed && !flags.seed ? 'seed persisted in vault (env ENTROPY_GENESIS_SEED overrides)' : 'seed supplied for this run'],
        ]));
        return undefined;
      }

      case 'token': {
        const issued = keyring.issueToken({
          subject: flags.subject || profile,
          tier: flags.tier || 'sovereign',
          scopes: flags.scopes ? flags.scopes.split(',').map((s) => s.trim()) : require('../src/core/keyring').ALL_SCOPES,
          ttlSeconds: Number(flags.ttl) || 60 * 60 * 12,
          entropyCredits: Math.round((miners.walletView(flags.subject || profile, { ledgerLimit: 1 }).rlu || 0) / 4),
          pendingBudget: 12,
          root: (flags.tier || 'sovereign') === 'sovereign',
          meta: { issuedBy: 'cli' },
        });
        if (asJson) return out(issued, true);
        heading('KEY AUTH TOKEN');
        out(kv([
          ['subject', issued.claims.sub],
          ['tier', issued.claims.tier],
          ['address', issued.address],
          ['smart value', String(issued.smartValue)],
          ['scopes', issued.claims.scopes.join(', ')],
          ['expires', issued.expiresAt],
          ['phrase', issued.entropyPhrase],
        ]));
        out(`\n  ${issued.token}\n\n  export ENTROPY_TOKEN='${issued.token}'\n`);
        return undefined;
      }

      case 'verify': {
        const result = miners.verifyChain({ sampleReality: Number(flags.sample) || 8 });
        if (asJson) return out(result, true);
        heading('CHAIN VERIFICATION');
        out(kv([
          ['valid', String(result.valid)],
          ['blocks', String(result.blocks)],
          ['height', String(result.height)],
          ['difficulty', `${result.difficultyBits} bits`],
          ['reality rechecks', String(result.realityRechecks)],
          ['problems', String(result.problems.length)],
          ['tip', result.tip],
        ]));
        if (result.problems.length) out(`\n${JSON.stringify(result.problems, null, 2)}`);
        return undefined;
      }

      case 'chain': {
        const chain = miners.chain({ limit: Number(flags.limit) || 12 });
        if (asJson) return out(chain, true);
        heading(`REALITY CHAIN · height ${chain.height} · ${chain.difficultyBits} bits`);
        out(`  ${'h'.padStart(4)}  ${'bits'.padStart(7)}  ${'solve'.padStart(8)}  ${'RLU'.padStart(8)}  fragments  hash`);
        for (const b of chain.blocks) {
          out(`  ${String(b.height).padStart(4)}  ${`${b.leadingZeroBits}/${b.difficultyBits}`.padStart(7)}  ${`${b.solveMs}ms`.padStart(8)}  ${String(b.totalRlu).padStart(8)}  ${String(b.reality.count).padStart(9)}  ${b.hash.slice(0, 24)}…`);
        }
        return undefined;
      }

      case 'mine': {
        const seconds = Number(flags.seconds) || 5;
        const blocks = Number(flags.blocks) || 1;
        const threads = Number(flags.threads) || 0;
        const beneficiary = memory.ensureProfile(profile).profileId;
        if (!asJson) heading(`MINING REALITY · ${blocks} block(s) · ${threads > 1 ? `${threads} threads` : 'single thread'}`);
        const started = Date.now();
        let result;
        if (threads > 1) {
          result = await mineThreaded({ app, beneficiary, blocks, seconds, threads, quiet: asJson });
        } else {
          result = miners.mineLocal({
            profileId: beneficiary,
            seconds,
            blocks,
            workerId: 'cli-solo',
            onProgress: asJson ? null : (p) => process.stdout.write(`\r  searching… ${core.compactNumber(p.hashes)} hashes · ${p.ms}ms · target ${p.difficultyBits} bits   `),
            onBlock: asJson ? null : (b) => process.stdout.write(`\n  ✓ block ${b.height} · ${b.leadingZeroBits} bits · ${b.reality.count} fragments · ${b.totalRlu} RLU · ${b.address}\n`),
          });
        }
        if (!asJson) process.stdout.write('\n');
        if (asJson) return out(result, true);
        heading('MINING RESULT');
        out(kv([
          ['blocks mined', `${result.blocksMined}/${result.blocksRequested}`],
          ['hashes', core.compactNumber(result.hashes)],
          ['elapsed', `${Date.now() - started}ms`],
          ['hashrate', `${core.compactNumber(result.hashrateHps)} H/s`],
          ['height', String(result.height)],
          ['difficulty', `${result.difficultyBits} bits`],
          ['wallet', `${result.wallet?.rlu ?? 0} RLU (lifetime ${result.wallet?.lifetimeRlu ?? 0})`],
        ]));
        for (const block of result.mined) {
          out(`\n  block ${block.height} · ${block.hash.slice(0, 20)}… · ${block.realityCount} fragments · ${block.rlu} RLU`);
          const record = miners.getBlock(block.height);
          for (const fragment of record.reality.fragments) {
            out(`    [${fragment.rarity.padEnd(11)}] ${fragment.kind.padEnd(9)} ${fragment.title || fragment.codename}`);
            out(`                 ${fragment.address}`);
            out(`                 ${fragment.text}`);
          }
        }
        return undefined;
      }

      case 'reality': {
        const library = flags.kind ? { kind: flags.kind, fragments: miners.fragmentsByKind(flags.kind, { limit: Number(flags.limit) || 20 }) } : miners.library({ limitPerKind: Number(flags.limit) || 4 });
        if (asJson) return out(library, true);
        heading('REALITY LIBRARY');
        if (flags.kind) {
          for (const f of library.fragments) out(`  [${f.rarity}] ${f.title}\n    ${f.text}\n    ${f.address}\n`);
        } else {
          for (const group of library.kinds) {
            out(`\n  ${group.kind.toUpperCase()} · ${group.count}`);
            for (const f of group.samples) out(`    [${f.rarity}] ${f.title || f.codename} — ${(f.text || '').slice(0, 96)}`);
          }
        }
        return undefined;
      }

      case 'wallet': {
        const wallet = miners.walletView(memory.ensureProfile(profile).profileId, { ledgerLimit: Number(flags.limit) || 15 });
        if (asJson) return out(wallet, true);
        heading('REALITY WALLET');
        out(kv([
          ['profile', wallet.profileId],
          ['address', wallet.address],
          ['evm form', wallet.evmAddress],
          ['balance', `${wallet.rlu} RLU`],
          ['lifetime', `${wallet.lifetimeRlu} RLU`],
          ['blocks mined', String(wallet.blocksMined)],
          ['fragments held', String(wallet.fragmentCount)],
          ['artifacts', String(wallet.artifacts.length)],
          ['unit note', wallet.unit.note],
        ]));
        out('\n  ledger');
        for (const entry of wallet.ledger) out(`    ${entry.at}  ${entry.direction === 'credit' ? '+' : '−'}${String(entry.amount).padStart(8)}  ${entry.kind.padEnd(9)} ${entry.reason || ''}`);
        return undefined;
      }

      case 'memory': {
        const p = memory.ensureProfile(profile);
        const payload = { summary: memory.summary(p), skills: memory.skillTree(p.profileId), loadouts: memory.listLoadouts(p.profileId), companions: memory.companionBehaviors(p.profileId), graph: memory.graph(p.profileId, { limit: 24 }) };
        if (asJson) return out(payload, true);
        heading(`ENTROPY MEMORY · ${p.alias}`);
        out(kv([
          ['profileId', p.profileId],
          ['address', p.address],
          ['power level', String(memory.powerLevel(p))],
          ['record', `W${p.record.wins} / L${p.record.losses} / D${p.record.draws} · raids ${p.record.raidsCompleted}/${p.record.raidsFailed}`],
          ['rlu lifetime', String(p.record.rluLifetime)],
          ['seals unmasked', String(p.record.sealsUnmasked)],
          ['traces', String(Object.values(p.traces).filter((t) => t.status === 'active').length)],
          ['habits', Object.keys(p.habits).join(', ') || '—'],
          ['signature', p.memorySignature?.address || '—'],
        ]));
        out('\n  skills');
        for (const school of payload.skills.schools) out(`    ${school.school.padEnd(12)} L${String(school.level).padStart(2)}  ${String(school.xp).padStart(6)} xp  ·  ${school.skills.map((s) => `${s.name} L${s.level}`).join(', ')}`);
        out('\n  companions');
        for (const c of payload.companions.companions) out(`    ${c.companionId.padEnd(22)} bond ${String(c.bond).padStart(5)} · ${String(c.matches).padStart(3)} matches · prefers ${c.preferredTactic}`);
        return undefined;
      }

      case 'remember': {
        const p = memory.ensureProfile(profile);
        const trace = memory.remember(p.profileId, { kind: flags.kind || 'note', text: flags.text || 'recorded from the CLI', tags: (flags.tags || '').split(',').map((t) => t.trim()).filter(Boolean), resonance: 1.2, decayDays: 90, source: 'cli' }, { actor: 'cli' });
        if (asJson) return out(trace, true);
        out(`  ✓ trace ${trace.traceId}\n    ${trace.address}\n    ${trace.text}`);
        return undefined;
      }

      case 'recall': {
        const p = memory.ensureProfile(profile);
        const result = memory.recall(p.profileId, { query: flags.query || '', limit: Number(flags.limit) || 8 });
        if (asJson) return out(result, true);
        heading(`RECALL · "${flags.query || ''}"`);
        for (const hit of result.results) out(`  ${String(hit.score).padStart(6)}  [${hit.kind}] ${hit.text}\n          ${hit.address} · overlap ${hit.breakdown.overlap} recency ${hit.breakdown.recency} resonance ${hit.breakdown.resonance}`);
        if (!result.results.length) out('  (no matches)');
        return undefined;
      }

      case 'weave': {
        const p = memory.ensureProfile(profile);
        const action = flags.action || 'analyze';
        const abilities = (flags.abilities || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (action === 'catalog') {
          const list = weave.catalog({ limit: Number(flags.limit) || 60 });
          if (asJson) return out(list, true);
          for (const a of list) out(`  ${a.glyph} ${a.id.padEnd(22)} ${a.name.padEnd(26)} ${a.school.padEnd(10)} t${a.tier} p${String(a.power).padStart(3)} s${String(a.stability).padStart(3)} ${String(a.costRlu).padStart(4)} RLU ${a.origin === 'mined' ? '[mined]' : ''}`);
          return undefined;
        }
        if (action === 'unlock') {
          const result = weave.unlock(p.profileId, abilities[0], { payWith: 'rlu', actor: 'cli' });
          return out(asJson ? JSON.stringify(result, null, 2) : `  ✓ unlocked ${result.ability.name} (${result.ability.address})`);
        }
        if (action === 'fuse') {
          const result = weave.weave(p.profileId, abilities, { actor: 'cli' });
          if (asJson) return out(result, true);
          if (result.status === 'fracture') out(`  ✗ ${result.analysis.name} FRACTURED at stability ${result.analysis.result.stability} · +${result.residue} residue`);
          else out(`  ✓ ${result.fusion.name} (${result.fusion.outcome}) · power ${result.fusion.power} · stability ${result.fusion.stability}\n    ${result.fusion.address}`);
          return undefined;
        }
        const analysis = weave.analyze(p.profileId, abilities);
        if (asJson) return out(analysis, true);
        heading('WEAVE ANALYSIS');
        out(kv([
          ['name', analysis.name],
          ['address', analysis.address],
          ['components', analysis.components.map((c) => `${c.name}(${c.school})`).join(' + ')],
          ['pairs', analysis.pairs.map((pair) => `${pair.schools.join('/')} ${pair.synergy > 0 ? '+' : ''}${pair.synergy} ${pair.verdict}`).join(' · ')],
          ['power', `${analysis.result.power} (raw ${analysis.result.preOutcomePower})`],
          ['stability', String(analysis.result.stability)],
          ['resonance', String(analysis.result.resonance)],
          ['outcome', `${analysis.result.outcome} — ${analysis.result.outcomeNote}`],
        ]));
        return undefined;
      }

      case 'missions': {
        const p = memory.ensureProfile(profile);
        const cadence = flags.cadence || null;
        const payload = cadence ? missions.generate(cadence, { limit: Number(flags.limit) || 5 }) : missions.board(p.profileId);
        if (asJson) return out(payload, true);
        heading(cadence ? `MISSIONS · ${cadence}` : `MISSION BOARD · day ${payload.day} · ${payload.season.seasonId}`);
        const sets = cadence ? { [cadence]: payload.missions } : { daily: payload.daily, weekly: payload.weekly, seasonal: payload.seasonal };
        for (const [set, list] of Object.entries(sets)) {
          out(`\n  ${set.toUpperCase()}`);
          for (const m of list) {
            out(`    ${m.title}  [${m.status || 'available'}]  ${m.rewardRlu} RLU / ${m.rewardXp} xp  d${m.difficulty}`);
            out(`      ${m.missionId} · ${m.address}`);
            for (const o of m.objectives) out(`      · ${o.label}: ${o.progress}/${o.target}`);
          }
        }
        out(`\n  world events live: ${missions.liveWorldEvents().map((e) => e.title).join(', ') || 'none'}`);
        return undefined;
      }

      case 'scan': {
        const p = memory.ensureProfile(profile);
        const layers = flags.layers ? flags.layers.split(',').map((s) => s.trim()) : undefined;
        const result = ar.scan({ profileId: p.profileId, mode: flags.mode || 'deep', layers, location: { x: 120, y: -40, z: 8 } }, { actor: 'cli' });
        if (asJson) return out(result, true);
        heading(`AR SCAN · ${result.modeLabel} · ${result.contactCount} contacts`);
        out(kv([
          ['scan', result.scanId],
          ['address', result.address],
          ['location', `${result.location.x}/${result.location.y}/${result.location.z} (quantised ${result.location.cell}m)`],
          ['layers', result.layers.join(', ')],
          ['plate', result.chromePlate],
        ]));
        for (const c of result.contacts) out(`  ${String(c.distanceM).padStart(4)}m  [${c.layer.padEnd(7)}] ${c.kind.padEnd(12)} ${c.label}\n               ${(c.detail || '').slice(0, 96)}\n               ${c.address}`);
        return undefined;
      }

      case 'squad': {
        const p = memory.ensureProfile(profile);
        const action = flags.action || 'briefing';
        if (action === 'roster') {
          const roster = squad.roster();
          if (asJson) return out(roster, true);
          for (const c of roster.companions) out(`  ${c.glyph} ${c.companionId.padEnd(18)} ${c.name.padEnd(10)} ${c.roleLabel.padEnd(10)} ${c.traits.join('/').padEnd(24)} ${c.address}`);
          return undefined;
        }
        if (action === 'recruit') {
          const result = squad.recruit(p.profileId, flags.companion, { actor: 'cli' });
          return out(asJson ? JSON.stringify(result, null, 2) : `  ✓ ${result.status}: ${result.instance.name} (${result.instance.address})`);
        }
        if (action === 'drill') {
          const result = squad.drill(p.profileId, flags.companion, flags.tactic || 'flank-left', { intensity: 1.5, actor: 'cli' });
          if (asJson) return out(result, true);
          out(`  ✓ drilled ${flags.tactic} with ${result.name} · preferred now ${result.preferredTactic} · bond ${result.bond}`);
          return undefined;
        }
        if (action === 'banter') {
          const convo = squad.banter({ profileId: p.profileId, companionId: flags.companion || null, context: flags.mode || 'lobby', turns: 5 });
          if (asJson) return out(convo, true);
          for (const line of convo.lines) out(`  ${line.speaker.padEnd(14)} (${line.mood}) ${line.text}`);
          return undefined;
        }
        if (action === 'recommend') {
          const rec = squad.recommendSquad(p.profileId, { mode: flags.mode || 'raid', size: Number(flags.limit) || 4 });
          if (asJson) return out(rec, true);
          out(`  coverage ${core.round(rec.roleCoverage * 100, 0)}% · missing ${rec.missingRoles?.join(', ') || 'none'}`);
          for (const c of rec.recommended || []) out(`    ${c.name.padEnd(10)} ${c.roleLabel.padEnd(10)} score ${c.score} · prefers ${c.preferredTactic} · bond ${c.bond}`);
          return undefined;
        }
        const briefing = squad.briefing(p.profileId);
        if (asJson) return out(briefing, true);
        heading('SQUAD BRIEFING');
        for (const line of briefing.lines) out(`  · ${line}`);
        return undefined;
      }

      case 'lobby': {
        const p = memory.ensureProfile(profile);
        const action = flags.action || 'list';
        if (action === 'create') {
          const lobby = multiplayer.createLobby(p.profileId, { name: flags.name || null, mode: flags.mode || 'skirmish' }, { actor: 'cli', verifiedHost: true });
          if (asJson) return out(lobby, true);
          out(`  ✓ lobby ${lobby.lobbyId} · safety ${lobby.safety} · code ${lobby.inviteCode}\n    ${lobby.address}`);
          return undefined;
        }
        if (action === 'join') {
          const result = multiplayer.joinLobby({ profileId: p.profileId, lobbyId: flags.name || null, inviteCode: flags.mode || null, safetyFloor: 50 }, { actor: 'cli' });
          return out(asJson ? JSON.stringify(result, null, 2) : `  ✓ ${result.status}`);
        }
        if (action === 'raid') {
          const lobbyId = flags.name;
          const raid = multiplayer.createRaid(lobbyId, {}, { actor: 'cli' });
          if (asJson) return out(raid, true);
          out(`  ✓ raid ${raid.raidId} · difficulty ${raid.difficulty}\n    ${raid.address}`);
          for (const member of raid.roster) multiplayer.readyUp(raid.raidId, member.profileId, { actor: 'cli' });
          for (let i = 0; i < 8; i += 1) {
            const step = multiplayer.tickRaid(raid.raidId, { actor: 'cli' });
            if (step.status === 'resolved') break;
            out(`    phase ${step.phase?.id || 'resolve'} → ${step.phase?.outcome || step.outcome}`);
            if (step.outcome) break;
          }
          const final = multiplayer.getRaid(raid.raidId);
          out(`  outcome ${final.outcome} · performance ${core.round(final.performance * 100, 0)}% · rewards ${JSON.stringify(final.rewards?.rlu)} RLU`);
          return undefined;
        }
        const lobbies = multiplayer.listLobbies({ limit: Number(flags.limit) || 20 });
        if (asJson) return out(lobbies, true);
        heading('LOBBIES');
        for (const l of lobbies) out(`  ${l.lobbyId}  ${l.name.padEnd(26)} ${l.mode.padEnd(10)} safety ${String(l.safety).padStart(3)}  ${l.memberCount}/${l.capacity}  ${l.settings.privacy}  code ${l.inviteCode}`);
        if (!lobbies.length) out('  (none — create one with --action create)');
        return undefined;
      }

      case 'pending': {
        const action = flags.action || 'list';
        if (action === 'stats') return out(keyring.stats(), asJson);
        if (action === 'cosign' || action === 'unmask' || action === 'void') {
          if (!flags.seal) throw new Error('--seal <sealId> is required');
          const claims = keyring.bootstrapToken({ subject: flags.subject || profile }).claims;
          if (action === 'void') return out(keyring.voidPending(flags.seal, claims, flags.note || 'voided from CLI'), asJson);
          if (action === 'cosign') return out(keyring.coSign(flags.seal, claims, flags.note || 'CLI co-sign'), asJson);
          const dispatch = require('../src/api/handlers').buildUnmaskDispatch(systems);
          const seal = keyring.getPending(flags.seal);
          const applier = dispatch[seal?.kind];
          if (!applier) throw new Error(`no dispatcher for kind ${seal?.kind}`);
          return out(keyring.unmask(flags.seal, claims, (s) => applier(s), { note: flags.note || 'CLI unmask' }), asJson);
        }
        const seals = keyring.listPending({ limit: Number(flags.limit) || 25, status: flags.kind || null });
        if (asJson) return out({ pool: keyring.stats(), seals }, true);
        heading('UNMASK POOL');
        out(kv(Object.entries(keyring.stats()).map(([k, v]) => [k, String(v)])));
        out('');
        for (const seal of seals) {
          out(`  [${seal.status.padEnd(9)}] ${seal.sealId}  ${seal.kind.padEnd(24)} required ${String(seal.requiredSmartValue).padStart(5)} · offered ${String(seal.offeredSmartValue).padStart(5)} · cosigns ${seal.coSignatures.length}/${seal.coSignRequired}`);
          out(`              ${seal.address}`);
          out(`              expires ${seal.expiresAt} · subject ${seal.subject}`);
        }
        if (!seals.length) out('  (no seals)');
        return undefined;
      }

      case 'handlers': {
        const registry = app.registry();
        const groups = flags.group ? registry.groups.filter((g) => g.group === flags.group) : registry.groups;
        if (asJson) return out({ ...registry, groups }, true);
        heading(`CONTENT HANDLERS · ${registry.count} · seed ${registry.networkSeedFingerprint}`);
        for (const group of groups) {
          out(`\n  ${group.label}  [${group.address}]`);
          for (const h of group.handlers) {
            out(`    ${h.method.padEnd(6)} ${h.path.padEnd(46)} ${h.entropyAddress}`);
            out(`           ${h.handler.padEnd(30)} risk ${String(h.risk || 'open').padEnd(8)} sv ${String(h.requiredSmartValue).padStart(5)}  scopes ${h.scopes.join(',') || (h.auth ? '—' : 'public')}`);
          }
        }
        return undefined;
      }

      case 'addresses': {
        if (flags.domain && flags.label) {
          const derived = core.deriveAddress({ domain: flags.domain, seed: config.seed, label: flags.label, sublabel: flags.sublabel || '' });
          return out(asJson ? JSON.stringify(derived, null, 2) : kv([['address', derived.address], ['evm', derived.evm], ['digest', derived.digest], ['domain', `${derived.domain} (${derived.domainLabel})`], ['checksum', derived.checksum]]));
        }
        if (positionals[1] && core.isAddress(positionals[1])) {
          const parsed = core.parseAddress(positionals[1]);
          return out(asJson ? JSON.stringify(parsed, null, 2) : kv(Object.entries(parsed).map(([k, v]) => [k, String(v)])));
        }
        heading('ENTROPY ADDRESS DOMAINS');
        for (const [key, dom] of Object.entries(core.DOMAINS)) {
          const example = core.deriveAddress({ domain: key, seed: config.seed, label: 'example', sublabel: key });
          out(`  ${key}  ${dom.label.padEnd(10)} ${example.address.padEnd(34)} ${dom.note}`);
        }
        return undefined;
      }

      case 'css': {
        const alloy = chromium.deriveAlloy({ seed: config.seed, surface: flags.surface || 'bright', grade: flags.grade || 'Cr-7' });
        const css = chromium.toCss(alloy);
        if (flags.out) {
          fs.writeFileSync(path.resolve(flags.out), css, 'utf8');
          return out(`  ✓ wrote ${path.resolve(flags.out)} (${css.length} bytes) · ${alloy.address}`);
        }
        return out(css);
      }

      case 'openapi': {
        const doc = app.openapi();
        const text = JSON.stringify(doc, null, 2);
        if (flags.out) {
          fs.writeFileSync(path.resolve(flags.out), text, 'utf8');
          return out(`  ✓ wrote ${path.resolve(flags.out)} (${Object.keys(doc.paths).length} paths)`);
        }
        return out(text);
      }

      case 'events': {
        const events = missions.liveWorldEvents();
        const scheduled = missions.worldEvents();
        if (asJson) return out({ live: events, scheduledToday: scheduled }, true);
        heading('WORLD EVENTS');
        out('  live now:');
        for (const e of events) out(`    ${e.title.padEnd(22)} ${e.modifier.kind} ×${e.modifier.value} (${e.modifier.scope}) until ${e.endsAt}\n      ${e.address}`);
        if (!events.length) out('    (none)');
        out('\n  scheduled today:');
        for (const e of scheduled) out(`    ${e.title.padEnd(22)} ${e.startsAt.slice(11, 16)}→${e.endsAt.slice(11, 16)} intensity ${e.intensity}`);
        return undefined;
      }

      case 'journal': {
        const events = vault.tail(Number(flags.limit) || 30);
        if (asJson) return out(events, true);
        heading('AUDIT JOURNAL');
        for (const e of events) out(`  ${String(e.seq).padStart(5)}  ${(e.kind || '?').padEnd(28)} ${String(e.domain || '').padEnd(12)} ${String(e.actor || '').padEnd(14)} ${e.reason || ''}`);
        return undefined;
      }

      case 'demo': {
        await runDemo({ app, profile, seconds: Number(flags.seconds) || 3, asJson });
        return undefined;
      }

      default:
        process.stdout.write(`unknown command: ${command}\n\n`);
        process.stdout.write(`${HELP}\n`);
        process.exitCode = 1;
    }
  } finally {
    if (command !== 'serve') await app.close().catch(() => {});
  }
  return undefined;
}

/* ── serve ─────────────────────────────────────────────────────────────── */

async function serve(appOptions) {
  const app = createApp(appOptions);
  const started = await app.listen();
  const banner = started.banner();
  heading(`${banner.title} · v${banner.version} · ${banner.mode}`);
  out(kv([
    ['api', `${banner.url}/v1`],
    ['hud', banner.ui],
    ['stream', `${banner.url}/v1/stream (SSE)`],
    ['openapi', `${banner.url}/v1/openapi.json`],
    ['handlers', `${banner.url}/v1/handlers`],
    ['data', banner.dataDir],
    ['genesis', `${banner.genesis.seedFingerprint} (${banner.genesis.seedSource})`],
    ['phrase', banner.genesis.entropyPhrase],
    ['chromium', `${banner.chromium.alloy} · ${banner.chromium.grade} · ${banner.chromium.address}`],
    ['handler groups', banner.handlers.groups],
    ['chain', `height ${banner.chain.height} · ${banner.chain.difficultyBits} bits`],
    ['risk ladder', banner.riskLadder.join(' · ')],
  ]));
  out(`\n  bootstrap token (tier=${banner.bootstrapToken.tier}, smartValue=${banner.bootstrapToken.smartValue}):\n  ${banner.bootstrapToken.token}\n`);
  out('  quickstart:');
  for (const line of banner.quickstart) out(`    ${line.replace('$URL', banner.url)}`);
  out('\n  press Ctrl-C to stop\n');

  const shutdown = async (signal) => {
    out(`\n  ${signal} — closing entropy`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return new Promise(() => {});
}

/* ── threaded mining ───────────────────────────────────────────────────── */

/**
 * Fan the nonce search out over N worker_threads, take the first solution and
 * submit it through the single-writer path.
 */
async function mineThreaded({ app, beneficiary, blocks, seconds, threads, quiet = false }) {
  const { systems } = app;
  const miners = systems.miners;
  const workerFile = path.join(__dirname, 'miner-worker.js');
  const mined = [];
  let totalHashes = 0;
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;

  const workerId = `cli-thread-${threads}`;
  miners.registerWorker({ workerId, profileId: beneficiary, label: workerId, pool: false });

  while (mined.length < blocks && Date.now() < deadline) {
    const job = miners.getWork({ workerId, profileId: beneficiary });
    const budgetMs = Math.max(500, deadline - Date.now());
    const result = await new Promise((resolve) => {
      const workers = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        for (const w of workers) {
          try { w.terminate(); } catch { /* already gone */ }
        }
        resolve(value);
      };
      for (let i = 0; i < threads; i += 1) {
        // Each worker searches a disjoint nonce lane: i, i+N, i+2N …
        const worker = new Worker(workerFile, {
          workerData: { type: 'work', header: job.headerTemplate, difficultyBits: job.headerTemplate.difficultyBits, startNonce: i, step: threads, budgetMs },
        });
        workers.push(worker);
        worker.on('message', (msg) => {
          if (msg.type === 'found') finish({ found: true, nonce: msg.nonce, hash: msg.hash, hashes: msg.hashes, lane: i });
          else if (msg.type === 'exhausted' || msg.type === 'progress') totalHashes += msg.hashes || 0;
        });
        worker.on('error', (err) => {
          if (!quiet) process.stdout.write(`  worker ${i} error: ${err.message}\n`);
          finish({ found: false, hashes: 0 });
        });
      }
      setTimeout(() => finish({ found: false, hashes: 0, timedOut: true }), budgetMs + 500);
    });

    if (!result.found) break;
    totalHashes += result.hashes || 0;
    const submission = miners.submitWork({ jobId: job.jobId, nonce: result.nonce, workerId, hashes: result.hashes || 1, profileId: beneficiary }, { actor: beneficiary });
    if (submission.accepted && submission.block) {
      mined.push({ height: submission.height, hash: submission.hash, address: submission.address, rlu: submission.totalRlu, realityCount: submission.reality.count, rarest: submission.reality.rarest, solveMs: submission.solveMs, difficultyBits: submission.difficultyBits, leadingZeroBits: submission.leadingZeroBits });
      if (!quiet) process.stdout.write(`  ✓ block ${submission.height} via ${threads} threads · ${submission.leadingZeroBits} bits · ${submission.reality.count} fragments · ${submission.totalRlu} RLU\n`);
    } else if (!submission.accepted) {
      if (!quiet) process.stdout.write(`  ✗ submission rejected: ${submission.code}\n`);
      break;
    }
  }

  const elapsedMs = Math.max(1, Date.now() - startedAt);
  return {
    profileId: beneficiary,
    blocksRequested: blocks,
    blocksMined: mined.length,
    hashes: totalHashes,
    threads,
    elapsedMs,
    hashrateHps: core.round(totalHashes / (elapsedMs / 1000), 1),
    mined,
    tip: app.systems.miners.stats().tip,
    height: app.systems.miners.stats().height,
    difficultyBits: app.systems.miners.stats().difficultyBits,
    wallet: miners.walletView(beneficiary, { ledgerLimit: 6 }),
  };
}

/* ── demo ──────────────────────────────────────────────────────────────── */

async function runDemo({ app, profile, seconds = 3, asJson = false }) {
  const { systems, keyring } = app;
  const { memory, weave, ar, squad, missions, multiplayer, miners } = systems;
  const steps = [];
  const step = (name, value) => {
    steps.push({ name, value });
    if (!asJson) out(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2).split('\n').map((l) => `  ${l}`).join('\n')}`);
  };

  const p = memory.ensureProfile(profile, { alias: 'Commander Bleu' });
  step('1 · Entropy Memory profile', kv([['profileId', p.profileId], ['address', p.address], ['evm', p.evmAddress], ['power level', String(memory.powerLevel(p))], ['signature', p.memorySignature.address]]));

  // Accept the cadence missions FIRST: everything the demo does afterwards then
  // counts toward them, exactly like a player who reads the board before playing.
  const earlyBoard = missions.board(p.profileId);
  const acceptedIds = [...earlyBoard.daily, ...earlyBoard.weekly].slice(0, 4).map((m) => {
    missions.accept(p.profileId, m.missionId, { actor: 'cli' });
    return `${m.title} (${m.cadence})`;
  });
  step('2 · missions accepted', acceptedIds.join('\n') || '(none generated)');

  const roster = squad.roster();
  const recruits = roster.companions.slice(0, 3).map((c) => squad.recruit(p.profileId, c.companionId, { actor: 'cli' }).instance);
  step('3 · squad recruited', recruits.map((c) => `${c.name} (${c.role}) prefers ${c.preferredTactic} · ${c.address}`).join('\n'));

  const mined = miners.mineLocal({ profileId: p.profileId, seconds, blocks: 3, workerId: 'demo-miner' });
  const wallet = miners.walletView(p.profileId, { ledgerLimit: 3 });
  step('4 · mined reality', kv([['blocks', `${mined.blocksMined}/${mined.blocksRequested}`], ['hashes', core.compactNumber(mined.hashes)], ['hashrate', `${core.compactNumber(mined.hashrateHps)} H/s`], ['wallet', `${wallet.rlu} RLU (lifetime ${wallet.lifetimeRlu})`], ['fragments', mined.mined.map((b) => b.realityCount).join(', ')]]));

  const generated = weave.catalog({ origin: 'mined' });
  const unlockable = [
    ...generated.slice(0, 2).map((a) => a.id),
    'tidal-step',
    'gate-seal',
    'mark-relay',
  ].filter(Boolean);
  const unlocked = [];
  for (const id of unlockable) {
    try {
      weave.unlock(p.profileId, id, { payWith: 'rlu', actor: 'cli' });
      unlocked.push(id);
    } catch (err) {
      steps.push({ name: `unlock skipped ${id}`, value: err.message });
    }
  }
  step('5 · abilities unlocked', unlocked.join(', ') || '(none — mine more reality)');

  let fusion = null;
  for (let i = 0; i + 1 < unlocked.length && !fusion; i += 1) {
    const pair = [unlocked[i], unlocked[i + 1]];
    const analysis = weave.analyze(p.profileId, pair);
    if (analysis.result.outcome !== 'fracture') {
      const result = weave.weave(p.profileId, pair, { actor: 'cli' });
      if (result.fusion) fusion = result.fusion;
    }
  }
  step('6 · power weaving', fusion ? kv([['name', fusion.name], ['address', fusion.address], ['power', String(fusion.power)], ['stability', String(fusion.stability)], ['outcome', fusion.outcome]]) : 'no stable pair found — the loom is honest about that');

  // Train the bench first: drills sharpen tactic weights, matches raise bond.
  // This is the loop the raid maths rewards — capability is learned, not bought.
  const trainingLog = [];
  for (const companion of recruits) {
    squad.drill(p.profileId, companion.companionId, 'hold-gate', { intensity: 2, actor: 'cli' });
    squad.drill(p.profileId, companion.companionId, 'revive-first', { intensity: 1.5, actor: 'cli' });
    trainingLog.push(`${companion.name}: drilled hold-gate + revive-first`);
  }
  for (let i = 0; i < 3; i += 1) {
    memory.recordMatch(p.profileId, { result: i === 2 ? 'loss' : 'win', mode: 'skirmish', tactics: ['hold-gate', 'revive-first'], companions: recruits.map((c) => c.companionId), score: 70 + i * 4 }, { actor: 'cli' });
  }
  step('6b · squad training', trainingLog.concat(recruits.map((c) => {
    const model = squad.model(p.profileId, c.companionId);
    return `${c.name} → prefers ${model.preferredTactic} · bond ${model.bond} · confidence ${core.round(model.confidence * 100, 0)}% · quirks ${(model.quirks || []).map((q) => q.label).join('/') || 'none'}`;
  })).join('\n'));

  memory.saveLoadout(p.profileId, { name: 'Demo Night Gate', slots: { core: 'gate-seal', offhand: 'tidal-step', visor: 'prism-lash', sigil: fusion?.address || null }, notes: 'built by the CLI demo' }, {});
  step('7 · loadout saved', memory.listLoadouts(p.profileId).loadouts.map((l) => `${l.name} → ${l.address}`).join('\n'));

  const scan = ar.scan({ profileId: p.profileId, mode: 'deep', location: { x: 120, y: -40, z: 8 } }, { actor: 'cli' });
  step('8 · AR deep scan', kv([['scan', scan.scanId], ['address', scan.address], ['contacts', String(scan.contactCount)], ['plate', scan.chromePlate], ['top', (scan.contacts[0] ? `${scan.contacts[0].label} (${scan.contacts[0].rarity || scan.contacts[0].kind})` : '—')]]));

  memory.recordMatch(p.profileId, { result: 'win', mode: 'skirmish', tactics: ['flank-left', 'overwatch'], companions: recruits.map((c) => c.companionId), score: 84 }, { actor: 'cli' });
  const afterBoard = missions.board(p.profileId);
  const ready = [...afterBoard.daily, ...afterBoard.weekly].filter((m) => m.status === 'ready');
  const claimed = ready.map((m) => missions.complete(p.profileId, m.missionId, { actor: 'cli' }));
  const inProgress = [...afterBoard.daily, ...afterBoard.weekly]
    .filter((m) => m.status === 'active')
    .map((m) => `${m.title}: ${m.objectives.map((o) => `${o.label} ${o.progress}/${o.target}`).join(' · ')}`);
  step('9 · mission progress', kv([
    ['accepted', String(acceptedIds.length)],
    ['ready → claimed', String(claimed.length)],
    ['paid', claimed.map((c) => `${c.title} +${c.rewardRlu} RLU / +${c.rewardXp} xp`).join(', ') || '—'],
    ['season xp', String(missions.seasonProgress(p.profileId).xp)],
    ['still running', inProgress.join(' | ') || '—'],
  ]));

  const lobby = multiplayer.createLobby(p.profileId, { name: 'Demo Raid Lobby', mode: 'raid' }, { actor: 'cli', verifiedHost: true });
  const allyNotes = [];
  for (const [index, companionProfile] of ['demo-ally-1', 'demo-ally-2'].entries()) {
    const ally = memory.ensureProfile(companionProfile, { alias: `Ally ${index + 1}` });
    multiplayer.joinLobby({ profileId: ally.profileId, lobbyId: lobby.lobbyId, inviteCode: lobby.inviteCode, safetyFloor: 50 }, { actor: 'cli' });
    // A prepared party beats a carried one: give each ally a trained companion.
    const allyCompanion = roster.companions[(index + 3) % roster.companions.length];
    squad.recruit(ally.profileId, allyCompanion.companionId, { actor: 'cli' });
    squad.drill(ally.profileId, allyCompanion.companionId, 'hold-gate', { intensity: 2, actor: 'cli' });
    memory.recordMatch(ally.profileId, { result: 'win', mode: 'skirmish', tactics: ['hold-gate'], companions: [allyCompanion.companionId], score: 66 }, { actor: 'cli' });
    const allyModel = squad.model(ally.profileId, allyCompanion.companionId);
    allyNotes.push(`${ally.alias} + ${allyModel.name} (${allyModel.role}) bond ${allyModel.bond} prefers ${allyModel.preferredTactic}`);
  }
  const liveLobby = multiplayer.getLobby(lobby.lobbyId);
  step('8b · party prepared', kv([['lobby safety', String(liveLobby.safety)], ['invite code', liveLobby.inviteCode], ['members', `${liveLobby.memberCount}/${liveLobby.capacity}`], ...allyNotes.map((n, i) => [`ally ${i + 1}`, n])]));
  const raid = multiplayer.createRaid(lobby.lobbyId, {}, { actor: 'cli' });
  for (const member of raid.roster) multiplayer.readyUp(raid.raidId, member.profileId, { actor: 'cli' });
  let tick = null;
  for (let i = 0; i < 10; i += 1) {
    tick = multiplayer.tickRaid(raid.raidId, { actor: 'cli' });
    if (tick.status === 'resolved' || tick.outcome) break;
  }
  const finalRaid = multiplayer.getRaid(raid.raidId);
  step('10 · co-op raid', kv([['lobby', `${lobby.name} · safety ${lobby.safety} · code ${lobby.inviteCode}`], ['lobby address', lobby.address], ['raid', `${raid.raidId} · difficulty ${raid.difficulty}`], ['raid address', raid.address], ['outcome', `${finalRaid.outcome} · performance ${core.round(finalRaid.performance * 100, 0)}%${finalRaid.outcome === 'cleared' ? '' : ' · clear needs ≥50% phases and <3 costly'}`], ['rewards', `${finalRaid.rewards?.rlu} RLU · ${finalRaid.rewards?.fragments?.length || 0} fragments`]]));

  const weak = keyring.issueToken({ subject: p.profileId, tier: 'observer', scopes: ['entropy:read', 'weave:write'], ttlSeconds: 600, entropyCredits: 0, pendingBudget: 1 });
  const seal = keyring.parkPending({ kind: 'weave.fuse', payload: { profileId: p.profileId, abilityIds: unlocked.slice(0, 2) }, claims: weak.claims, requiredSmartValue: keyring.requiredFor('HIGH'), handler: 'weave.fuse', reason: 'demo: observer token cannot fuse' });
  const rootClaims = keyring.bootstrapToken({ subject: 'commander' }).claims;
  const dispatch = require('../src/api/handlers').buildUnmaskDispatch(systems);
  const unmasked = keyring.unmask(seal.sealId, rootClaims, (s) => dispatch[s.kind](s), { note: 'demo unmask' });
  step('11 · smart-value gate → genesis unmask', kv([
    ['observer smart value', String(weak.smartValue)],
    ['required for HIGH', String(keyring.requiredFor('HIGH'))],
    ['seal', `${seal.sealId} · ${seal.address}`],
    ['unmasked by', `${unmasked.ok ? rootClaims.sub : 'FAILED'} (authority ${unmasked.seal?.unmaskAuthority ?? '—'})`],
    ['pool', JSON.stringify(keyring.stats())],
  ]));

  const verification = miners.verifyChain({ sampleReality: 6 });
  step('12 · chain verification', kv([['valid', String(verification.valid)], ['blocks', String(verification.blocks)], ['reality rechecks', String(verification.realityRechecks)], ['problems', String(verification.problems.length)]]));

  const finalMemory = memory.summary(memory.getProfile(p.profileId));
  step('13 · what memory kept', kv([
    ['wins', String(finalMemory.record.wins)],
    ['raids', `${finalMemory.record.raidsCompleted}/${finalMemory.record.raidsFailed}`],
    ['traces', String(finalMemory.traces)],
    ['companions', String(finalMemory.companions)],
    ['power level', String(finalMemory.level)],
    ['signature', finalMemory.memorySignature?.address || '—'],
  ]));

  if (asJson) out(steps, true);
  else out('\n  demo complete — run `node entropy/bin/entropy.js serve` and open the HUD to drive all of this live.\n');
}

main().catch((err) => {
  process.stderr.write(`\n  entropy: ${err.message}\n${err.stack ? `  ${err.stack.split('\n').slice(1, 4).join('\n  ')}\n` : ''}\n`);
  process.exitCode = 1;
});
