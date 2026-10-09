'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MINER WORKER  —  a nonce-search thread for the Reality Mining stack
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Workers ONLY search. They never touch the vault.
 *
 *  That split matters: the chain state is a single JSON snapshot written
 *  atomically by one process. If two threads both appended blocks they would
 *  clobber each other, exactly like two miners writing the same file. So the
 *  worker does the CPU-bound part (hashing nonces) and posts the winning nonce
 *  back; the main thread validates and submits it through the normal
 *  `submitWork()` path — one writer, many searchers. This is also precisely how
 *  a real stratum pool is shaped: miners search, the pool assembles.
 *
 *  Protocol (parentPort messages):
 *      → { type:'work', header, difficultyBits, startNonce, step, budgetMs }
 *      ← { type:'progress', hashes, nonce, ms }
 *      ← { type:'found', nonce, hash, hashes, ms }
 *      ← { type:'exhausted', hashes, ms }
 */

const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const { canonicalize } = require('../src/core/entropy-core');

/** sha256 over the canonical header — identical to RealityMiners.headerHash. */
function headerHash(header) {
  return crypto.createHash('sha256').update(canonicalize(header)).digest('hex');
}

/** Leading zero bits of a 64-hex digest. */
function leadingZeroBits(hex) {
  let bits = 0;
  for (let i = 0; i < hex.length; i += 1) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

function search({ header, difficultyBits, startNonce = 0, step = 1, budgetMs = 30_000, progressEvery = 250_000 }) {
  const deadline = Date.now() + budgetMs;
  const started = Date.now();
  const base = { ...header };
  let nonce = startNonce;
  let hashes = 0;

  while (Date.now() < deadline) {
    base.nonce = nonce;
    const hash = headerHash(base);
    hashes += 1;
    if (leadingZeroBits(hash) >= difficultyBits) {
      parentPort?.postMessage({ type: 'found', nonce, hash, hashes, ms: Date.now() - started, difficultyBits });
      return { found: true, nonce, hash, hashes };
    }
    if (hashes % progressEvery === 0) {
      parentPort?.postMessage({ type: 'progress', hashes, nonce, ms: Date.now() - started, difficultyBits });
    }
    nonce += step;
    if (nonce > Number.MAX_SAFE_INTEGER - step) nonce = startNonce;
  }
  parentPort?.postMessage({ type: 'exhausted', hashes, ms: Date.now() - started, difficultyBits });
  return { found: false, hashes };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg?.type === 'work') search(msg);
  });
  if (workerData?.type === 'work') search(workerData);
}

module.exports = { search, headerHash, leadingZeroBits };
