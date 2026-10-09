'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  REALITY MINING STACK  —  a complete miner stack that mines *world content*
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Every piece of a real proof-of-work stack is here, in the same order you
 *  would learn it:
 *
 *      1. HEADER          version · prevHash · height · timestamp · seedRoot ·
 *                         difficultyBits · nonce
 *      2. HASH            sha256( canonical(header) )
 *      3. TARGET          the hash must have ≥ difficultyBits leading zero bits
 *      4. NONCE SEARCH    increment nonce until the target is met (the "work")
 *      5. DIFFICULTY      retarget every N blocks toward a target block time
 *      6. CHAIN           each block points at its parent; verifyChain() walks
 *                         the whole thing and re-checks every PoW + link
 *      7. POOL            workers submit low-difficulty *shares*; the pool
 *                         assembles blocks and splits the reward by share
 *      8. WORK PROTOCOL   long-poll getWork / submitWork (stratum-shaped JSON,
 *                         so a real stratum bridge is a thin adapter)
 *      9. STALE / ORPHAN  submissions against a superseded job are rejected as
 *                         stale and counted, never silently dropped
 *     10. WALLET / LEDGER a per-profile balance with a full double-entry-style
 *                         history (credit, spend, refund, reward)
 *
 *  ── THE ONE CHANGE ────────────────────────────────────────────────────────
 *  The coinbase does not pay a currency. It pays **reality**:
 *
 *      block hash  ──►  reality fragments (scenes, laws, voices, terrain,
 *                       artifacts, glyphs, weather, memory traces)
 *
 *  Those fragments are then *consumed by the rest of the product*:
 *      • terrain fragments shape AR map tiles and raid difficulty
 *      • artifact fragments become weaveable abilities (Power Weaving)
 *      • voice fragments become companion dialogue
 *      • scene/law fragments become mission venues and season law
 *      • memory fragments become recallable Entropy Memory traces
 *
 *  The unit of account is the **Reality Unit (RLU)**. It is an internal
 *  accounting number that measures *how much world content a miner
 *  contributed*. It is not money, not a security, not a token, has no market,
 *  no exchange, no price and cannot be transferred off-network. There is
 *  deliberately **no halving scarcity curve**: content should get cheaper to
 *  produce over time, not scarcer.
 *
 *  Difficulty is expressed in leading zero bits (8..24 here) rather than the
 *  packed nBits of Bitcoin — same idea, one less bit-twiddling trap to teach.
 */

const crypto = require('node:crypto');
const {
  deriveAddress,
  createRng,
  hashHex,
  canonicalize,
  nowIso,
  clamp,
  round,
} = require('../core/entropy-core');
const { realityFromBlock, fragmentFromHash } = require('../core/reality-gen');
const { toBadRequest, toNotFound, toConflict } = require('../core/http');

const DOMAIN = 'miners';

/* ── consensus parameters (the "pro detail" table) ────────────────────────── */

const CONSENSUS = Object.freeze({
  version: 1,
  minDifficultyBits: 8, // ~256 hashes expected — instant, good for tests
  maxDifficultyBits: 24, // ~16.7M hashes — still feasible on a laptop
  genesisDifficultyBits: 12, // ~4096 hashes ≈ tens of ms in JS
  targetBlockMs: 4000, // what the retarget aims for
  retargetInterval: 5, // blocks between retargets (Bitcoin uses 2016)
  retargetMaxFactor: 2, // clamp: difficulty may at most double/halve per window
  shareDifficultyOffset: 4, // share target = block target − 4 bits (16× easier)
  maxFutureTimeMs: 2 * 60 * 1000, // reject blocks from "the future"
  jobTtlMs: 45 * 1000, // long-poll work expires
  baseSubsidyRlu: 25, // content subsidy per accepted block
  subsidyPerDifficultyBit: 3, // more work ⇒ more content budget
  fragmentCapPerBlock: 6,
  payoutPrecision: 2,
});

const LEDGER_KINDS = Object.freeze(['subsidy', 'fragment', 'share', 'spend', 'refund', 'mission', 'season', 'raid', 'adjustment']);

class RealityMiners {
  /**
   * @param {object} deps
   * @param {import('../core/vault').Vault} deps.vault
   * @param {import('../core/keyring').Keyring} deps.keyring
   * @param {import('../core/http').EventBus} deps.bus
   * @param {string} deps.seed
   */
  constructor({ vault, keyring, bus, seed, consensus = null }) {
    this.vault = vault;
    this.keyring = keyring;
    this.bus = bus;
    this.seed = seed;
    this.C = { ...CONSENSUS, ...(consensus || {}) };
    this.peers = {};
  }

  attach(peers) {
    this.peers = { ...this.peers, ...peers };
    return this;
  }

  _state() {
    return this.vault.read(DOMAIN, {
      chain: [], // ordered block headers + rewards
      byHash: {},
      tip: null,
      height: -1,
      difficultyBits: this.C.genesisDifficultyBits,
      retargets: [],
      wallets: {}, // profileId → { rlu, artifacts, fragments, ledger }
      workers: {}, // workerId → { … }
      jobs: {}, // jobId → { … }
      pool: { shares: 0, blocksFound: 0, payouts: [], pendingShares: {} },
      fragments: {}, // fragment address → fragment
      fragmentsByKind: {},
      indexes: { byKind: {}, recent: [] },
      stats: {
        blocks: 0,
        hashes: 0,
        shares: 0,
        stale: 0,
        orphaned: 0,
        rejected: 0,
        rluEmitted: 0,
        fragmentsEmitted: 0,
        artifactsMinted: 0,
        abilitiesGenerated: 0,
        startedAt: null,
        solveTimesMs: [],
      },
    });
  }

  _save(state, meta = {}) {
    return this.vault.write(DOMAIN, state, { handler: 'miners', ...meta });
  }

  /* ────────────────────────────── hashing ─────────────────────────────── */

  /** Canonical header serialisation → sha256 hex. */
  static headerHash(header) {
    return crypto.createHash('sha256').update(canonicalize(header)).digest('hex');
  }

  /** Count leading zero bits of a 64-hex digest. */
  static leadingZeroBits(hex) {
    let bits = 0;
    for (let i = 0; i < hex.length; i += 1) {
      const nibble = parseInt(hex[i], 16);
      if (nibble === 0) {
        bits += 4;
        continue;
      }
      bits += Math.clz32(nibble) - 28; // 4-bit value: clz32 gives 28 extra
      break;
    }
    return bits;
  }

  /**
   * Extract ONLY the consensus fields from a stored block. Anything else on the
   * record (addresses, rewards, reality) is derived metadata and must never
   * enter the hash — that is what makes verifyChain() trustworthy.
   */
  static headerOf(block) {
    const header = {
      version: block.version,
      prevHash: block.prevHash,
      height: block.height,
      timestamp: block.timestamp,
      seedRoot: block.seedRoot,
      difficultyBits: block.difficultyBits,
      miner: block.miner,
      nonce: block.nonce,
    };
    if (block.note !== undefined) header.note = block.note;
    return header;
  }

  /** Does this hash satisfy the difficulty target? */
  static meetsTarget(hex, difficultyBits) {
    return RealityMiners.leadingZeroBits(hex) >= difficultyBits;
  }

  /** Human-readable target description (for the HUD + docs). */
  static targetDescription(difficultyBits) {
    return {
      difficultyBits,
      leadingZeros: Math.floor(difficultyBits / 4),
      expectedHashes: Math.pow(2, difficultyBits),
      oneIn: `1 in ${Math.pow(2, difficultyBits).toExponential(2)}`,
    };
  }

  /* ─────────────────────────────── genesis ────────────────────────────── */

  /** Create the genesis block (idempotent). */
  ensureGenesis(state = this._state()) {
    if (state.chain.length) return state.chain[0];
    const header = {
      version: this.C.version,
      prevHash: '0'.repeat(64),
      height: 0,
      timestamp: Date.now(),
      seedRoot: hashHex('genesis-seed-root', this.seed),
      difficultyBits: this.C.genesisDifficultyBits,
      nonce: 0,
      miner: 'genesis',
      note: 'GENESIS UNMASK — reality, not currency',
    };
    // Genesis is *ground*: we search for a valid nonce so even block 0 carries
    // real work. Cheap at genesis difficulty.
    const mined = this._searchNonce(header, this.C.genesisDifficultyBits, { maxHashes: 5_000_000 });
    header.nonce = mined.nonce;
    const hash = RealityMiners.headerHash(header);
    const address = deriveAddress({ domain: 'BLK', seed: this.seed, label: hash, sublabel: 'height:0' });
    const reality = realityFromBlock({ blockHash: hash, seed: this.seed, blockAddress: address.address, count: 3 });

    const block = {
      ...header,
      hash,
      address: address.address,
      evmAddress: address.evm,
      leadingZeroBits: RealityMiners.leadingZeroBits(hash),
      workHashes: mined.hashes,
      solveMs: mined.ms,
      isGenesis: true,
      reality,
      subsidyRlu: 0,
      totalRlu: round(reality.rlu, this.C.payoutPrecision),
      acceptedAt: nowIso(),
    };

    state.chain.push(block);
    state.byHash[hash] = block;
    state.tip = hash;
    state.height = 0;
    state.difficultyBits = this.C.genesisDifficultyBits;
    state.stats.blocks = 1;
    state.stats.hashes += mined.hashes;
    state.stats.startedAt = nowIso();
    this._indexFragments(state, block);
    this._save(state, { actor: 'system', kind: 'miners.genesis', reason: `genesis block ${hash.slice(0, 12)}…` });
    this.bus.emit('miners.genesis', { hash, address: block.address, height: 0, reality: reality.count });
    return block;
  }

  /** Nonce search with a hash budget. Returns {nonce, hash, hashes, ms}. */
  _searchNonce(header, difficultyBits, { maxHashes = 20_000_000, onProgress = null } = {}) {
    const started = Date.now();
    let nonce = header.nonce || 0;
    let hashes = 0;
    const base = { ...header };
    for (;;) {
      base.nonce = nonce;
      const hash = RealityMiners.headerHash(base);
      hashes += 1;
      if (RealityMiners.meetsTarget(hash, difficultyBits)) {
        return { nonce, hash, hashes, ms: Date.now() - started };
      }
      if (hashes >= maxHashes) return { nonce, hash, hashes, ms: Date.now() - started, exhausted: true };
      nonce += 1;
      if (onProgress && hashes % 50_000 === 0) onProgress({ hashes, nonce, ms: Date.now() - started });
    }
  }

  /* ───────────────────────── difficulty retarget ──────────────────────── */

  /**
   * Retarget difficulty toward `targetBlockMs` using the median solve time of
   * the last window. Median (not mean) so one slow block cannot wreck the curve.
   * Clamped to ×2 / ÷2 per window, exactly like Bitcoin's 4× clamp but tighter.
   */
  retarget(state) {
    if (state.chain.length < this.C.retargetInterval) return null;
    const windowBlocks = state.chain.slice(-this.C.retargetInterval);
    const times = windowBlocks.map((b) => b.solveMs || this.C.targetBlockMs).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] || this.C.targetBlockMs;
    const factor = clamp(median / this.C.targetBlockMs, 1 / this.C.retargetMaxFactor, this.C.retargetMaxFactor);
    const before = state.difficultyBits;
    // Bits are logarithmic: a 2× time overrun ≈ +1 bit.
    const nextBits = clamp(Math.round(before + Math.log2(factor)), this.C.minDifficultyBits, this.C.maxDifficultyBits);
    const record = {
      atHeight: state.height,
      at: nowIso(),
      medianSolveMs: median,
      targetBlockMs: this.C.targetBlockMs,
      factor: round(factor, 4),
      fromBits: before,
      toBits: nextBits,
      windowBlocks: windowBlocks.map((b) => ({ height: b.height, solveMs: b.solveMs, hash: b.hash.slice(0, 12) })),
    };
    state.difficultyBits = nextBits;
    state.retargets = [record, ...state.retargets].slice(0, 100);
    this.bus.emit('miners.retarget', record);
    return record;
  }

  /* ─────────────────────────────── wallets ────────────────────────────── */

  _wallet(state, profileId) {
    if (!state.wallets[profileId]) {
      const address = deriveAddress({ domain: 'MIN', seed: this.seed, label: `wallet:${profileId}`, sublabel: 'rlu' });
      state.wallets[profileId] = {
        profileId,
        address: address.address,
        evmAddress: address.evm,
        rlu: 0,
        lifetimeRlu: 0,
        artifacts: [],
        fragmentAddresses: [],
        blocksMined: 0,
        sharesSubmitted: 0,
        ledger: [],
        createdAt: nowIso(),
        note: 'RLU is an internal content-accounting unit. It is not money and has no market.',
      };
    }
    return state.wallets[profileId];
  }

  /**
   * Credit reality to a wallet. Every credit is ledgered with a kind so the
   * HUD can answer "where did this come from?".
   */
  creditReality({ profileId, amount, reason = null, kind = 'subsidy', actor = null, ref = null }) {
    const state = this._state();
    const wallet = this._wallet(state, profileId);
    const value = round(Math.max(0, Number(amount) || 0), this.C.payoutPrecision);
    wallet.rlu = round(wallet.rlu + value, this.C.payoutPrecision);
    wallet.lifetimeRlu = round(wallet.lifetimeRlu + value, this.C.payoutPrecision);
    wallet.ledger = [
      { at: nowIso(), kind, direction: 'credit', amount: value, balance: wallet.rlu, reason, ref, actor: actor || profileId },
      ...wallet.ledger,
    ].slice(0, 500);
    this._save(state, { actor: actor || profileId, kind: `miners.credit.${kind}`, reason: `${value} RLU → ${profileId}` });
    return { ok: true, profileId, credited: value, balance: wallet.rlu, lifetime: wallet.lifetimeRlu, address: wallet.address };
  }

  /** Spend reality (ability unlock, loot, season claim). Fails closed. */
  spendReality({ profileId, amount, reason = null, actor = null, ref = null }) {
    const state = this._state();
    const wallet = this._wallet(state, profileId);
    const value = round(Math.max(0, Number(amount) || 0), this.C.payoutPrecision);
    if (wallet.rlu < value) {
      return { ok: false, code: 'insufficient_rlu', detail: { profileId, balance: wallet.rlu, required: value, shortfall: round(value - wallet.rlu, 2), reason } };
    }
    wallet.rlu = round(wallet.rlu - value, this.C.payoutPrecision);
    wallet.ledger = [{ at: nowIso(), kind: 'spend', direction: 'debit', amount: value, balance: wallet.rlu, reason, ref, actor: actor || profileId }, ...wallet.ledger].slice(0, 500);
    this._save(state, { actor: actor || profileId, kind: 'miners.spend', reason: `${value} RLU from ${profileId}` });
    return { ok: true, profileId, spent: value, balance: wallet.rlu, address: wallet.address };
  }

  /** Refund (fracture recovery, failed seal). */
  refundReality({ profileId, amount, reason = null, actor = null }) {
    return this.creditReality({ profileId, amount, reason, kind: 'refund', actor });
  }

  /** Wallet view with ledger tail and holdings. */
  walletView(profileId, { ledgerLimit = 25 } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const wallet = this._wallet(state, profileId);
    this._save(state, { actor: profileId, kind: 'miners.wallet.read' });
    return {
      ...wallet,
      ledger: wallet.ledger.slice(0, clamp(ledgerLimit, 1, 200)),
      artifacts: wallet.artifacts.slice(0, 40),
      fragmentCount: wallet.fragmentAddresses.length,
      fragmentAddresses: wallet.fragmentAddresses.slice(0, 40),
      unit: { symbol: 'RLU', name: 'Reality Unit', monetary: false, transferableOffNetwork: false, market: null, note: 'content accounting only' },
    };
  }

  /* ─────────────────────────── work protocol ──────────────────────────── */

  /** Register a miner worker (pool or solo). */
  registerWorker({ workerId = null, profileId, label = null, pool = true }, { actor = null } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const id = workerId || `wkr-${hashHex('worker', this.seed, profileId, nowIso()).slice(0, 12)}`;
    const existing = state.workers[id];
    const worker = {
      workerId: id,
      address: deriveAddress({ domain: 'MIN', seed: this.seed, label: id, sublabel: pool ? 'pool' : 'solo' }).address,
      evmAddress: deriveAddress({ domain: 'MIN', seed: this.seed, label: id, sublabel: pool ? 'pool' : 'solo' }).evm,
      profileId,
      label: label || existing?.label || id,
      mode: pool ? 'pool' : 'solo',
      registeredAt: existing?.registeredAt || nowIso(),
      lastSeenAt: nowIso(),
      shares: existing?.shares || 0,
      blocks: existing?.blocks || 0,
      hashes: existing?.hashes || 0,
      hashrate: existing?.hashrate || 0,
      staleShares: existing?.staleShares || 0,
      payoutShare: existing?.payoutShare || 0,
      status: 'idle',
    };
    state.workers[id] = worker;
    this._save(state, { actor: actor || profileId, kind: 'miners.worker.register', reason: id });
    this.bus.emit('miners.worker.registered', { workerId: id, address: worker.address, mode: worker.mode });
    return worker;
  }

  /**
   * Long-poll work assignment (the stratum `mining.notify` equivalent).
   * The client gets a header template with the nonce field blank plus the
   * target. Jobs expire so a retarget or a new tip invalidates old work.
   */
  getWork({ workerId, profileId = null, extraSeed = null } = {}) {
    const state = this._state();
    const genesis = this.ensureGenesis(state);
    const worker = workerId ? state.workers[workerId] : null;
    if (workerId && !worker) throw toNotFound(`unknown worker: ${workerId}`, { hint: 'POST /v1/miners/workers first' });

    const jobId = hashHex('job', this.seed, state.tip, workerId || profileId || 'solo', Date.now(), extraSeed || '').slice(0, 18);
    const headerTemplate = {
      version: this.C.version,
      prevHash: state.tip,
      height: state.height + 1,
      timestamp: Date.now(),
      seedRoot: hashHex('seed-root', this.seed, state.tip, jobId),
      difficultyBits: state.difficultyBits,
      miner: workerId || profileId || 'solo',
      nonce: 0,
    };
    const job = {
      jobId,
      address: deriveAddress({ domain: 'MIN', seed: this.seed, label: jobId, sublabel: 'job' }).address,
      workerId: workerId || null,
      profileId: profileId || worker?.profileId || null,
      headerTemplate,
      blockTarget: RealityMiners.targetDescription(state.difficultyBits),
      shareTarget: RealityMiners.targetDescription(Math.max(this.C.minDifficultyBits, state.difficultyBits - this.C.shareDifficultyOffset)),
      issuedAt: nowIso(),
      expiresAt: new Date(Date.now() + this.C.jobTtlMs).toISOString(),
      prevHeight: state.height,
      prevHash: state.tip,
      genesisAddress: genesis.address,
      rewardPreview: {
        subsidyRlu: round(this.C.baseSubsidyRlu + this.C.subsidyPerDifficultyBit * state.difficultyBits, 2),
        expectedFragments: '1–4 (hash-derived)',
        unit: 'RLU (non-monetary)',
      },
      note: 'Search `nonce` until sha256(canonical(header)) has ≥ difficultyBits leading zero bits. Submit every nonce that meets the SHARE target; the pool assembles blocks.',
    };
    state.jobs[jobId] = { ...job, headerTemplate };
    // Keep the job table small; expired jobs are re-issued on the next poll.
    const jobIds = Object.keys(state.jobs);
    if (jobIds.length > 400) for (const id of jobIds.slice(0, jobIds.length - 400)) delete state.jobs[id];
    if (worker) {
      worker.status = 'working';
      worker.lastSeenAt = nowIso();
      worker.currentJob = jobId;
    }
    this._save(state, { actor: worker?.profileId || profileId || 'system', kind: 'miners.work.issue', reason: jobId });
    return job;
  }

  /**
   * Submit work. Three outcomes:
   *
   *   • meets block target  → new block appended, reality generated, payouts
   *   • meets share target  → pool share credited (progress toward next block)
   *   • neither / stale job → rejected with a precise reason
   */
  submitWork({ jobId, nonce, workerId = null, hashes = null, profileId = null }, { actor = null } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const job = state.jobs[jobId];
    if (!job) throw toNotFound(`unknown or expired job: ${jobId}`, { hint: 'GET /v1/miners/work for a fresh job' });

    const worker = workerId ? state.workers[workerId] : null;
    const beneficiary = profileId || worker?.profileId || job.profileId;
    if (!beneficiary) throw toBadRequest('submission needs a beneficiary profileId');

    if (Date.parse(job.expiresAt) <= Date.now()) {
      state.stats.stale += 1;
      if (worker) worker.staleShares += 1;
      this._save(state, { actor: beneficiary, kind: 'miners.submit.stale', reason: jobId });
      return { accepted: false, code: 'job_expired', detail: { jobId, expiresAt: job.expiresAt }, stats: this.stats(state) };
    }
    if (job.headerTemplate.prevHash !== state.tip) {
      state.stats.stale += 1;
      if (worker) worker.staleShares += 1;
      this._save(state, { actor: beneficiary, kind: 'miners.submit.stale', reason: 'tip moved' });
      return { accepted: false, code: 'stale_tip', detail: { jobPrevHash: job.headerTemplate.prevHash, currentTip: state.tip, height: state.height }, stats: this.stats(state) };
    }

    const header = { ...job.headerTemplate, nonce: Number(nonce) || 0 };
    if (!Number.isFinite(header.nonce) || header.nonce < 0) throw toBadRequest('nonce must be a non-negative integer', { nonce });
    const hash = RealityMiners.headerHash(header);
    const bits = RealityMiners.leadingZeroBits(hash);
    const attempted = Number(hashes) || 1;
    state.stats.hashes += attempted;
    if (worker) {
      worker.hashes += attempted;
      worker.lastSeenAt = nowIso();
    }

    const meetsBlock = bits >= header.difficultyBits;
    const meetsShare = bits >= Math.max(this.C.minDifficultyBits, header.difficultyBits - this.C.shareDifficultyOffset);

    if (!meetsShare) {
      state.stats.rejected += 1;
      this._save(state, { actor: beneficiary, kind: 'miners.submit.reject', reason: `${bits} bits < share target` });
      return {
        accepted: false,
        code: 'below_share_target',
        detail: { hash, leadingZeroBits: bits, shareTargetBits: header.difficultyBits - this.C.shareDifficultyOffset, blockTargetBits: header.difficultyBits },
        stats: this.stats(state),
      };
    }

    // ── share accounting ────────────────────────────────────────────────
    state.pool.shares += 1;
    state.stats.shares += 1;
    if (worker) worker.shares += 1;
    const shareBucket = state.pool.pendingShares[state.tip] || {};
    shareBucket[beneficiary] = (shareBucket[beneficiary] || 0) + 1;
    state.pool.pendingShares[state.tip] = shareBucket;
    if (worker) {
      const elapsedSec = Math.max(1, (Date.now() - Date.parse(worker.registeredAt)) / 1000);
      worker.hashrate = round(worker.hashes / elapsedSec, 1);
    }

    if (!meetsBlock) {
      this._save(state, { actor: beneficiary, kind: 'miners.share.accept', reason: `${bits} bits` });
      this.bus.emit('miners.share', { workerId: worker?.workerId || null, beneficiary, bits, shares: state.pool.shares });
      if (this.peers.missions) this.peers.missions.observe({ profileId: beneficiary, event: 'miner.share', amount: 1 });
      return {
        accepted: true,
        block: false,
        share: true,
        hash,
        leadingZeroBits: bits,
        shareTargetBits: header.difficultyBits - this.C.shareDifficultyOffset,
        blockTargetBits: header.difficultyBits,
        poolShares: state.pool.shares,
        yourShares: shareBucket[beneficiary],
        stats: this.stats(state),
      };
    }

    // ── full block ──────────────────────────────────────────────────────
    return this._acceptBlock(state, { header, hash, bits, beneficiary, worker, jobId, attempted });
  }

  /** Append a solved block, generate reality, pay the pool split. */
  _acceptBlock(state, { header, hash, bits, beneficiary, worker, jobId, attempted }) {
    if (state.byHash[hash]) {
      state.stats.orphaned += 1;
      return { accepted: false, code: 'duplicate_block', detail: { hash, existingHeight: state.byHash[hash].height } };
    }
    const solveStarted = Date.now();
    const address = deriveAddress({ domain: 'BLK', seed: this.seed, label: hash, sublabel: `height:${header.height}` });
    const reality = realityFromBlock({ blockHash: hash, seed: this.seed, blockAddress: address.address, count: clamp(bits >= header.difficultyBits + 4 ? 4 : 3, 1, this.C.fragmentCapPerBlock) });

    const subsidy = round(this.C.baseSubsidyRlu + this.C.subsidyPerDifficultyBit * header.difficultyBits, 2);
    const totalRlu = round(subsidy + reality.rlu, this.C.payoutPrecision);

    const block = {
      ...header,
      hash,
      address: address.address,
      evmAddress: address.evm,
      leadingZeroBits: bits,
      workHashes: attempted,
      solveMs: Math.max(1, Date.now() - solveStarted),
      isGenesis: false,
      reality,
      subsidyRlu: subsidy,
      totalRlu,
      // `miner` above (from the spread header) is the CONSENSUS field and must
      // stay byte-identical to what was hashed. The beneficiary is metadata.
      minedBy: beneficiary,
      workerId: worker?.workerId || null,
      jobId: jobId || null,
      acceptedAt: nowIso(),
    };

    state.chain.push(block);
    state.byHash[hash] = block;
    state.tip = hash;
    state.height = header.height;
    state.stats.blocks += 1;
    state.stats.hashes += attempted;
    state.stats.rluEmitted = round(state.stats.rluEmitted + totalRlu, 2);
    state.stats.fragmentsEmitted += reality.count;
    state.stats.solveTimesMs = [...state.stats.solveTimesMs, block.solveMs].slice(-40);
    if (worker) {
      worker.blocks += 1;
      worker.status = 'idle';
    }

    // ── pool payout split by share weight ────────────────────────────────
    const bucket = state.pool.pendingShares[state.chain[state.chain.length - 2]?.hash] || {};
    const totalShares = Object.values(bucket).reduce((s, v) => s + v, 0);
    const payouts = [];
    if (totalShares > 0) {
      for (const [pid, shares] of Object.entries(bucket)) {
        const weight = shares / totalShares;
        const amount = round(totalRlu * weight, this.C.payoutPrecision);
        if (amount <= 0) continue;
        const wallet = this._wallet(state, pid);
        wallet.rlu = round(wallet.rlu + amount, this.C.payoutPrecision);
        wallet.lifetimeRlu = round(wallet.lifetimeRlu + amount, this.C.payoutPrecision);
        wallet.blocksMined += pid === beneficiary ? 1 : 0;
        wallet.ledger = [{ at: nowIso(), kind: 'share', direction: 'credit', amount, balance: wallet.rlu, reason: `pool split ${shares}/${totalShares} shares of block ${header.height}`, ref: { blockHash: hash, height: header.height }, actor: 'pool' }, ...wallet.ledger].slice(0, 500);
        payouts.push({ profileId: pid, shares, weight: round(weight, 4), amount });
      }
      state.pool.payouts = [{ blockHeight: header.height, blockHash: hash, at: nowIso(), totalRlu, payouts }, ...state.pool.payouts].slice(0, 200);
      delete state.pool.pendingShares[state.chain[state.chain.length - 2]?.hash];
    } else {
      // Solo: the block finder takes the whole reward.
      const wallet = this._wallet(state, beneficiary);
      wallet.rlu = round(wallet.rlu + totalRlu, this.C.payoutPrecision);
      wallet.lifetimeRlu = round(wallet.lifetimeRlu + totalRlu, this.C.payoutPrecision);
      wallet.blocksMined += 1;
      wallet.ledger = [{ at: nowIso(), kind: 'subsidy', direction: 'credit', amount: totalRlu, balance: wallet.rlu, reason: `solo block ${header.height}`, ref: { blockHash: hash }, actor: beneficiary }, ...wallet.ledger].slice(0, 500);
      payouts.push({ profileId: beneficiary, shares: 0, weight: 1, amount: totalRlu, solo: true });
    }

    // Finder's artifacts + fragment custody
    const finderWallet = this._wallet(state, beneficiary);
    for (const fragment of reality.fragments) {
      finderWallet.fragmentAddresses = [fragment.address, ...finderWallet.fragmentAddresses].slice(0, 500);
      if (fragment.kind === 'artifact') {
        finderWallet.artifacts = [
          { address: fragment.artifactAddress || fragment.address, title: fragment.title, family: fragment.family, trait: fragment.trait, rarity: fragment.rarity, stats: fragment.stats, blockHeight: header.height, at: nowIso() },
          ...finderWallet.artifacts,
        ].slice(0, 200);
        state.stats.artifactsMinted += 1;
      }
    }
    state.pool.blocksFound += 1;

    this._indexFragments(state, block);

    // Power Weaving consumes artifact fragments → generated abilities.
    let abilities = [];
    if (this.peers.weave) {
      try {
        const ingested = this.peers.weave.ingestBlock(block, { actor: beneficiary });
        abilities = ingested.abilities || [];
        state.stats.abilitiesGenerated += ingested.abilitiesCreated || 0;
      } catch {
        abilities = []; // weaving is an enhancement, never a consensus dependency
      }
    }

    const retarget = (state.height + 1) % this.C.retargetInterval === 0 ? this.retarget(state) : null;

    this._save(state, { actor: beneficiary, kind: 'miners.block.accept', reason: `height ${header.height} @ ${bits} bits` });
    this.bus.emit('miners.block', {
      height: header.height,
      hash,
      address: block.address,
      miner: beneficiary,
      difficultyBits: header.difficultyBits,
      leadingZeroBits: bits,
      realityCount: reality.count,
      rlu: totalRlu,
      rarest: reality.rarest,
      solveMs: block.solveMs,
      nextDifficulty: state.difficultyBits,
      retarget,
    });

    if (this.peers.missions) {
      this.peers.missions.observe({ profileId: beneficiary, event: 'miner.block', amount: 1, meta: { height: header.height } });
    }
    if (this.peers.memory) {
      this.peers.memory.remember(beneficiary, {
        kind: 'mined',
        text: `Mined reality block ${header.height} (${bits} zero bits, ${totalRlu} RLU). Found: ${reality.fragments.map((f) => `${f.kind}·${f.rarity}`).join(', ')}.`,
        tags: ['miner', 'block', reality.rarest?.toLowerCase() || 'common'],
        resonance: 2 + bits / 6,
        decayDays: 365,
        source: 'miner',
        ref: { blockHash: hash, address: block.address, height: header.height },
      }, { actor: beneficiary });
      const profile = this.peers.memory.getProfile(beneficiary);
      if (profile) {
        profile.record.realityMined += 1;
        profile.record.rluLifetime = round((profile.record.rluLifetime || 0) + totalRlu, 2);
      }
    }

    return {
      accepted: true,
      block: true,
      share: true,
      height: header.height,
      hash,
      address: block.address,
      evmAddress: block.evmAddress,
      leadingZeroBits: bits,
      difficultyBits: header.difficultyBits,
      solveMs: block.solveMs,
      workHashes: attempted,
      subsidyRlu: subsidy,
      totalRlu,
      reality,
      payouts,
      abilitiesGenerated: abilities.map((a) => ({ id: a.id, name: a.name, address: a.address, school: a.school, rarity: a.rarity })),
      retarget,
      tip: state.tip,
      stats: this.stats(state),
      blockRecord: { ...block, reality: { count: reality.count, rlu: reality.rlu, rarest: reality.rarest } },
    };
  }

  /** Index every fragment of a block for fast lookup by other systems. */
  _indexFragments(state, block) {
    for (const fragment of block.reality?.fragments || []) {
      state.fragments[fragment.address] = { ...fragment, blockHeight: block.height, blockHash: block.hash, minedAt: block.acceptedAt };
      state.fragmentsByKind[fragment.kind] = state.fragmentsByKind[fragment.kind] || [];
      state.fragmentsByKind[fragment.kind] = [fragment.address, ...state.fragmentsByKind[fragment.kind]].slice(0, 400);
      state.indexes.recent = [fragment.address, ...state.indexes.recent].slice(0, 400);
    }
  }

  /* ─────────────────── in-process mining (CLI / demo) ─────────────────── */

  /**
   * Mine locally for a time budget. Used by `entropy mine` and by the HUD's
   * "mine a block" button so a visitor can see the chain move without
   * installing anything.
   *
   * @param {object} opts
   * @param {string} opts.profileId     beneficiary
   * @param {number} [opts.seconds]     time budget (default 5)
   * @param {number} [opts.blocks]      stop after N blocks
   * @param {(info:object)=>void} [opts.onBlock]
   */
  mineLocal({ profileId, seconds = 5, blocks = 1, workerId = null, onBlock = null, onProgress = null } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    if (!profileId) throw toBadRequest('mineLocal requires a beneficiary profileId');
    const deadline = Date.now() + clamp(Number(seconds) || 5, 1, 600) * 1000;
    const wanted = clamp(Number(blocks) || 1, 1, 50);
    const mined = [];
    let hashes = 0;

    if (workerId && !state.workers[workerId]) this.registerWorker({ workerId, profileId, label: 'local-cli', pool: false });

    while (mined.length < wanted && Date.now() < deadline) {
      const job = this.getWork({ workerId, profileId });
      const header = { ...job.headerTemplate, nonce: 0 };
      const started = Date.now();
      let nonce = 0;
      let hash = null;
      let bits = 0;
      const budget = 2_000_000;
      while (Date.now() < deadline) {
        header.nonce = nonce;
        hash = RealityMiners.headerHash(header);
        bits = RealityMiners.leadingZeroBits(hash);
        hashes += 1;
        nonce += 1;
        if (bits >= header.difficultyBits) break;
        if (nonce % 25_000 === 0 && onProgress) onProgress({ hashes, nonce, ms: Date.now() - started, difficultyBits: header.difficultyBits });
        if (nonce > budget) break;
      }
      if (bits < header.difficultyBits) break; // budget exhausted

      const attempted = nonce;
      // submitWork re-reads and re-writes state itself, so we do not touch our
      // local snapshot between iterations — it would clobber the write.
      const submission = this.submitWork({ jobId: job.jobId, nonce: header.nonce, workerId, hashes: attempted, profileId }, { actor: profileId });
      if (submission.accepted && submission.block) {
        mined.push({ height: submission.height, hash: submission.hash, address: submission.address, rlu: submission.totalRlu, realityCount: submission.reality.count, rarest: submission.reality.rarest, solveMs: submission.solveMs, difficultyBits: submission.difficultyBits, leadingZeroBits: submission.leadingZeroBits });
        if (onBlock) onBlock(submission);
      } else if (!submission.accepted) {
        break;
      }
    }

    const elapsedMs = Math.max(1, Date.now() - (deadline - clamp(Number(seconds) || 5, 1, 600) * 1000));
    return {
      profileId,
      blocksRequested: wanted,
      blocksMined: mined.length,
      hashes,
      elapsedMs,
      hashrateHps: round(hashes / (elapsedMs / 1000), 1),
      mined,
      tip: this._state().tip,
      height: this._state().height,
      difficultyBits: this._state().difficultyBits,
      wallet: this.walletView(profileId, { ledgerLimit: 6 }),
    };
  }

  /* ─────────────────────────── chain queries ──────────────────────────── */

  chain({ limit = 20, from = null } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const all = state.chain;
    const start = from ? Math.max(0, all.findIndex((b) => b.height === Number(from))) : Math.max(0, all.length - clamp(limit, 1, 200));
    return {
      height: state.height,
      tip: state.tip,
      tipAddress: state.chain[state.chain.length - 1]?.address || null,
      difficultyBits: state.difficultyBits,
      target: RealityMiners.targetDescription(state.difficultyBits),
      shareTarget: RealityMiners.targetDescription(Math.max(this.C.minDifficultyBits, state.difficultyBits - this.C.shareDifficultyOffset)),
      consensus: this.C,
      count: all.length,
      blocks: all.slice(start, start + clamp(limit, 1, 200)).reverse().map((b) => ({
        height: b.height,
        hash: b.hash,
        prevHash: b.prevHash,
        address: b.address,
        evmAddress: b.evmAddress,
        timestamp: b.timestamp,
        acceptedAt: b.acceptedAt,
        difficultyBits: b.difficultyBits,
        leadingZeroBits: b.leadingZeroBits,
        nonce: b.nonce,
        miner: b.miner,
        minedBy: b.minedBy || b.miner,
        workerId: b.workerId,
        solveMs: b.solveMs,
        workHashes: b.workHashes,
        subsidyRlu: b.subsidyRlu,
        totalRlu: b.totalRlu,
        isGenesis: b.isGenesis,
        reality: { count: b.reality?.count || 0, rlu: b.reality?.rlu || 0, rarest: b.reality?.rarest || null, kinds: (b.reality?.fragments || []).map((f) => f.kind) },
      })),
    };
  }

  getBlock(heightOrHash) {
    const state = this._state();
    this.ensureGenesis(state);
    const byHash = state.byHash[String(heightOrHash)];
    if (byHash) return byHash;
    const byHeight = state.chain.find((b) => b.height === Number(heightOrHash));
    if (!byHeight) throw toNotFound(`unknown block: ${heightOrHash}`);
    return byHeight;
  }

  /**
   * Full chain verification — the "run a node" operation. Re-checks every
   * link, every PoW, every timestamp ordering, and re-derives the reality for
   * a sample of blocks to prove content is reproducible from the hash alone.
   */
  verifyChain({ sampleReality = 8 } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const problems = [];
    let prevHash = '0'.repeat(64);
    let checkedReality = 0;

    for (let i = 0; i < state.chain.length; i += 1) {
      const block = state.chain[i];
      if (block.height !== i) problems.push({ height: i, code: 'height_mismatch', detail: `expected ${i}, got ${block.height}` });
      if (block.prevHash !== prevHash) problems.push({ height: i, code: 'broken_link', detail: `prevHash ${block.prevHash} ≠ ${prevHash}` });
      const recomputed = RealityMiners.headerHash(RealityMiners.headerOf(block));
      if (recomputed !== block.hash) problems.push({ height: i, code: 'hash_mismatch', detail: `stored ${block.hash.slice(0, 16)}… vs recomputed ${recomputed.slice(0, 16)}…` });
      if (!RealityMiners.meetsTarget(block.hash, block.difficultyBits)) problems.push({ height: i, code: 'insufficient_work', detail: `${block.leadingZeroBits} bits < ${block.difficultyBits}` });
      if (i > 0 && block.timestamp < state.chain[i - 1].timestamp - this.C.maxFutureTimeMs) problems.push({ height: i, code: 'time_reversal', detail: `${block.timestamp} before parent` });

      if (checkedReality < sampleReality && block.reality?.fragments?.length) {
        const rederived = realityFromBlock({ blockHash: block.hash, seed: this.seed, blockAddress: block.address, count: block.reality.count });
        const sameKinds = rederived.fragments.every((f, idx) => f.kind === block.reality.fragments[idx]?.kind && f.address === block.reality.fragments[idx]?.address);
        if (!sameKinds) problems.push({ height: i, code: 'reality_not_reproducible', detail: 're-derived fragments differ from stored ones' });
        checkedReality += 1;
      }
      prevHash = block.hash;
    }

    return {
      valid: problems.length === 0,
      height: state.height,
      blocks: state.chain.length,
      tip: state.tip,
      tipAddress: state.chain[state.chain.length - 1]?.address || null,
      difficultyBits: state.difficultyBits,
      realityRechecks: checkedReality,
      problems,
      verifiedAt: nowIso(),
    };
  }

  /* ───────────────────────── fragment accessors ───────────────────────── */

  /** Recent fragments across kinds (used by AR scan + missions + weave). */
  recentFragments({ limit = 24, kind = null } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const addresses = kind ? state.fragmentsByKind[kind] || [] : state.indexes.recent;
    return addresses
      .slice(0, clamp(limit, 1, 400))
      .map((addr) => state.fragments[addr])
      .filter(Boolean);
  }

  fragmentsByKind(kind, { limit = 40 } = {}) {
    return this.recentFragments({ limit, kind });
  }

  /** Look up one fragment by its entropy address. */
  getFragment(address) {
    const state = this._state();
    const fragment = state.fragments[address];
    if (!fragment) throw toNotFound(`unknown reality fragment: ${address}`);
    return fragment;
  }

  /** Content library grouped by kind, for the HUD "reality" tab. */
  library({ limitPerKind = 6 } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const kinds = Object.keys(state.fragmentsByKind);
    return {
      totalFragments: Object.keys(state.fragments).length,
      kinds: kinds.map((kind) => ({
        kind,
        count: (state.fragmentsByKind[kind] || []).length,
        samples: (state.fragmentsByKind[kind] || []).slice(0, clamp(limitPerKind, 1, 20)).map((addr) => state.fragments[addr]).filter(Boolean),
      })),
      rluEmitted: state.stats.rluEmitted,
      note: 'Every fragment is re-derivable from its source block hash — content, not currency.',
    };
  }

  /** On-demand fragment derivation (no mining required) — for previews/tests. */
  deriveFragment({ hash = null, index = 0, kind = null } = {}) {
    const digest = hash || hashHex('derive-fragment', this.seed, index, kind || 'any', Math.floor(Date.now() / 60000));
    return fragmentFromHash({ hash: digest, seed: this.seed, index, kind });
  }

  /* ────────────────────────────── pool views ──────────────────────────── */

  pool({ limit = 20 } = {}) {
    const state = this._state();
    this.ensureGenesis(state);
    const workers = Object.values(state.workers);
    const totalShares = workers.reduce((s, w) => s + w.shares, 0) || 1;
    const now = Date.now();
    return {
      address: deriveAddress({ domain: 'MIN', seed: this.seed, label: 'pool', sublabel: 'reality-pool' }).address,
      consensus: this.C,
      height: state.height,
      tip: state.tip,
      difficultyBits: state.difficultyBits,
      shareDifficultyBits: Math.max(this.C.minDifficultyBits, state.difficultyBits - this.C.shareDifficultyOffset),
      target: RealityMiners.targetDescription(state.difficultyBits),
      shareTarget: RealityMiners.targetDescription(Math.max(this.C.minDifficultyBits, state.difficultyBits - this.C.shareDifficultyOffset)),
      shares: state.pool.shares,
      blocksFound: state.pool.blocksFound,
      stale: state.stats.stale,
      orphaned: state.stats.orphaned,
      rejected: state.stats.rejected,
      totalHashrate: round(workers.reduce((s, w) => s + (w.hashrate || 0), 0), 1),
      workers: workers
        .map((w) => ({
          ...w,
          online: now - Date.parse(w.lastSeenAt) < 5 * 60_000,
          shareWeight: round(w.shares / totalShares, 4),
        }))
        .sort((a, b) => b.shares - a.shares)
        .slice(0, clamp(limit, 1, 100)),
      pendingShares: Object.entries(state.pool.pendingShares[state.tip] || {}).map(([profileId, shares]) => ({ profileId, shares, weight: round(shares / (Object.values(state.pool.pendingShares[state.tip] || {}).reduce((s, v) => s + v, 0) || 1), 4) })),
      recentPayouts: state.pool.payouts.slice(0, 10),
      lastRetarget: state.retargets[0] || null,
      retargetHistory: state.retargets.slice(0, 12),
      unit: { symbol: 'RLU', name: 'Reality Unit', monetary: false, note: 'content accounting, no market, no transfer off-network' },
    };
  }

  /**
   * Reverse index: resolve an EX-BLK / EX-RLT / EX-MIN address to the block,
   * fragment, wallet, worker, job or the pool itself.
   * @returns {{type:string, record:object}|null}
   */
  findByAddress(address) {
    if (!address) return null;
    const state = this._state();
    this.ensureGenesis(state);
    const block = state.chain.find((b) => b.address === address);
    if (block) return { type: 'block', record: { height: block.height, hash: block.hash, address: block.address, evmAddress: block.evmAddress, minedBy: block.minedBy || block.miner, isGenesis: block.isGenesis, totalRlu: block.totalRlu, reality: { count: block.reality?.count || 0, rarest: block.reality?.rarest || null } } };
    const fragment = Object.values(state.fragments).find((f) => f.address === address);
    if (fragment) return { type: 'fragment', record: fragment };
    const wallet = Object.values(state.wallets).find((w) => w.address === address);
    if (wallet) return { type: 'wallet', record: { profileId: wallet.profileId, address: wallet.address, rlu: wallet.rlu, lifetimeRlu: wallet.lifetimeRlu, blocksMined: wallet.blocksMined, fragments: wallet.fragmentAddresses.length, unit: 'RLU' } };
    const worker = Object.values(state.workers).find((w) => w.address === address);
    if (worker) return { type: 'worker', record: worker };
    const job = Object.values(state.jobs).find((j) => j.address === address);
    if (job) return { type: 'job', record: { jobId: job.jobId, address: job.address, height: job.headerTemplate?.height ?? null, expiresAt: job.expiresAt } };
    const poolAddress = deriveAddress({ domain: 'MIN', seed: this.seed, label: 'pool', sublabel: 'reality-pool' }).address;
    if (poolAddress === address) return { type: 'pool', record: { address: poolAddress, shares: state.pool.shares, blocksFound: state.pool.blocksFound, height: state.height } };
    return null;
  }

  stats(state = this._state()) {
    this.ensureGenesis(state);
    const solveTimes = state.stats.solveTimesMs.slice(-20);
    const medianSolve = solveTimes.length ? solveTimes.slice().sort((a, b) => a - b)[Math.floor(solveTimes.length / 2)] : null;
    const elapsedSec = state.stats.startedAt ? Math.max(1, (Date.now() - Date.parse(state.stats.startedAt)) / 1000) : 1;
    return {
      ...state.stats,
      height: state.height,
      tip: state.tip,
      difficultyBits: state.difficultyBits,
      target: RealityMiners.targetDescription(state.difficultyBits),
      medianSolveMs: medianSolve,
      targetBlockMs: this.C.targetBlockMs,
      averageHashrateHps: round(state.stats.hashes / elapsedSec, 1),
      fragments: Object.keys(state.fragments).length,
      wallets: Object.keys(state.wallets).length,
      workers: Object.keys(state.workers).length,
      retargets: state.retargets.length,
      rluOutstanding: round(Object.values(state.wallets).reduce((s, w) => s + w.rlu, 0), 2),
      consensus: this.C,
      solveTimesMs: solveTimes,
    };
  }
}

module.exports = { RealityMiners, CONSENSUS, LEDGER_KINDS };
