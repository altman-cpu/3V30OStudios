'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  VAULT  —  content-addressed persistence for every entropy domain
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Shape on disk (default root: ./data/entropy):
 *
 *      data/entropy/
 *        genesis.json          network identity + seed fingerprint (safe to commit)
 *        keyring.json          master key material   (NEVER committed)
 *        journal.jsonl         append-only event log (the audit spine)
 *        state/<domain>.json   last-known snapshot per domain
 *        cas/<sha256>.json     immutable content-addressed blobs
 *
 *  Why a journal *and* snapshots?
 *    • snapshots make reads O(1) and the API stateless between restarts;
 *    • the journal makes every mutation replayable and auditable — that is the
 *      "pro to understand" part: you can always answer *why* state looks like
 *      this, and rebuild it after a bad deploy.
 *
 *  Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt
 *  a domain snapshot.
 */

const fs = require('node:fs');
const path = require('node:path');
const { contentAddress, hashHex, nowIso, canonicalize } = require('./entropy-core');

const DOMAINS = Object.freeze([
  'memory',
  'weave',
  'ar',
  'squad',
  'missions',
  'multiplayer',
  'miners',
  'pending',
  'handlers',
]);

class Vault {
  /**
   * @param {object} opts
   * @param {string} opts.root        absolute or repo-relative root directory
   * @param {(event:object)=>void} [opts.onEvent]  live event tap (SSE bus)
   */
  constructor({ root, onEvent = null } = {}) {
    if (!root) throw new Error('Vault requires a root directory');
    this.root = path.resolve(root);
    this.stateDir = path.join(this.root, 'state');
    this.casDir = path.join(this.root, 'cas');
    this.journalPath = path.join(this.root, 'journal.jsonl');
    this.genesisPath = path.join(this.root, 'genesis.json');
    this.keyringPath = path.join(this.root, 'keyring.json');
    this.onEvent = onEvent;
    this.cache = new Map();
    this.stats = { reads: 0, writes: 0, journalEvents: 0, casObjects: 0 };
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.casDir, { recursive: true });
  }

  /* ─────────────────────────── domain snapshots ─────────────────────── */

  /** Read a domain snapshot, returning `fallback` when untouched. */
  read(domain, fallback = {}) {
    this.stats.reads += 1;
    if (this.cache.has(domain)) return this.cache.get(domain);
    const file = path.join(this.stateDir, `${domain}.json`);
    if (!fs.existsSync(file)) {
      this.cache.set(domain, fallback);
      return fallback;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.cache.set(domain, parsed);
      return parsed;
    } catch (err) {
      // Corrupt snapshot: keep the raw bytes for forensics, fall back safely.
      const quarantine = path.join(this.stateDir, `${domain}.corrupt-${Date.now()}.json`);
      try {
        fs.copyFileSync(file, quarantine);
      } catch {
        /* ignore */
      }
      this.cache.set(domain, fallback);
      return fallback;
    }
  }

  /**
   * Write a domain snapshot atomically and journal the mutation.
   * @param {string} domain
   * @param {object|((prev:object)=>object)} valueOrFn  next state, or a mutator
   * @param {object} [meta]  {actor, reason, handler, kind}
   * @returns {{domain:string, contentHash:string, bytes:number, at:string}}
   */
  write(domain, valueOrFn, meta = {}) {
    if (!DOMAINS.includes(domain) && !meta.allowUnknownDomain) {
      throw new Error(`unknown vault domain: ${domain}`);
    }
    const prev = this.read(domain, {});
    const next = typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn;
    const json = `${JSON.stringify(next, null, 2)}\n`;
    const file = path.join(this.stateDir, `${domain}.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;

    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file); // atomic on POSIX + Windows

    this.cache.set(domain, next);
    this.stats.writes += 1;

    const contentHash = contentAddress(next);
    this.journal({
      kind: meta.kind || 'state.write',
      domain,
      actor: meta.actor || 'system',
      handler: meta.handler || null,
      reason: meta.reason || null,
      contentHash,
      bytes: Buffer.byteLength(json),
      at: nowIso(),
    });
    return { domain, contentHash, bytes: Buffer.byteLength(json), at: nowIso() };
  }

  /** Convenience: mutate in place with a function and return the new state. */
  update(domain, fn, meta = {}) {
    this.write(domain, fn, meta);
    return this.read(domain);
  }

  /* ─────────────────────────── content-addressed store ───────────────── */

  /** Store an immutable blob, keyed by its canonical hash. Returns the key. */
  cas(object) {
    const key = contentAddress(object);
    const file = path.join(this.casDir, `${key}.json`);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(object, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      this.stats.casObjects += 1;
    }
    return key;
  }

  /** Retrieve a CAS blob (or null). */
  getCas(key) {
    if (!/^[0-9a-f]{64}$/.test(String(key || ''))) return null;
    const file = path.join(this.casDir, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /* ────────────────────────────── journal ────────────────────────────── */

  /** Append an event to the audit journal (JSON Lines). */
  journal(event) {
    const record = { ...event, at: event.at || nowIso(), seq: this.stats.journalEvents + 1 };
    fs.appendFileSync(this.journalPath, `${canonicalize(record)}\n`, 'utf8');
    this.stats.journalEvents += 1;
    if (this.onEvent) {
      try {
        this.onEvent({ type: 'vault.journal', payload: record });
      } catch {
        /* a broken subscriber must never break persistence */
      }
    }
    return record;
  }

  /** Read the tail of the journal (newest last). */
  tail(limit = 50) {
    if (!fs.existsSync(this.journalPath)) return [];
    const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(Math.max(0, lines.length - limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  }

  /* ────────────────────────────── genesis ────────────────────────────── */

  /** Read or initialise the genesis identity document. */
  genesis({ seed, alloy = null, meta = {} } = {}) {
    if (fs.existsSync(this.genesisPath)) {
      return JSON.parse(fs.readFileSync(this.genesisPath, 'utf8'));
    }
    if (!seed) throw new Error('genesis requires a seed on first run');
    const doc = {
      protocol: 'ENTROPY',
      version: '1.0.0',
      createdAt: nowIso(),
      genesisSeed: seed,
      seedFingerprint: hashHex('fingerprint', seed).slice(0, 32),
      entropyPhrase: meta.entropyPhrase || null,
      alloy,
      network: meta.network || 'local-genesis',
      domains: DOMAINS.slice(),
    };
    const tmp = `${this.genesisPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.genesisPath);
    this.journal({ kind: 'genesis.created', domain: 'genesis', seedFingerprint: doc.seedFingerprint });
    return doc;
  }

  /** Raw read/write for the master keyring file (0600 perms). */
  readKeyring() {
    if (!fs.existsSync(this.keyringPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.keyringPath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeKeyring(doc) {
    const tmp = `${this.keyringPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.keyringPath);
    try {
      fs.chmodSync(this.keyringPath, 0o600);
    } catch {
      /* best effort on non-POSIX */
    }
    return doc;
  }

  /* ────────────────────────────── housekeeping ───────────────────────── */

  /** Storage footprint, for the HUD status strip. */
  inspect() {
    const dirBytes = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .reduce((sum, e) => sum + fs.statSync(path.join(dir, e.name)).size, 0);
    };
    return {
      root: this.root,
      domains: DOMAINS.slice(),
      cached: [...this.cache.keys()],
      bytes: {
        state: dirBytes(this.stateDir),
        cas: dirBytes(this.casDir),
        journal: fs.existsSync(this.journalPath) ? fs.statSync(this.journalPath).size : 0,
      },
      stats: { ...this.stats },
    };
  }
}

module.exports = { Vault, DOMAINS };
