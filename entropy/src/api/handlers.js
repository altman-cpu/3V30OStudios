'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CONTENT HANDLER REGISTRY  +  UNMASK DISPATCH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  "ENTROPY GENERATED ADDRESSES FOR ALL CONTENT HANDLERS"
 *
 *  Every route in routes.js declares a stable `handler` id. This module walks
 *  the router and derives, for each handler:
 *
 *      EX-HND-…   entropy address   (base58, checksummed, domain-tagged)
 *      0x…        EVM form          (binds straight into /contracts)
 *
 *  The registry is generated from the router, never hand-maintained — so the
 *  docs, the OpenAPI spec, GET /v1/handlers and the address on every response
 *  envelope cannot drift apart. Integrators can hard-code an address and know
 *  it identifies one exact operation on one exact network seed.
 *
 *  UNMASK DISPATCH
 *  A pending seal stores `kind` + `payload`. When it is unmasked we need to
 *  apply the parked effect. `UNMASK_DISPATCH` maps kind → applier, so the
 *  unmask endpoint is a single generic route rather than N special cases, and
 *  every gated write in the system remains replayable after the fact.
 */

const { deriveAddress, hashHex, nowIso } = require('../core/entropy-core');

/**
 * Build the handler registry from a router.
 * @param {import('../core/http').Router} router
 * @param {object} opts {seed, baseUrl}
 */
function buildHandlerRegistry(router, { seed, baseUrl = '', requiredSmartValueFor = () => 0 }) {
  const handlers = router.routes.map((route) => {
    const meta = route.meta;
    const addr = deriveAddress({
      domain: 'HND',
      seed,
      label: meta.handler,
      sublabel: `${route.method} ${route.pattern}`,
    });
    return {
      handler: meta.handler,
      method: route.method,
      path: route.pattern,
      url: `${baseUrl}${route.pattern}`,
      domain: meta.domain || meta.handler.split('.')[0],
      group: meta.group || meta.handler.split('.')[0],
      title: meta.title || meta.handler,
      summary: meta.summary || null,
      risk: meta.risk || null,
      requiredSmartValue: meta.risk ? requiredSmartValueFor(meta.risk) : 0,
      scopes: meta.scopes || [],
      auth: meta.auth !== false,
      entropyAddress: addr.address,
      evmAddress: addr.evm,
      digest: addr.digest,
      checksum: addr.checksum,
      idempotent: route.method === 'GET' || route.method === 'DELETE',
      pendingCapable: Boolean(meta.risk),
    };
  });

  const groups = {};
  for (const handler of handlers) {
    groups[handler.group] = groups[handler.group] || {
      group: handler.group,
      label: GROUP_LABELS[handler.group] || handler.group,
      address: deriveAddress({ domain: 'HND', seed, label: `group:${handler.group}`, sublabel: 'group' }).address,
      handlers: [],
    };
    groups[handler.group].handlers.push(handler);
  }

  return {
    protocol: 'ENTROPY',
    version: '1.0.0',
    networkSeedFingerprint: hashHex('fingerprint', seed).slice(0, 24),
    generatedAt: nowIso(),
    count: handlers.length,
    groups: Object.values(groups),
    handlers,
  };
}

const GROUP_LABELS = Object.freeze({
  system: 'System & Discovery',
  auth: 'Keyring & Auth Tokens',
  pending: 'Unmask Pool (pending seals)',
  memory: 'Entropy Memory',
  weave: 'Power Weaving',
  ar: 'AR Overlay',
  squad: 'AI Squad Companions',
  missions: 'Missions, Events & Seasons',
  multiplayer: 'Safe Multiplayer',
  miners: 'Reality Mining Stack',
  chromium: 'Entropy Chromium',
});

/**
 * Unmask dispatch table: seal.kind → applier(seal, ctx) → result.
 * Appliers must be idempotent where possible; a re-applied seal is rejected
 * upstream (status !== 'pending'), so the risk is a partial write, not a dupe.
 */
function buildUnmaskDispatch(systems) {
  const { memory, weave, ar, squad, missions, multiplayer, miners } = systems;
  return {
    /* ── Entropy Memory ─────────────────────────────────────────────── */
    'memory.match': (seal) => memory.recordMatch(seal.payload.profileId, seal.payload.match, { actor: seal.unmaskedBy || seal.subject }),
    'memory.remember': (seal) => memory.remember(seal.payload.profileId, seal.payload.trace, { actor: seal.unmaskedBy || seal.subject }),
    'memory.consolidate': (seal) => memory.consolidate(seal.payload.profileId, { actor: seal.unmaskedBy || seal.subject }),
    'memory.loadout': (seal) => memory.saveLoadout(seal.payload.profileId, seal.payload.loadout, {}),
    'memory.import': (seal) => memory.importProfile(seal.payload.bundle, { actor: seal.unmaskedBy || seal.subject }),

    /* ── Power Weaving ──────────────────────────────────────────────── */
    'weave.unlock': (seal) => weave.unlock(seal.payload.profileId, seal.payload.abilityId, { payWith: seal.payload.payWith || 'rlu', actor: seal.unmaskedBy || seal.subject }),
    'weave.fuse': (seal) => weave.weave(seal.payload.profileId, seal.payload.abilityIds, { actor: seal.unmaskedBy || seal.subject }),
    'weave.unweave': (seal) => weave.unweave(seal.payload.profileId, seal.payload.fusionId, { actor: seal.unmaskedBy || seal.subject }),

    /* ── AR overlay ─────────────────────────────────────────────────── */
    'ar.anchor': (seal) => ar.createAnchor(seal.payload.anchor, { actor: seal.unmaskedBy || seal.subject }),
    'ar.anchor.remove': (seal) => ar.removeAnchor(seal.payload.anchorId, { actor: seal.unmaskedBy || seal.subject }),

    /* ── Squad ──────────────────────────────────────────────────────── */
    'squad.drill': (seal) => squad.drill(seal.payload.profileId, seal.payload.companionId, seal.payload.tactic, { intensity: seal.payload.intensity || 1, actor: seal.unmaskedBy || seal.subject }),
    'squad.learn': (seal) => squad.learnFromMatch(seal.payload),

    /* ── Missions & seasons ─────────────────────────────────────────── */
    'missions.complete': (seal) => missions.complete(seal.payload.profileId, seal.payload.missionId, { actor: seal.unmaskedBy || seal.subject }),
    'missions.season.claim': (seal) => missions.seasonProgress(seal.payload.profileId, { claim: true }),
    'missions.event.trigger': (seal) => missions.triggerWorldEvent(seal.payload.event, { actor: seal.unmaskedBy || seal.subject }),

    /* ── Multiplayer ────────────────────────────────────────────────── */
    'multiplayer.lobby': (seal) => multiplayer.createLobby(seal.payload.profileId, seal.payload.lobby, { actor: seal.unmaskedBy || seal.subject }),
    'multiplayer.join': (seal) => multiplayer.joinLobby(seal.payload, { actor: seal.unmaskedBy || seal.subject }),
    'multiplayer.moderate': (seal) => multiplayer.moderate(seal.payload.lobbyId, seal.payload.action, { actor: seal.unmaskedBy || seal.subject, isModerator: true }),
    'multiplayer.sanction': (seal) => multiplayer.applySanction(seal.payload.reportId, seal.payload.proposedAction || 'kick', { actor: seal.unmaskedBy || seal.subject }),
    'multiplayer.raid': (seal) => multiplayer.createRaid(seal.payload.lobbyId, seal.payload.raid || {}, { actor: seal.unmaskedBy || seal.subject }),

    /* ── Reality mining ─────────────────────────────────────────────── */
    'miners.credit': (seal) => miners.creditReality({ profileId: seal.payload.profileId, amount: seal.payload.amount, reason: seal.payload.reason || 'unmasked credit', kind: seal.payload.kind || 'adjustment', actor: seal.unmaskedBy || seal.subject }),
    'miners.spend': (seal) => miners.spendReality({ profileId: seal.payload.profileId, amount: seal.payload.amount, reason: seal.payload.reason || 'unmasked spend', actor: seal.unmaskedBy || seal.subject }),
  };
}

module.exports = { buildHandlerRegistry, buildUnmaskDispatch, GROUP_LABELS };
