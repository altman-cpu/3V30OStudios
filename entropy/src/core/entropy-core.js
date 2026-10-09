'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY CORE  —  the deterministic heart of the Genesis Unmask stack
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Everything in this system is *derived*, never random-at-runtime:
 *
 *      genesisSeed ─┬─► entropy addresses   (EX-<DOMAIN>-<base58>)
 *                   ├─► key auth tokens     (smart-value bearing)
 *                   ├─► chromium alloys     (the bright UI material)
 *                   ├─► reality fragments   (what miners actually produce)
 *                   └─► missions / scans / companion tactics
 *
 *  Two design rules hold the whole codebase together:
 *
 *   1. SAME SEED ⇒ SAME UNIVERSE.  Any node can rebuild the same addresses,
 *      the same daily missions and the same block reality from the seed alone.
 *      That is what makes the API safe to cache, replicate and audit.
 *
 *   2. NOTHING IS TRUSTED BY STRING.  Every identifier is checksummed, every
 *      payload is content-addressed, every mutation is sealed (see keyring).
 *
 *  Dependencies: node:crypto only. No npm packages. Ever.
 */

const crypto = require('node:crypto');

const PROTOCOL = 'ENTROPY';
const PROTOCOL_VERSION = '1.0.0';

/* ── Base58 (Bitcoin alphabet) ─────────────────────────────────────────────
 * Chosen because it is human-transcribable: no 0/O, no I/l. Entropy addresses
 * are read aloud in lobbies and typed into companion terminals.             */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = (() => {
  const map = new Map();
  for (let i = 0; i < B58_ALPHABET.length; i += 1) map.set(B58_ALPHABET[i], i);
  return map;
})();

/**
 * Domain codes for entropy addresses. Every content handler owns one, so an
 * address is self-describing: you can look at `EX-SQD-…` and know it is a
 * squad companion record without a database lookup.
 */
const DOMAINS = Object.freeze({
  GEN: { code: 'GEN', label: 'Genesis', note: 'root seed / network identity' },
  KEY: { code: 'KEY', label: 'Keyring', note: 'auth token subject' },
  PND: { code: 'PND', label: 'Pending', note: 'unmask-pool seal' },
  HND: { code: 'HND', label: 'Handler', note: 'API content handler' },
  MEM: { code: 'MEM', label: 'Memory', note: 'Entropy Memory profile / trace' },
  WEA: { code: 'WEA', label: 'Weave', note: 'Power Weaving ability / fusion' },
  ARX: { code: 'ARX', label: 'AR', note: 'overlay layer / scan / anchor' },
  SQD: { code: 'SQD', label: 'Squad', note: 'AI companion / tactic model' },
  MSN: { code: 'MSN', label: 'Mission', note: 'mission / event / season' },
  LBY: { code: 'LBY', label: 'Lobby', note: 'lobby / party / raid' },
  MIN: { code: 'MIN', label: 'Miner', note: 'miner worker / pool share' },
  BLK: { code: 'BLK', label: 'Block', note: 'reality block' },
  RLT: { code: 'RLT', label: 'Reality', note: 'generated reality fragment' },
  ART: { code: 'ART', label: 'Artifact', note: 'mined artifact / loadout item' },
  CHR: { code: 'CHR', label: 'Chromium', note: 'Entropy Chromium alloy / theme' },
});

/* ───────────────────────────── hashing primitives ─────────────────────── */

/** Concatenate parts (string|Buffer|number) into a single Buffer. */
function toBufferPart(part) {
  if (Buffer.isBuffer(part)) return part;
  if (typeof part === 'number') return Buffer.from(String(part), 'utf8');
  if (part === null || part === undefined) return Buffer.alloc(0);
  return Buffer.from(String(part), 'utf8');
}

/** SHA-256 over a domain-separated concatenation of parts. */
function sha256(...parts) {
  const h = crypto.createHash('sha256');
  // Length-prefix each part so ("ab","c") can never collide with ("a","bc").
  for (const part of parts) {
    const buf = toBufferPart(part);
    h.update(Buffer.from([buf.length & 0xff, (buf.length >> 8) & 0xff]));
    h.update(buf);
  }
  return h.digest();
}

/** Hex digest helper. */
function hashHex(...parts) {
  return sha256(...parts).toString('hex');
}

/** HMAC-SHA256 (used for token signatures and chromium plating). */
function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8'));
  for (const part of parts) h.update(toBufferPart(part));
  return h.digest();
}

/**
 * Canonical JSON: keys sorted recursively, no whitespace, stable numbers.
 * Content addressing is only meaningful if serialisation is canonical.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/** Content address (CAS key) of any JSON-serialisable value. */
function contentAddress(value) {
  return hashHex('cas', PROTOCOL_VERSION, canonicalize(value));
}

/* ──────────────────────────────── base58 ─────────────────────────────── */

function base58Encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros += 1;

  const digits = [0];
  for (let i = zeros; i < buf.length; i += 1) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < zeros; i += 1) out += B58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58_ALPHABET[digits[i]];
  return out;
}

function base58Decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const value = B58_INDEX.get(ch);
    if (value === undefined) throw new Error(`invalid base58 character: ${ch}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === B58_ALPHABET[0]; i += 1) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

/* ─────────────────────── ENTROPY ADDRESSES (EAX) ───────────────────────
 *
 *  Layout:  EX-<DOMAIN>-<body>
 *  body   = base58( payload[20] || checksum[4] )
 *  payload = sha256("eax", version, genesisSeed, domain, label, sublabel)
 *  checksum = sha256("eax-checksum", version, domain, payload)[0..4]
 *
 *  A parallel EVM form (0x + 20 bytes) is emitted for every address so the
 *  existing Solidity contracts in /contracts can bind to entropy records
 *  without a translation table.
 * ─────────────────────────────────────────────────────────────────────── */

/**
 * Derive an entropy address.
 *
 * @param {object} opts
 * @param {string} opts.domain      one of DOMAINS keys (e.g. 'MEM')
 * @param {string} opts.seed        genesis / session seed
 * @param {string} opts.label       primary identity label (handler path, id…)
 * @param {string} [opts.sublabel]  secondary discriminator (version, epoch…)
 * @param {string} [opts.version]   address-format version
 * @returns {{address:string, evm:string, digest:string, domain:string, domainLabel:string, checksum:string}}
 */
function deriveAddress({ domain, seed, label, sublabel = '', version = PROTOCOL_VERSION }) {
  const dom = DOMAINS[domain] || DOMAINS.GEN;
  const payload = sha256('eax', version, seed, dom.code, String(label), String(sublabel)).subarray(0, 20);
  const checksum = sha256('eax-checksum', version, dom.code, payload).subarray(0, 4);
  const body = base58Encode(Buffer.concat([payload, checksum]));
  return Object.freeze({
    address: `EX-${dom.code}-${body}`,
    evm: `0x${payload.toString('hex')}`,
    digest: sha256('eax-full', version, seed, dom.code, String(label), String(sublabel)).toString('hex'),
    domain: dom.code,
    domainLabel: dom.label,
    checksum: checksum.toString('hex'),
  });
}

/** Validate + decode an entropy address. Returns null when malformed. */
function parseAddress(address) {
  if (typeof address !== 'string') return null;
  const match = /^EX-([A-Z]{3})-(.+)$/.exec(address.trim());
  if (!match) return null;
  const [, code, body] = match;
  const known = Object.values(DOMAINS).find((d) => d.code === code);
  if (!known) return null;
  let raw;
  try {
    raw = base58Decode(body);
  } catch {
    return null;
  }
  if (raw.length !== 24) return null;
  const payload = raw.subarray(0, 20);
  const checksum = raw.subarray(20);
  // Re-derive the checksum so an address is self-verifying: a single flipped
  // character fails here instead of resolving to somebody else's record.
  const expected = sha256('eax-checksum', PROTOCOL_VERSION, code, payload).subarray(0, 4);
  const checksumValid = expected.length === checksum.length && crypto.timingSafeEqual(expected, checksum);
  return Object.freeze({
    address,
    domain: code,
    domainLabel: known.label,
    payload: payload.toString('hex'),
    checksum: checksum.toString('hex'),
    expectedChecksum: expected.toString('hex'),
    evm: `0x${payload.toString('hex')}`,
    wellFormed: true,
    checksumValid,
    valid: checksumValid,
  });
}

/** True when the string is a structurally valid entropy address. */
/** True only for a well-formed address whose checksum verifies. */
function isAddress(address) {
  const parsed = parseAddress(address);
  return Boolean(parsed?.valid);
}

/* ─────────────────── deterministic pseudo-random generator ───────────────
 * xorshift128+ seeded from SHA-256. Small, fast, and reproducible across
 * machines — which matters because "random" here means *derived*, not *live*.
 */

/**
 * @param {string|Buffer} seed
 * @returns {{next:()=>number,float:()=>number,int:(n:number)=>number,pick:(a:any[])=>any,bytes:(n:number)=>Buffer,shuffle:(a:any[])=>any[],weighted:(entries:Array<[any,number]>)=>any,seed:string}}
 */
function createRng(seed) {
  const digest = sha256('rng', PROTOCOL_VERSION, seed);
  let s0 = digest.readBigUInt64BE(0);
  let s1 = digest.readBigUInt64BE(8) || 0x9e3779b97f4a7c15n;
  const MASK = 0xffffffffffffffffn;

  function nextBig() {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & MASK;
    x ^= x >> 17n;
    x ^= y;
    x ^= y >> 26n;
    s1 = x & MASK;
    return (s0 + s1) & MASK;
  }

  const api = {
    seed: typeof seed === 'string' ? seed : seed.toString('hex'),
    next() {
      return Number(nextBig() >> 11n) / Number(1n << 53n); // [0,1)
    },
    float(min = 0, max = 1) {
      return min + (max - min) * api.next();
    },
    int(n) {
      return Math.floor(api.next() * n);
    },
    range(min, max) {
      return min + api.int(max - min + 1);
    },
    pick(arr) {
      return arr[api.int(arr.length)];
    },
    chance(p) {
      return api.next() < p;
    },
    bytes(n) {
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) out[i] = Number(nextBig() & 0xffn);
      return out;
    },
    shuffle(arr) {
      const copy = arr.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = api.int(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    /** Pick from [[value, weight], …] using cumulative weights. */
    weighted(entries) {
      const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
      if (total <= 0) return entries[0]?.[0];
      let roll = api.next() * total;
      for (const [value, weight] of entries) {
        roll -= Math.max(0, weight);
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1][0];
    },
  };
  return api;
}

/* ─────────────────────────── time / epoch helpers ─────────────────────── */

const DAY_MS = 86_400_000;

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

/** UTC epoch day number — the seed basis for every daily mission set. */
function epochDay(date = new Date()) {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor(utc / DAY_MS);
}

/** ISO-ish week key: 2026-W41. */
function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Deterministic day/week seed strings. */
function dailySeed(genesisSeed, day = epochDay()) {
  return `${genesisSeed}|daily|${day}`;
}
function weeklySeed(genesisSeed, week = weekKey()) {
  return `${genesisSeed}|weekly|${week}`;
}
function seasonalSeed(genesisSeed, seasonId) {
  return `${genesisSeed}|season|${seasonId}`;
}

/* ─────────────────────────── formatting helpers ───────────────────────── */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Exponential-weighted moving average — used by companion tactic learning. */
function ewma(previous, sample, alpha = 0.25) {
  if (previous === null || previous === undefined || Number.isNaN(previous)) return sample;
  return alpha * sample + (1 - alpha) * previous;
}

/** base64url without padding (token segments). */
function b64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Human-scale numbers: 12.4k, 3.1M — used across the HUD. */
function compactNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${round(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `${round(n / 1e6, 2)}M`;
  if (abs >= 1e3) return `${round(n / 1e3, 1)}k`;
  return String(round(n, abs < 10 ? 2 : 0));
}

/** Short human phrase from entropy — used for readable ids and codenames. */
const CODENAME_A = ['Azure', 'Halcyon', 'Prism', 'Verge', 'Lumen', 'Cobalt', 'Aether', 'Quartz', 'Solace', 'Nova', 'Iridium', 'Vela'];
const CODENAME_B = ['Cascade', 'Meridian', 'Chorus', 'Bastion', 'Drift', 'Sigil', 'Lattice', 'Echo', 'Circuit', 'Bloom', 'Tessera', 'Halo'];

function codename(seed) {
  const rng = createRng(seed);
  return `${rng.pick(CODENAME_A)} ${rng.pick(CODENAME_B)}`;
}

/**
 * Entropy phrase — 6 human-readable words that fingerprint a seed.
 * Handy for support flows: "read me your entropy phrase".
 */
function entropyPhrase(seed, words = 6) {
  const rng = createRng(`phrase|${seed}`);
  const out = [];
  for (let i = 0; i < words; i += 1) {
    out.push(`${rng.pick(CODENAME_A)}-${rng.pick(CODENAME_B)}-${rng.range(10, 99)}`);
  }
  return out.join(' ');
}

/** Constant-time string compare (token / checksum verification). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  PROTOCOL,
  PROTOCOL_VERSION,
  DOMAINS,
  B58_ALPHABET,
  DAY_MS,
  // hashing
  sha256,
  hashHex,
  hmac,
  canonicalize,
  contentAddress,
  // addresses
  deriveAddress,
  parseAddress,
  isAddress,
  // rng
  createRng,
  // time
  nowIso,
  nowMs,
  epochDay,
  weekKey,
  dailySeed,
  weeklySeed,
  seasonalSeed,
  // utils
  clamp,
  round,
  ewma,
  b64url,
  unb64url,
  compactNumber,
  codename,
  entropyPhrase,
  safeEqual,
};
