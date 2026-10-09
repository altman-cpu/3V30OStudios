'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AR OVERLAY  —  scanning, missions and map layers as a plated HUD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  The AR layer is an *API surface*, not a rendering engine. A client (phone,
 *  headset, browser HUD) asks for:
 *
 *      GET  /v1/ar/layers            what layers exist + their chromium tint
 *      POST /v1/ar/scan              run a scan → deterministic contacts
 *      GET  /v1/ar/map/:z/:x/:y      a map tile (heightfield + biome + markers)
 *      GET  /v1/ar/overlay.svg       a ready-to-composite HUD frame
 *      POST /v1/ar/anchors           pin a marker to the world
 *
 *  Three properties make this trustworthy rather than decorative:
 *
 *  1. DETERMINISM — contacts are derived from (genesisSeed, coarse location,
 *     time bucket, layers). Two players scanning the same block at the same
 *     minute see the same world. That is what makes co-op raids coherent
 *     without a realtime simulation server.
 *
 *  2. PLATING — every overlay payload is sealed with Entropy Chromium
 *     (`chromePlate`). A client can verify the bytes came from this network.
 *
 *  3. PRIVACY BY QUANTISATION — player positions are never published raw.
 *     Coordinates snap to a coarse grid (default 25 m) and handles are
 *     pseudonymous unless both parties are in the same party with consent.
 *     Scanning therefore cannot be used to stalk: this is the "safe" in
 *     safe multiplayer, enforced in the data layer rather than in policy text.
 */

const {
  deriveAddress,
  createRng,
  hashHex,
  nowIso,
  clamp,
  round,
  epochDay,
} = require('../core/entropy-core');
const { plate } = require('../core/chromium');
const { fragmentFromHash, place } = require('../core/reality-gen');
const { toBadRequest, toNotFound } = require('../core/http');

const DOMAIN = 'ar';

/** Layer registry. `tintFrom` maps onto chromium alloy arHud.layers keys. */
const LAYERS = Object.freeze([
  { id: 'scan', label: 'Scan', order: 10, defaultOpacity: 0.9, tintFrom: 'scan', note: 'live contacts, reticle, sweep' },
  { id: 'mission', label: 'Missions', order: 20, defaultOpacity: 0.95, tintFrom: 'mission', note: 'objectives, rings, timers' },
  { id: 'map', label: 'Map', order: 30, defaultOpacity: 0.7, tintFrom: 'map', note: 'terrain, biomes, anchors' },
  { id: 'party', label: 'Party', order: 40, defaultOpacity: 0.85, tintFrom: 'scan', note: 'squad + companion markers (consented)' },
  { id: 'threat', label: 'Threat', order: 50, defaultOpacity: 1, tintFrom: 'threat', note: 'hostile contacts, hazard weather' },
  { id: 'glyph', label: 'Glyph', order: 60, defaultOpacity: 0.6, tintFrom: 'glyph', note: 'mined reality glyphs, seals, lore' },
  { id: 'weather', label: 'Weather', order: 70, defaultOpacity: 0.5, tintFrom: 'map', note: 'world-event atmosphere' },
]);

const LAYER_IDS = LAYERS.map((l) => l.id);

/** Scan modes change which layers are weighted and how deep the scan goes. */
const SCAN_MODES = Object.freeze({
  sweep: { label: 'Sweep', depth: 3, layers: ['scan', 'glyph'], cooldownSec: 20, note: 'wide, shallow, cheap' },
  deep: { label: 'Deep Scan', depth: 6, layers: ['scan', 'glyph', 'map', 'threat'], cooldownSec: 90, note: 'narrow, expensive, finds traces' },
  mission: { label: 'Mission Lock', depth: 4, layers: ['mission', 'party'], cooldownSec: 30, note: 'objective + squad focus' },
  recon: { label: 'Recon', depth: 5, layers: ['threat', 'map'], cooldownSec: 60, note: 'hazard and terrain read' },
});

/** Quantisation cell size in metres — the privacy floor for shared positions. */
const POSITION_CELL_M = 25;

class ArOverlay {
  /**
   * @param {object} deps
   * @param {import('../core/vault').Vault} deps.vault
   * @param {import('../core/keyring').Keyring} deps.keyring
   * @param {import('../core/http').EventBus} deps.bus
   * @param {string} deps.seed
   * @param {()=>object} deps.alloy   chromium alloy provider (live theme)
   */
  constructor({ vault, keyring, bus, seed, alloy }) {
    this.vault = vault;
    this.keyring = keyring;
    this.bus = bus;
    this.seed = seed;
    this.alloy = typeof alloy === 'function' ? alloy : () => alloy;
    this.peers = {};
  }

  attach(peers) {
    this.peers = { ...this.peers, ...peers };
    return this;
  }

  _state() {
    return this.vault.read(DOMAIN, { anchors: {}, scans: {}, sessions: 0, stats: { scans: 0, contacts: 0, anchors: 0 } });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'ar', ...meta });
  }

  /* ─────────────────────────────── layers ─────────────────────────────── */

  /** Layer definitions tinted with the live chromium alloy. */
  layers({ surface = null } = {}) {
    const alloy = this.alloy();
    return {
      alloy: { id: alloy.id, label: alloy.label, address: alloy.address, grade: alloy.grade.grade },
      privacy: { positionCellMeters: POSITION_CELL_M, pseudonymous: true, note: 'positions are quantised; raw coordinates never leave the device' },
      layers: LAYERS.map((layer) => ({
        ...layer,
        address: deriveAddress({ domain: 'ARX', seed: this.seed, label: `layer:${layer.id}`, sublabel: surface || alloy.surface.id }).address,
        tint: alloy.arHud.layers[layer.tintFrom]?.tint || alloy.colors.accent,
        strokeWeight: alloy.arHud.layers[layer.tintFrom]?.weight || 1.4,
        reticle: alloy.arHud,
      })),
      scanModes: SCAN_MODES,
    };
  }

  /* ─────────────────────────── coordinate helpers ─────────────────────── */

  /** Snap a coordinate to the privacy grid. */
  static quantize({ x = 0, y = 0, z = 0 }, cell = POSITION_CELL_M) {
    return {
      x: Math.round(x / cell) * cell,
      y: Math.round(y / cell) * cell,
      z: Math.round(z / cell) * cell,
      cell,
      precision: 'coarse',
    };
  }

  /** Stable location key for determinism (quantised + rounded). */
  static locationKey(location = {}) {
    const q = ArOverlay.quantize(location);
    return `${q.x}:${q.y}:${q.z}`;
  }

  /* ─────────────────────────────── scanning ───────────────────────────── */

  /**
   * Run a scan. Contacts come from three pools, in priority order:
   *
   *   A. MINED REALITY — fragments from the reality chain anchored near this
   *      location (asked from the Miner peer; falls back to on-demand
   *      derivation so a scan works on a fresh network with no blocks yet).
   *   B. LIVE OBJECTIVES — missions, world events, raids in range.
   *   C. CONSENTED PRESENCE — party members and companions, quantised.
   *
   * @param {object} input {profileId, mode, location, layers, timeBucket}
   */
  scan(input = {}, { actor = null } = {}) {
    const state = this._state();
    const mode = SCAN_MODES[String(input.mode || 'sweep').toLowerCase()] ? String(input.mode).toLowerCase() : 'sweep';
    const spec = SCAN_MODES[mode];
    const requestedLayers = (input.layers && input.layers.length ? input.layers : spec.layers).filter((l) => LAYER_IDS.includes(l));
    if (!requestedLayers.length) throw toBadRequest('no valid layers requested', { valid: LAYER_IDS });

    const location = input.location || { x: 0, y: 0, z: 0 };
    const quantised = ArOverlay.quantize(location);
    const locKey = ArOverlay.locationKey(location);
    const bucket = input.timeBucket || Math.floor(Date.now() / (spec.cooldownSec * 1000));
    const scanSeed = `${this.seed}|scan|${locKey}|${mode}|${bucket}|${requestedLayers.join(',')}`;
    const rng = createRng(scanSeed);
    const scanId = hashHex('scan', scanSeed, input.profileId || actor || 'anon').slice(0, 18);
    const address = deriveAddress({ domain: 'ARX', seed: this.seed, label: scanId, sublabel: mode });

    const contacts = [];

    /* A. mined reality */
    const mined = this.peers.miners ? this.peers.miners.recentFragments({ limit: 40 }) : [];
    const pool = mined.length
      ? mined
      : Array.from({ length: 12 }, (_, i) => fragmentFromHash({ hash: hashHex('scan-fallback', this.seed, locKey, i), seed: this.seed, index: i }));
    const wantedKinds = { scan: ['scene', 'glyph', 'artifact', 'memory'], deep: ['scene', 'glyph', 'artifact', 'memory', 'terrain'], mission: ['scene', 'law'], recon: ['terrain', 'weather'] }[mode] || ['scene', 'glyph'];
    for (const fragment of pool) {
      if (contacts.length >= spec.depth * 3) break;
      if (!wantedKinds.includes(fragment.kind)) continue;
      // Thin the pool only when it is genuinely large; a young chain should
      // still return a usable scan instead of an empty overlay.
      if (pool.length > 16 && !rng.chance(0.55)) continue;
      contacts.push({
        contactId: `rlt-${contacts.length}-${rng.range(1000, 9999)}`,
        kind: 'reality',
        layer: fragment.kind === 'terrain' ? 'map' : fragment.kind === 'weather' ? 'weather' : 'glyph',
        label: fragment.title || fragment.codename,
        detail: fragment.text,
        rarity: fragment.rarity,
        resonance: fragment.resonance,
        address: fragment.address,
        position: ArOverlay.quantize({ x: quantised.x + rng.range(-120, 120), y: quantised.y + rng.range(-120, 120), z: quantised.z + rng.range(-20, 40) }),
        distanceM: rng.range(8, 240),
        confidence: round(clamp(0.5 + fragment.resonance / 8 + rng.float(0, 0.25), 0, 0.99), 2),
      });
    }

    /* B. live objectives */
    if (requestedLayers.includes('mission') && this.peers.missions) {
      const active = this.peers.missions.activeFor(input.profileId || actor, { limit: 4 });
      for (const mission of active.missions || []) {
        contacts.push({
          contactId: `msn-${mission.missionId}`,
          kind: 'mission',
          layer: 'mission',
          label: mission.title,
          detail: mission.brief,
          cadence: mission.cadence,
          progress: mission.progress,
          address: mission.address,
          position: ArOverlay.quantize({ x: quantised.x + rng.range(-80, 80), y: quantised.y + rng.range(-80, 80), z: quantised.z }),
          distanceM: rng.range(5, 160),
          confidence: 0.98,
          expiresAt: mission.expiresAt,
        });
      }
    }
    if (requestedLayers.includes('weather') && this.peers.missions) {
      for (const event of this.peers.missions.liveWorldEvents().slice(0, 2)) {
        contacts.push({
          contactId: `evt-${event.eventId}`,
          kind: 'world-event',
          layer: 'weather',
          label: event.title,
          detail: event.text,
          intensity: event.intensity,
          address: event.address,
          position: ArOverlay.quantize({ x: quantised.x + rng.range(-200, 200), y: quantised.y + rng.range(-200, 200), z: quantised.z }),
          distanceM: rng.range(40, 600),
          confidence: 0.9,
          endsAt: event.endsAt,
        });
      }
    }

    /* C. consented presence (party only — never strangers) */
    if (requestedLayers.includes('party')) {
      const party = this.peers.multiplayer?.partyFor(input.profileId || actor) || null;
      for (const member of (party?.members || []).filter((m) => m.consentShared === true).slice(0, 5)) {
        contacts.push({
          contactId: `pty-${member.profileId}`,
          kind: 'party',
          layer: 'party',
          label: member.alias || member.profileId,
          detail: `${member.role || 'member'} · consent shared`,
          address: deriveAddress({ domain: 'LBY', seed: this.seed, label: `presence:${member.profileId}`, sublabel: locKey }).address,
          position: ArOverlay.quantize({ x: quantised.x + rng.range(-30, 30), y: quantised.y + rng.range(-30, 30), z: quantised.z }),
          distanceM: rng.range(2, 60),
          confidence: 1,
          pseudonymous: true,
        });
      }
      for (const companion of (this.peers.squad?.activeCompanions(input.profileId || actor) || []).slice(0, 3)) {
        contacts.push({
          contactId: `sqd-${companion.companionId}`,
          kind: 'companion',
          layer: 'party',
          label: companion.name,
          detail: `${companion.role} · prefers ${companion.preferredTactic} · bond ${companion.bond}`,
          address: companion.address,
          position: ArOverlay.quantize({ x: quantised.x + rng.range(-12, 12), y: quantised.y + rng.range(-12, 12), z: quantised.z }),
          distanceM: rng.range(1, 18),
          confidence: 1,
        });
      }
    }

    /* D. threats (recon/deep only) */
    if (requestedLayers.includes('threat')) {
      const threatCount = rng.int(spec.depth);
      for (let i = 0; i < threatCount; i += 1) {
        const severity = rng.weighted([['low', 5], ['moderate', 3], ['high', 1]]);
        contacts.push({
          contactId: `thr-${i}-${rng.range(100, 999)}`,
          kind: 'threat',
          layer: 'threat',
          label: `${severity.toUpperCase()} · ${rng.pick(['static bloom', 'tidal surge', 'unsealed glyph', 'hostile weave', 'signal interference'])}`,
          detail: severity === 'high' ? 'Break line of sight and re-scan.' : 'Track and mark for the party.',
          severity,
          address: deriveAddress({ domain: 'ARX', seed: this.seed, label: `threat:${scanId}:${i}`, sublabel: severity }).address,
          position: ArOverlay.quantize({ x: quantised.x + rng.range(-160, 160), y: quantised.y + rng.range(-160, 160), z: quantised.z + rng.range(-10, 30) }),
          distanceM: rng.range(20, 300),
          confidence: round(rng.float(0.6, 0.97), 2),
        });
      }
    }

    // Top-up: never hand a client an empty scan — derive contacts straight from
    // the scan seed when the mined pool is thin (fresh network, new location).
    let topUp = 0;
    while (contacts.length < Math.min(spec.depth + 1, 4) && topUp < 6) {
      topUp += 1;
      const derived = fragmentFromHash({ hash: hashHex('scan-topup', scanSeed, topUp), seed: this.seed, index: topUp, kind: wantedKinds[topUp % wantedKinds.length] });
      contacts.push({
        contactId: `gen-${topUp}-${rng.range(1000, 9999)}`,
        kind: 'reality',
        layer: derived.kind === 'terrain' ? 'map' : derived.kind === 'weather' ? 'weather' : 'glyph',
        label: derived.title || derived.codename,
        detail: derived.text,
        rarity: derived.rarity,
        resonance: derived.resonance,
        address: derived.address,
        position: ArOverlay.quantize({ x: quantised.x + rng.range(-140, 140), y: quantised.y + rng.range(-140, 140), z: quantised.z + rng.range(-20, 40) }),
        distanceM: rng.range(10, 260),
        confidence: round(clamp(0.35 + derived.resonance / 10 + rng.float(0, 0.2), 0, 0.9), 2),
        derived: true,
      });
    }

    contacts.sort((a, b) => a.distanceM - b.distanceM);
    const trimmed = contacts.slice(0, clamp(this.alloy().arHud.maxContacts, 8, 48));

    const result = {
      scanId,
      address: address.address,
      evmAddress: address.evm,
      profileId: input.profileId || null,
      mode,
      modeLabel: spec.label,
      layers: requestedLayers,
      location: quantised,
      locationKey: locKey,
      timeBucket: bucket,
      cooldownSec: spec.cooldownSec,
      nextScanAt: new Date(bucket * spec.cooldownSec * 1000 + spec.cooldownSec * 1000).toISOString(),
      at: nowIso(),
      day: epochDay(),
      contactCount: trimmed.length,
      contacts: trimmed,
      layerSummary: Object.fromEntries(
        LAYER_IDS.map((id) => [id, { enabled: requestedLayers.includes(id), contacts: trimmed.filter((c) => c.layer === id).length }]),
      ),
      reticle: this.alloy().arHud.reticle,
      seedFingerprint: hashHex('scan-fingerprint', scanSeed).slice(0, 20),
    };

    state.scans[scanId] = { scanId, at: result.at, mode, locationKey: locKey, profileId: result.profileId, contactCount: result.contactCount, address: result.address };
    state.sessions += 1;
    state.stats.scans += 1;
    state.stats.contacts += trimmed.length;
    // Keep only the last 200 scan summaries; contacts are re-derivable anyway.
    const ids = Object.keys(state.scans);
    if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete state.scans[id];
    this._save(state, { actor: actor || result.profileId || 'anonymous', kind: 'ar.scan', reason: `${mode}@${locKey}` });
    this.bus.emit('ar.scan', { scanId, mode, contacts: trimmed.length, address: result.address });

    if (this.peers.missions && result.profileId) {
      this.peers.missions.observe({ profileId: result.profileId, event: 'scan.run', amount: 1, meta: { mode } });
      if (mode === 'deep') this.peers.missions.observe({ profileId: result.profileId, event: 'scan.deep', amount: 1 });
      if (trimmed.some((c) => c.rarity === 'plated' || c.rarity === 'unmasked')) {
        this.peers.missions.observe({ profileId: result.profileId, event: 'scan.rare', amount: 1 });
      }
    }

    if (this.peers.memory && result.profileId) {
      const notable = trimmed.find((c) => c.kind === 'reality' && (c.rarity === 'plated' || c.rarity === 'unmasked'));
      if (notable) {
        this.peers.memory.remember(result.profileId, {
          kind: 'scan',
          text: `Deep scan found ${notable.label} (${notable.rarity}) at ${locKey}.`,
          tags: ['scan', notable.layer, notable.rarity],
          resonance: 1.6,
          decayDays: 60,
          source: 'ar',
          ref: { scanId, address: notable.address },
        }, { actor: actor || result.profileId });
      }
      this.peers.memory.recordSkillUse(result.profileId, 'scan-literacy', { outcome: mode === 'deep' ? 'teach' : 'use', actor: actor || result.profileId });
    }

    return this.platePayload(result, { subject: actor || result.profileId || 'anonymous', kind: 'ar.scan' });
  }

  /** Recent scan history for a subject. */
  history(profileId, { limit = 20 } = {}) {
    const state = this._state();
    return Object.values(state.scans)
      .filter((s) => (profileId ? s.profileId === profileId : true))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, clamp(limit, 1, 100));
  }

  /* ───────────────────────────────── map ──────────────────────────────── */

  /**
   * Deterministic map tile. z = zoom, x/y = tile coords (slippy-map style).
   * Terrain is drawn from mined `terrain` fragments when available so mining
   * literally shapes the map; otherwise it is derived from the tile key.
   */
  tile(z, x, y) {
    const zoom = clamp(Number(z) || 0, 0, 18);
    const tx = Number(x) || 0;
    const ty = Number(y) || 0;
    const key = `${zoom}/${tx}/${ty}`;
    const rng = createRng(`map|${this.seed}|${key}`);
    const mined = (this.peers.miners ? this.peers.miners.fragmentsByKind('terrain', { limit: 200 }) : []).filter(
      (f) => hashHex('tile-bind', f.sourceHash).slice(0, 4) === hashHex('tile-bind', key).slice(0, 4),
    );
    const fragment = mined[0] || null;

    const size = 8;
    const heightfield = fragment?.heightfield
      ? fragment.heightfield
      : Array.from({ length: size }, () => Array.from({ length: size }, () => round(rng.float(0, 1), 3)));

    const biome = fragment?.biome || rng.pick(['salt flat', 'cloud forest', 'glass desert', 'tidal shelf', 'moss cathedral', 'ice arcade', 'copper canyon', 'lantern marsh']);
    const markers = [];
    const state = this._state();
    for (const anchor of Object.values(state.anchors)) {
      if (anchor.tile === key) markers.push({ ...anchor, layer: anchor.layer });
    }
    for (let i = 0; i < rng.int(4); i += 1) {
      markers.push({
        markerId: `auto-${key}-${i}`,
        kind: 'derived',
        layer: rng.pick(['glyph', 'scan', 'map']),
        label: place(rng),
        address: deriveAddress({ domain: 'ARX', seed: this.seed, label: `tile:${key}`, sublabel: `marker:${i}` }).address,
        cell: { x: rng.int(size), y: rng.int(size) },
      });
    }

    // The plated body is deliberately free of wall-clock fields: the same
    // z/x/y on the same network must produce a byte-identical, cacheable tile.
    const body = {
      tile: key,
      zoom,
      x: tx,
      y: ty,
      address: deriveAddress({ domain: 'ARX', seed: this.seed, label: `tile:${key}`, sublabel: 'tile' }).address,
      biome,
      size,
      heightfield,
      hazard: fragment?.hazard ?? rng.range(1, 5),
      cover: fragment?.cover ?? rng.range(1, 5),
      markers,
      sourceFragment: fragment?.address || null,
      alloy: this.alloy().id,
    };
    return { ...this.platePayload(body, { subject: 'map', kind: 'ar.tile' }), generatedAt: nowIso() };
  }

  /* ─────────────────────────────── anchors ────────────────────────────── */

  /** Pin a marker into the shared world (medium risk → smart-value gated). */
  createAnchor(input = {}, { actor = null } = {}) {
    const layer = LAYER_IDS.includes(input.layer) ? input.layer : 'glyph';
    const label = String(input.label || 'anchor').slice(0, 80);
    const position = ArOverlay.quantize(input.position || { x: 0, y: 0, z: 0 });
    const anchorId = hashHex('anchor', this.seed, actor, label, JSON.stringify(position), nowIso()).slice(0, 16);
    const anchor = {
      anchorId,
      address: deriveAddress({ domain: 'ARX', seed: this.seed, label: anchorId, sublabel: layer }).address,
      layer,
      label,
      detail: input.detail ? String(input.detail).slice(0, 240) : null,
      position,
      tile: input.tile || `12/${Math.floor(position.x / POSITION_CELL_M)}/${Math.floor(position.y / POSITION_CELL_M)}`,
      owner: actor,
      profileId: input.profileId || null,
      ref: input.ref || null,
      visibility: ['public', 'party', 'private'].includes(input.visibility) ? input.visibility : 'party',
      ttlMinutes: clamp(Number(input.ttlMinutes ?? 240), 5, 60 * 24 * 30),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + clamp(Number(input.ttlMinutes ?? 240), 5, 60 * 24 * 30) * 60_000).toISOString(),
      upvotes: 0,
    };
    const state = this._state();
    state.anchors[anchorId] = anchor;
    state.stats.anchors += 1;
    this._save(state, { actor: actor || 'anonymous', kind: 'ar.anchor.create', reason: `${layer}:${label}` });
    this.bus.emit('ar.anchor', { anchorId, layer, label, address: anchor.address, visibility: anchor.visibility });
    if (anchor.profileId) this.peers.missions?.observe({ profileId: anchor.profileId, event: 'ar.anchor', amount: 1, meta: { anchorId, layer } });
    return anchor;
  }

  listAnchors({ layer = null, visibility = null, profileId = null, limit = 60 } = {}) {
    const state = this._state();
    const now = Date.now();
    return Object.values(state.anchors)
      .filter((a) => Date.parse(a.expiresAt) > now)
      .filter((a) => (layer ? a.layer === layer : true))
      .filter((a) => (visibility ? a.visibility === visibility : true))
      .filter((a) => (profileId ? a.visibility === 'public' || a.owner === profileId || a.profileId === profileId : a.visibility === 'public'))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, clamp(limit, 1, 200));
  }

  removeAnchor(anchorId, { actor = null } = {}) {
    const state = this._state();
    const anchor = state.anchors[anchorId];
    if (!anchor) throw toNotFound(`unknown anchor: ${anchorId}`);
    const isOwner = anchor.owner === actor;
    const isRoot = Boolean(actor && this.keyring && false); // authority checked in route via scope
    if (!isOwner && !isRoot) throw toBadRequest('only the anchor owner may remove it', { owner: anchor.owner });
    delete state.anchors[anchorId];
    this._save(state, { actor: actor || 'anonymous', kind: 'ar.anchor.remove', reason: anchorId });
    return { anchorId, removed: true };
  }

  /* ───────────────────────── overlay rendering (SVG) ──────────────────── */

  /**
   * Render a bright, plated HUD frame as SVG. Clients composite this over the
   * camera feed or use it directly as the browser HUD. Everything is generated
   * from the chromium alloy so the aesthetic is consistent with the theme.
   */
  renderOverlay({ contacts = [], layers = LAYER_IDS, viewport = { w: 960, h: 540 }, title = 'ENTROPY SCAN', scanId = null } = {}) {
    const alloy = this.alloy();
    const { w, h } = viewport;
    const active = LAYER_IDS.filter((l) => layers.includes(l));
    const enabledContacts = contacts.filter((c) => active.includes(c.layer)).slice(0, alloy.arHud.maxContacts);
    const r = alloy.arHud.reticle;
    const cx = w / 2;
    const cy = h / 2;

    const ticks = Array.from({ length: r.ticks }, (_, i) => {
      const angle = (i / r.ticks) * Math.PI * 2;
      const inner = r.radius - 7;
      const outer = r.radius + (i % 3 === 0 ? 9 : 4);
      return `<line x1="${round(cx + Math.cos(angle) * inner, 2)}" y1="${round(cy + Math.sin(angle) * inner, 2)}" x2="${round(cx + Math.cos(angle) * outer, 2)}" y2="${round(cy + Math.sin(angle) * outer, 2)}" stroke="${r.stroke}" stroke-width="${r.strokeWidth}" stroke-linecap="round" opacity="${i % 3 === 0 ? 0.95 : 0.55}"/>`;
    }).join('');

    const markers = enabledContacts
      .map((contact, i) => {
        const pos = contact.position || { x: 0, y: 0 };
        const px = clamp(cx + (pos.x % 400) * 0.6, 28, w - 28);
        const py = clamp(cy + (pos.y % 300) * 0.5, 40, h - 40);
        const layerSpec = alloy.arHud.layers[contact.layer] || alloy.arHud.layers.scan;
        const shape =
          contact.kind === 'threat'
            ? `<path d="M ${px} ${py - 9} L ${px + 9} ${py + 7} L ${px - 9} ${py + 7} Z" fill="none" stroke="${layerSpec.tint}" stroke-width="${layerSpec.weight}"/>`
            : contact.kind === 'mission'
              ? `<rect x="${px - 7}" y="${py - 7}" width="14" height="14" rx="3" fill="none" stroke="${layerSpec.tint}" stroke-width="${layerSpec.weight}"/>`
              : `<circle cx="${px}" cy="${py}" r="${6 + (contact.resonance || 1)}" fill="none" stroke="${layerSpec.tint}" stroke-width="${layerSpec.weight}"/>`;
        return `${shape}<circle cx="${px}" cy="${py}" r="1.6" fill="${layerSpec.tint}"/><text x="${px + 13}" y="${py + 4}" font-family="${alloy.type.familyMono}" font-size="10" fill="${alloy.colors.ink}" opacity="0.82">${escapeXml(String(contact.label || contact.contactId).slice(0, 26))}</text><title>${escapeXml(`${contact.kind} · ${contact.distanceM ?? '?'}m · ${contact.address || ''}`)}</title>`;
      })
      .join('');

    const legend = active
      .map((id, i) => {
        const spec = alloy.arHud.layers[LAYERS.find((l) => l.id === id)?.tintFrom] || alloy.arHud.layers.scan;
        const count = contacts.filter((c) => c.layer === id).length;
        return `<g transform="translate(18, ${h - 22 - (active.length - 1 - i) * 18})"><rect x="0" y="-8" width="10" height="10" rx="2" fill="${spec.tint}" opacity="0.9"/><text x="16" y="1" font-family="${alloy.type.familyMono}" font-size="10" letter-spacing="1.2" fill="${alloy.colors.muted}">${id.toUpperCase()} · ${count}</text></g>`;
      })
      .join('');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeXml(title)} overlay">
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${alloy.colors.accent}" stop-opacity="${round(alloy.material.iridescence * 0.5, 2)}"/>
      <stop offset="45%" stop-color="${alloy.colors.accent2}" stop-opacity="${round(alloy.material.iridescence * 0.4, 2)}"/>
      <stop offset="100%" stop-color="${alloy.colors.accent3}" stop-opacity="${round(alloy.material.iridescence * 0.45, 2)}"/>
    </linearGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="${alloy.colors.bg}"/>
  <rect width="${w}" height="${h}" fill="url(#sheen)"/>
  <g opacity="0.35" stroke="${alloy.colors.accent}" stroke-width="0.5">
    ${Array.from({ length: Math.floor(w / 48) }, (_, i) => `<line x1="${i * 48}" y1="0" x2="${i * 48}" y2="${h}"/>`).join('')}
    ${Array.from({ length: Math.floor(h / 48) }, (_, i) => `<line x1="0" y1="${i * 48}" x2="${w}" y2="${i * 48}"/>`).join('')}
  </g>
  <g>
    <circle cx="${cx}" cy="${cy}" r="${r.radius + 18}" fill="none" stroke="${r.glow}" stroke-width="10" filter="url(#soft)"/>
    <circle cx="${cx}" cy="${cy}" r="${r.radius}" fill="none" stroke="${r.stroke}" stroke-width="${r.strokeWidth}" opacity="0.9"/>
    ${ticks}
    <path d="M ${cx - 14} ${cy} H ${cx - 4} M ${cx + 4} ${cy} H ${cx + 14} M ${cx} ${cy - 14} V ${cy - 4} M ${cx} ${cy + 4} V ${cy + 14}" stroke="${r.stroke}" stroke-width="${r.strokeWidth}" stroke-linecap="round"/>
  </g>
  ${markers}
  <g font-family="${alloy.type.familyMono}">
    <rect x="14" y="14" width="${Math.min(420, w - 28)}" height="46" rx="10" fill="${alloy.colors.panel}" opacity="${alloy.material.glassOpacity}" stroke="${alloy.colors.line}"/>
    <text x="28" y="34" font-size="12" letter-spacing="2.4" fill="${alloy.colors.ink}">${escapeXml(title)}</text>
    <text x="28" y="50" font-size="10" letter-spacing="1.2" fill="${alloy.colors.muted}">${escapeXml(`${alloy.label} · ${alloy.grade.grade} · contacts ${enabledContacts.length}${scanId ? ` · scan ${scanId}` : ''}`)}</text>
  </g>
  ${legend}
</svg>`;
    return svg;
  }

  /* ─────────────────────────────── plating ────────────────────────────── */

  /** Attach a chromium integrity plate to any AR payload. */
  /**
   * Reverse index: resolve an EX-ARX-… address to a scan, anchor, layer or map
   * tile. Scans are kept in history; layers and tiles are re-derived.
   * @returns {{type:'scan'|'anchor'|'layer'|'tile', record:object}|null}
   */
  findByAddress(address) {
    if (!address) return null;
    const state = this._state();
    const anchor = Object.values(state.anchors).find((a) => a.address === address);
    if (anchor) return { type: 'anchor', record: anchor };
    const scan = Object.values(state.scans || {}).find((s) => s.address === address);
    if (scan) return { type: 'scan', record: { scanId: scan.scanId, address: scan.address, mode: scan.mode, contactCount: scan.contactCount ?? scan.contacts?.length ?? 0, at: scan.at } };
    const layer = this.layers().layers.find((l) => l.address === address);
    if (layer) return { type: 'layer', record: layer };
    return null;
  }

  platePayload(payload, { subject = 'ar', kind = 'ar.payload' } = {}) {
    const stamp = plate(payload, {
      seed: this.seed,
      masterKey: this.keyring.masterKey,
      subject,
      kind,
      grade: this.alloy().grade.grade,
    });
    return { ...payload, chromePlate: stamp.plate, plateAddress: stamp.address, platedAt: stamp.platedAt };
  }

  stats() {
    const state = this._state();
    return {
      ...state.stats,
      liveAnchors: Object.values(state.anchors).filter((a) => Date.parse(a.expiresAt) > Date.now()).length,
      layers: LAYERS.length,
      scanModes: Object.keys(SCAN_MODES).length,
      privacyCellMeters: POSITION_CELL_M,
    };
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { ArOverlay, LAYERS, LAYER_IDS, SCAN_MODES, POSITION_CELL_M, escapeXml };
