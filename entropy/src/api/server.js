'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY APP / SERVER  —  bootstrap, wiring, generated assets, timers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Start order matters and is the whole architecture in one page:
 *
 *      1. genesis seed      (env ENTROPY_GENESIS_SEED, or generated once)
 *      2. Vault             (content-addressed persistence + audit journal)
 *      3. EventBus          (SSE for the HUD)
 *      4. Keyring           (master key, smart-value tokens, Unmask Pool)
 *      5. Chromium alloy    (generated theme + integrity plating)
 *      6. Systems           (memory, weave, ar, squad, missions, multiplayer,
 *                            miners) → then attach() cross-links them
 *      7. Router            (every content handler; addresses derived)
 *      8. HTTP server       (middleware chain, static UI, generated CSS)
 *      9. Timers            (consolidation, companion decay, seal sweep)
 *
 *  Cross-system links are attached *after* construction so no module has a
 *  circular require. That is why every system has an `attach(peers)` method:
 *
 *      miners  → weave   (artifact fragments become abilities)
 *      miners  → memory  (block traces, lifetime RLU)
 *      miners  → missions(miner.block / miner.share objectives)
 *      memory  → squad   (companion tactic learning on every match)
 *      ar      → miners, missions, multiplayer, squad (contacts)
 *      missions→ miners  (RLU rewards) · squad (brief venues) · memory (traces)
 *      multiplayer→ squad, missions, miners, memory, ar (raids)
 *      weave   → miners  (RLU spend) · memory (traces + weave-hand xp)
 *
 *  Zero npm dependencies: node:http, node:crypto, node:fs only.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const core = require('../core/entropy-core');
const { Vault } = require('../core/vault');
const { Keyring, TIERS, RISK, ALL_SCOPES } = require('../core/keyring');
const { EventBus, Router, RateLimiter, createServer } = require('../core/http');
const chromium = require('../core/chromium');

const { EntropyMemory } = require('../systems/memory');
const { PowerWeaving } = require('../systems/weave');
const { ArOverlay } = require('../systems/ar');
const { SquadCompanions } = require('../systems/squad');
const { Missions } = require('../systems/missions');
const { Multiplayer } = require('../systems/multiplayer');
const { RealityMiners } = require('../systems/miners');

const { buildRouter } = require('./routes');
const { buildHandlerRegistry } = require('./handlers');

/** /…/3V30OStudios/entropy — the stack root. */
const ENTROPY_ROOT = path.resolve(__dirname, '..', '..');
/** /…/3V30OStudios — the repository root (data/entropy lives here). */
const REPO_ROOT = path.resolve(ENTROPY_ROOT, '..');

/* ── tiny .env loader (no dotenv dependency) ─────────────────────────────── */

function loadEnvFiles(files = []) {
  const loaded = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/**
 * The committed network identity (entropy/config/genesis.json). Shipping a
 * canonical seed makes handler addresses reproducible for integrators; a
 * deployment can still override it with ENTROPY_GENESIS_SEED and fork cleanly.
 */
function readGenesisConfig() {
  const file = path.join(ENTROPY_ROOT, 'config', 'genesis.json');
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch (err) {
    console.error(`[entropy] could not read ${file}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve the genesis seed.
 * Precedence: existing vault genesis → ENTROPY_GENESIS_SEED → config/genesis.json → random.
 */
function resolveGenesisSeed({ vault, envSeed = null, network = 'local-genesis' } = {}) {
  const existing = fs.existsSync(vault.genesisPath) ? JSON.parse(fs.readFileSync(vault.genesisPath, 'utf8')) : null;
  if (existing?.genesisSeed) return { seed: existing.genesisSeed, source: 'vault', created: false, doc: existing, network: existing.network || network };
  const cfg = readGenesisConfig();
  const seed = envSeed || cfg?.genesisSeed || `ent-${crypto.randomBytes(16).toString('hex')}`;
  const source = envSeed ? 'env' : cfg?.genesisSeed ? 'config' : 'generated';
  const doc = vault.genesis({
    seed,
    alloy: cfg?.alloy?.label || null,
    meta: {
      network: cfg?.network || network,
      codename: cfg?.meta?.codename || null,
      unit: cfg?.meta?.unit || null,
      entropyPhrase: core.entropyPhrase(seed, 6),
    },
  });
  return { seed: doc.genesisSeed, source, created: true, doc, network: cfg?.network || network, config: cfg };
}

/**
 * Build the whole app without listening (used by tests and the CLI).
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]      default <repo>/data/entropy
 * @param {string} [options.seed]         default env ENTROPY_GENESIS_SEED
 * @param {string} [options.mode]         'dev' | 'prod'
 * @param {string} [options.surface]      chromium surface: bright|dusk|scan
 * @param {string} [options.grade]        chromium grade: Cr-2…Cr-9
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {object} [options.consensus]  mining consensus overrides (tests run a
 *                                      fast chain: lower difficulty bits and a
 *                                      short retarget interval)
 * @param {number} [options.pendingTtlMs]
 */
function createApp(options = {}) {
  const envLoaded = loadEnvFiles([path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, 'entropy', '.env')]);
  const dataDir = options.dataDir || process.env.ENTROPY_DATA_DIR || path.join(REPO_ROOT, 'data', 'entropy');
  const mode = options.mode || process.env.ENTROPY_MODE || 'dev';
  const genesisConfig = readGenesisConfig();
  const surface = options.surface || process.env.ENTROPY_SURFACE || genesisConfig?.alloy?.surface || 'bright';
  const grade = options.grade || process.env.ENTROPY_CHROMIUM_GRADE || genesisConfig?.alloy?.grade || 'Cr-7';
  const port = Number(options.port || process.env.PORT || process.env.ENTROPY_PORT || 8080);
  const host = options.host || process.env.HOST || '0.0.0.0';

  /* 1–3. vault, bus, genesis */
  const bus = new EventBus({ historyLimit: 300 });
  const vault = new Vault({ root: dataDir, onEvent: (e) => bus.emit(e.type, e.payload) });
  const genesisInfo = resolveGenesisSeed({
    vault,
    envSeed: options.seed || process.env.ENTROPY_GENESIS_SEED || null,
    network: process.env.ENTROPY_NETWORK || genesisConfig?.network || 'local-genesis',
  });
  const seed = genesisInfo.seed;
  const networkName = genesisInfo.network || process.env.ENTROPY_NETWORK || genesisConfig?.network || 'local-genesis';

  /* 4. keyring */
  const keyring = new Keyring({
    vault,
    genesisSeed: seed,
    masterKey: process.env.ENTROPY_MASTER_KEY || null,
    pendingTtlMs: options.pendingTtlMs || Number(process.env.ENTROPY_PENDING_TTL_MINUTES || 30) * 60_000,
    onEvent: (e) => bus.emit(e.type, e.payload),
  });

  /* 5. chromium */
  let alloy = chromium.deriveAlloy({ seed, surface, grade, label: genesisConfig?.alloy?.label || `Genesis ${surface}` });
  const alloyProvider = () => alloy;
  const setAlloy = (next) => {
    alloy = next;
    bus.emit('chromium.alloy.changed', { id: alloy.id, label: alloy.label, address: alloy.address, grade: alloy.grade.grade });
    return alloy;
  };

  const config = {
    seed,
    mode,
    network: networkName,
    genesisSource: genesisInfo.source,
    baseUrl: process.env.ENTROPY_BASE_URL || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    alloy: alloyProvider,
    allowOpenTokenIssue: mode !== 'prod',
    dataDir,
    port,
    host,
    envLoaded,
    registry: null,
    openapi: null,
  };

  /* 6. systems */
  const memory = new EntropyMemory({ vault, keyring, bus, seed });
  const weave = new PowerWeaving({ vault, keyring, bus, seed });
  const ar = new ArOverlay({ vault, keyring, bus, seed, alloy: alloyProvider });
  const squad = new SquadCompanions({ vault, keyring, bus, seed });
  const missions = new Missions({ vault, keyring, bus, seed });
  const multiplayer = new Multiplayer({ vault, keyring, bus, seed });
  const miners = new RealityMiners({
    vault,
    keyring,
    bus,
    seed,
    consensus: options.consensus || null,
  });
  const systems = { memory, weave, ar, squad, missions, multiplayer, miners };

  // cross-links (order matters: producers before consumers)
  miners.attach({ weave, memory, missions });
  weave.attach({ memory, miners, missions });
  memory.attach({ squad, miners, missions, weave });
  squad.attach({ memory, miners, missions });
  missions.attach({ miners, memory, squad, weave });
  multiplayer.attach({ squad, missions, miners, memory, ar });
  ar.attach({ miners, missions, multiplayer, squad, memory });

  /* chain + catalog priming so a fresh network is immediately usable */
  miners.ensureGenesis();
  weave.ensureCatalog();
  squad.ensureRoster();

  /* 7. router + registry + openapi */
  const router = buildRouter({ vault, keyring, bus, systems, config });
  const registry = () => buildHandlerRegistry(router, { seed, baseUrl: '', requiredSmartValueFor: (risk) => keyring.requiredFor(risk) });
  config.registry = registry;
  config.openapi = () =>
    router.openapi({
      genesisSeed: seed,
      title: 'Entropy API — Genesis Unmask',
      version: core.PROTOCOL_VERSION,
      serverUrl: config.baseUrl,
    });

  /* 8. server + generated assets */
  const uiDir = path.join(__dirname, '..', 'ui');
  const server = createServer({
    router,
    keyring,
    bus,
    limiter: new RateLimiter({ capacity: Number(process.env.ENTROPY_RATE_CAPACITY || 400), refillPerSec: Number(process.env.ENTROPY_RATE_REFILL || 60) }),
    staticDir: uiDir,
    genesis: vault.genesis({ seed }),
    corsOrigins: process.env.ENTROPY_CORS_ORIGIN || '*',
    hooks: {
      /** Dynamic assets that must never be stale files on disk. */
      beforeStatic(req, res, pathname) {
        if (pathname === '/ui/chromium.css' || pathname === '/chromium.css') {
          const css = chromium.toCss(alloy);
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(css) });
          res.end(css);
          return true;
        }
        if (pathname === '/openapi.json' || pathname === '/v1/openapi.yaml') {
          const doc = config.openapi();
          const body = JSON.stringify(doc, null, 2);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(body) });
          res.end(body);
          return true;
        }
        if (pathname === '/handlers.json') {
          const body = JSON.stringify(registry(), null, 2);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
          return true;
        }
        return false;
      },
    },
  });

  /* 9. timers — the "living world" loop */
  const timers = [];
  const every = (ms, fn, label) => {
    const t = setInterval(() => {
      try {
        fn();
      } catch (err) {
        console.error(`[entropy] timer ${label} failed:`, err.message);
      }
    }, ms);
    t.unref?.();
    timers.push({ label, ms, timer: t });
    return t;
  };

  every(60 * 60 * 1000, () => keyring.sweepExpired(), 'pending.sweep');
  every(15 * 60 * 1000, () => squad.decayIdle(), 'squad.decay');
  every(30 * 60 * 1000, () => {
    // Consolidate every profile touched in the last hour.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const profile of memory.listProfiles({ limit: 200 })) {
      if (Date.parse(profile.updatedAt) >= cutoff) memory.consolidate(profile.profileId, { actor: 'system' });
    }
  }, 'memory.consolidate');
  every(5 * 60 * 1000, () => {
    const events = missions.liveWorldEvents();
    if (events.length) bus.emit('missions.worldEvents.live', { count: events.length, events: events.map((e) => ({ eventId: e.eventId, title: e.title, endsAt: e.endsAt })) });
  }, 'missions.events');

  /* ── public API of the app ───────────────────────────────────────────── */

  const app = {
    config,
    vault,
    bus,
    keyring,
    router,
    server,
    systems,
    alloy: alloyProvider,
    setAlloy,
    registry,
    openapi: config.openapi,
    timers,
    core,
    chromium,
    genesis: vault.genesis({ seed }),

    /** Convenience: issue the development bootstrap authority. */
    bootstrapToken(opts = {}) {
      return keyring.bootstrapToken(opts);
    },

    /** Start listening. Resolves once the port is bound. */
    listen({ port: listenPort = port, host: listenHost = host } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, listenHost, () => {
          const addr = server.address();
          bus.emit('system.listening', { host: listenHost, port: addr.port, mode, seed: vault.genesis({ seed }).seedFingerprint });
          resolve({ ...app, address: addr, url: `http://${listenHost === '0.0.0.0' ? 'localhost' : listenHost}:${addr.port}` });
        });
      });
    },

    /** Stop timers + close the server (tests, graceful shutdown). */
    async close() {
      for (const { timer } of timers) clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
      return { closed: true };
    },

    /** Everything a first-run operator needs, in one object. */
    banner() {
      const reg = registry();
      const bt = app.bootstrapToken();
      return {
        title: 'ENTROPY · GENESIS UNMASK',
        version: core.PROTOCOL_VERSION,
        mode,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
        ui: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/ui/`,
        dataDir,
        genesis: {
          seedFingerprint: vault.genesis({ seed }).seedFingerprint,
          entropyPhrase: core.entropyPhrase(seed, 6),
          createdNow: genesisInfo.created,
          seedSource: genesisInfo.source,
        },
        chromium: { alloy: alloy.label, address: alloy.address, grade: alloy.grade.grade, surface: alloy.surface.id, contrast: alloy.contrast, css: '/ui/chromium.css' },
        handlers: { total: reg.count, groups: reg.groups.map((g) => `${g.group} (${g.handlers.length})`).join(', ') },
        chain: { height: miners.stats().height, tip: miners.stats().tip?.slice(0, 16) || null, difficultyBits: miners.stats().difficultyBits },
        bootstrapToken: { token: bt.token, subject: bt.claims.sub, tier: bt.claims.tier, smartValue: bt.smartValue, expiresAt: bt.expiresAt, address: bt.address },
        riskLadder: Object.entries(RISK).map(([k, v]) => `${k}=${v.required}`),
        tiers: TIERS.map((t) => t.id),
        scopes: ALL_SCOPES,
        quickstart: [
          `export ENTROPY_TOKEN='${bt.token}'`,
          'curl -s $URL/v1/status -H "Authorization: Bearer $ENTROPY_TOKEN" | head -40',
          'curl -s -X POST $URL/v1/memory/profiles -H "Authorization: Bearer $ENTROPY_TOKEN" -H "content-type: application/json" -d \'{"subject":"commander","alias":"Commander Bleu"}\'',
          'curl -s -X POST $URL/v1/miners/mine -H "Authorization: Bearer $ENTROPY_TOKEN" -H "content-type: application/json" -d \'{"seconds":3,"blocks":2}\'',
          'curl -s -X POST $URL/v1/ar/scan -H "Authorization: Bearer $ENTROPY_TOKEN" -H "content-type: application/json" -d \'{"mode":"deep"}\'',
        ],
        note: mode === 'prod' ? 'Production mode: token issuance requires admin:root.' : 'Development mode: POST /v1/auth/token is open. Set ENTROPY_MODE=prod to lock it.',
      };
    },
  };

  return app;
}

/* ── direct execution: `node entropy/src/api/server.js` ─────────────────── */

if (require.main === module) {
  const app = createApp();
  app
    .listen()
    .then((started) => {
      const banner = started.banner();
      console.log('\n' + '═'.repeat(78));
      console.log(`  ${banner.title}  ·  v${banner.version}  ·  mode=${banner.mode}`);
      console.log('═'.repeat(78));
      console.log(`  api      ${banner.url}/v1`);
      console.log(`  hud      ${banner.ui}`);
      console.log(`  data     ${banner.dataDir}`);
      console.log(`  genesis  ${banner.genesis.seedFingerprint}  (${banner.genesis.seedSource})`);
      console.log(`  phrase   ${banner.genesis.entropyPhrase}`);
      console.log(`  chromium ${banner.chromium.alloy} · ${banner.chromium.grade} · ${banner.chromium.address}`);
      console.log(`  handlers ${banner.handlers.total} across ${banner.handlers.groups}`);
      console.log(`  chain    height ${banner.chain.height} · ${banner.chain.difficultyBits} bits · tip ${banner.chain.tip}…`);
      console.log(`  token    ${banner.bootstrapToken.token.slice(0, 46)}…`);
      console.log(`           subject=${banner.bootstrapToken.subject} tier=${banner.bootstrapToken.tier} smartValue=${banner.bootstrapToken.smartValue}`);
      console.log('═'.repeat(78) + '\n');
      for (const line of banner.quickstart) console.log(`  ${line}`);
      console.log('');
    })
    .catch((err) => {
      console.error('[entropy] failed to start:', err.message);
      process.exit(1);
    });

  const shutdown = async (signal) => {
    console.log(`\n[entropy] ${signal} — closing`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createApp, loadEnvFiles, resolveGenesisSeed, readGenesisConfig, REPO_ROOT, ENTROPY_ROOT };
