# The Reality Mining Stack

**A complete proof-of-work stack that generates reality instead of currency.**

`src/systems/miners.js` · `src/core/reality-gen.js` · `bin/miner-worker.js`

Everything below is implemented, tested (`test/systems.test.js` → *miners: …*)
and reachable over HTTP. The design goal was stated plainly: *keep it simple,
but keep all the details there to understand it like a pro.* So every rule has a
number, every number has a reason, and every reason is written down.

---

## 0. The one-sentence version

Miners burn hashes to find a nonce that makes `sha256(header)` start with N zero
bits; the network accepts the block, and the reward is **deterministically
generated world content** — scenes, laws, conversation, terrain, artifacts,
glyphs, weather, memories — accounted in **RLU (Reality Units)**, which is
internal content accounting and *never* money.

```
work  →  block  →  reality fragments  →  abilities, venues, raids, lore, AR contacts
                        ↓
                  RLU ledger (spendable inside the platform only)
```

---

## 1. Why reality instead of a coin

| crypto-mining stack | this stack |
|---|---|
| reward = newly minted coins | reward = **content the world did not have before** |
| value is speculative, tradeable | RLU is `monetary: false`, `market: null`, not transferable off-network |
| halving schedule creates scarcity | **no halving** — content demand grows, it does not deflate |
| hashrate is the product | hashrate is the *cost*; the product is a reproducible world |
| a block is worth its fee | a block is worth what it **generates**: mission venues, raid terrain, companion banter, AR contacts, unlockable abilities |

The API says this out loud, so no integrator can misread it:

```jsonc
GET /v1/miners/wallet/{profileId}
{ "unit": { "symbol": "RLU", "name": "Reality Unit", "monetary": false,
            "transferableOffNetwork": false, "market": null,
            "note": "content accounting only" } }
```

Two consequences drive the whole design:

1. **Determinism is the point.** Reality must be reproducible from the block
   hash alone, so a client, a test and `verifyChain` can all regenerate it
   without trusting storage. That is why fragments come from
   `sha256(blockHash ‖ seed ‖ index)` and never from `Math.random()`.
2. **Work must be cheap enough to be a feature, not a cost centre.** Hence a
   leading-zero-bits difficulty of 8…24 (256 … 16.7 M expected hashes) with a
   4-second target — a laptop finds a block in milliseconds, and the retarget
   keeps it that way as more workers join.

---

## 2. Consensus parameters

```js
const CONSENSUS = Object.freeze({
  version: 1,
  minDifficultyBits: 8,        // ~256 hashes — floor, keeps tests instant
  maxDifficultyBits: 24,       // ~16.7M hashes — still laptop-feasible
  genesisDifficultyBits: 12,   // ~4096 hashes ≈ tens of ms in JS
  targetBlockMs: 4000,         // what the retarget aims for
  retargetInterval: 5,         // blocks between retargets (Bitcoin: 2016)
  retargetMaxFactor: 2,        // difficulty may at most double/halve per window
  shareDifficultyOffset: 4,    // share target = block target − 4 bits (16× easier)
  maxFutureTimeMs: 120_000,    // reject blocks from "the future"
  jobTtlMs: 45_000,            // long-poll work expires
  baseSubsidyRlu: 25,          // content subsidy per accepted block
  subsidyPerDifficultyBit: 3,  // more work ⇒ more content budget
  fragmentCapPerBlock: 6,      // hard cap on fragments per block
  payoutPrecision: 2,          // RLU decimals
});
```

Override per instance — this is exactly how the test suite runs a whole chain
lifecycle in milliseconds:

```js
createApp({ consensus: { genesisDifficultyBits: 9, retargetInterval: 3,
                         targetBlockMs: 60, shareDifficultyOffset: 3 } });
```

> **Tuning trap:** if `minDifficultyBits === genesisDifficultyBits`, the share
> target equals the block target and the share-only path becomes unreachable.
> Keep at least 2 bits of headroom (defaults give 4).

`GET /v1/miners/consensus` returns this table, the live targets, the unit card,
and an `explanation` block written for humans — a miner client should read it
rather than hard-code anything:

```jsonc
{ "explanation": {
    "header":     "version · prevHash · height · timestamp · seedRoot · difficultyBits · miner · nonce",
    "pow":        "sha256(canonical(header)) must have ≥ difficultyBits leading zero bits",
    "difficulty": "retarget every 5 blocks toward 4000 ms, using the window median, clamped to ×2/÷2, within 8–24 bits",
    "shares":     "pool share target = block target − 4 bits (16× easier)",
    "reward":     "subsidy 25 RLU + 3 RLU per difficulty bit + Σ fragment RLU",
    "coinbase":   "reality fragments (scene, law, voice, terrain, artifact, glyph, weather, memory) — not currency",
    "noHalving":  "there is deliberately no scarcity halving curve; content should get cheaper, not scarcer" } }
```

---

## 3. The block header

Only these fields are hashed. Everything else on a stored block is derived
metadata.

```js
header = {
  version:        1,                  // consensus version
  prevHash:       '<64-hex>',         // tip this block extends ('0'.repeat(64) for genesis)
  height:         3,                  // 0-based
  timestamp:      1791508635576,      // ms epoch, set by the miner
  seedRoot:       '<64-hex>',         // sha256('reality-seed', genesisSeed) — binds reality to THIS network
  difficultyBits: 12,                 // the target the miner claims to have met
  miner:          'wkr-…',            // worker id (consensus field!)
  nonce:          48213,              // the searched value
  note:           '…'                 // genesis block only
}

hash = sha256( canonicalize(header) )   // canonical JSON: sorted keys, no whitespace
```

```js
RealityMiners.headerHash(header)        // → 64-hex
RealityMiners.leadingZeroBits(hash)     // → integer bits
RealityMiners.meetsTarget(hash, bits)   // → boolean
RealityMiners.headerOf(block)           // → ONLY the consensus fields
RealityMiners.targetDescription(bits)   // → { difficultyBits, leadingZeros, expectedHashes, oneIn }
```

### The immutability rule (this is the one that bites)

`_acceptBlock` stores `{ ...header, hash, address, reality, subsidyRlu, totalRlu,
minedBy, workerId, jobId, acceptedAt }`. The spread comes **first** and nothing
after it may overwrite a consensus field. The beneficiary therefore lives in
`minedBy`, not `miner`:

```js
// ✅ correct — metadata in a new key
{ ...header, minedBy: beneficiary }

// ❌ wrong — silently invalidates every later verification
{ ...header, miner: beneficiary }
```

`verifyChain()` re-hashes `headerOf(block)`; a single overridden byte produces
`hash_mismatch` for that block and `broken_link` for the next one. Submit and
verify both go through `headerOf()`, so there is no second definition of the
header to drift.

### Difficulty as leading zero bits

```
leadingZeroBits('00f3…') = 8      two zero nibbles = 8 bits, then 0xf = 1111 adds 0
leadingZeroBits('000f…') = 12     three zero nibbles = 12 bits, then 0xf adds 0
expectedHashes(bits)     ≈ 2^bits
targetDescription(12)    = { difficultyBits:12, leadingZeros:3, expectedHashes:4096, oneIn:'1 in 4.10e+3' }
```

Bits are used instead of a 256-bit target integer because they are **logarithmic
and explainable**: "+1 bit = 2× the work", which makes the retarget a one-line
`Math.log2(factor)` and makes the HUD's difficulty readout human.

`leadingZeroBits` counts whole zero nibbles, then uses `Math.clz32(nibble) − 28`
for the partial nibble — exact, branch-light, no bigint.

---

## 4. Genesis

`ensureGenesis(state)` runs on first touch (any read or write). It builds the
height-0 block with `prevHash = '0'.repeat(64)`, `miner = 'genesis'`,
`seedRoot = sha256('reality-seed', seed)`, `difficultyBits = genesisDifficultyBits`,
searches a real nonce (`maxHashes: 5_000_000`), generates its reality, and
journals `miners.genesis`. The genesis block is **mined, not hard-coded** — so
the same seed always yields the same genesis hash, address and reality, on any
machine, with no trusted setup file.

Genesis reality is credited to `minedBy: 'genesis'` (not to a wallet) so the
network starts with content that belongs to nobody — the AR pool, mission venues
and raid terrain all draw from it.

```bash
curl -s "$URL/v1/miners/blocks/0" -H "Authorization: Bearer $ENTROPY_TOKEN"
node entropy/bin/entropy.js chain --limit 3
```

---

## 5. The work protocol (stratum-shaped)

Three calls, one loop. This is deliberately the shape of a real pool protocol so
an external miner can be written in any language:

```
POST /v1/miners/workers      register (workerId, profileId, label, pool)
GET  /v1/miners/work         long-poll a job  → { jobId, headerTemplate, blockTarget, shareTarget, expiresAt, rewardPreview }
POST /v1/miners/submit       { jobId, nonce, workerId, hashes }
```

`GET /v1/miners/work` returns:

```jsonc
{
  "jobId": "e9de19b25c49395c0d",
  "address": "EX-MIN-2PV68t78pbfTrhkbZKMKgUKJQ25PczHky",
  "workerId": "pw",
  "headerTemplate": { "version":1, "prevHash":"0078…", "height":3, "timestamp":1791508635761,
                      "seedRoot":"14bf…", "difficultyBits":8, "miner":"pw", "nonce":0 },
  "blockTarget": { "difficultyBits":8, "leadingZeros":2, "expectedHashes":256, "oneIn":"1 in 2.56e+2" },
  "shareTarget": { "difficultyBits":6, "leadingZeros":1, "expectedHashes":64,  "oneIn":"1 in 6.40e+1" },
  "issuedAt": "…", "expiresAt": "…",              // jobTtlMs = 45 s
  "prevHeight": 2, "prevHash": "0078…",
  "genesisAddress": "EX-BLK-…",
  "rewardPreview": { "subsidyRlu": 49, "expectedFragments": "1–4 (hash-derived)", "unit": "RLU (non-monetary)" },
  "note": "Search `nonce` until sha256(canonical(header)) has ≥ difficultyBits leading zero bits. Submit every nonce that meets the SHARE target; the pool assembles blocks."
}
```

Rules a miner must respect:

* **`nonce` is the only field you change.** Anything else invalidates the job's
  `prevHash`/`height` and the submission is stale.
* **Submit every nonce that meets the share target**, not just block solutions —
  that is how the pool measures your weight.
* **Jobs expire** (`jobTtlMs`) and **the tip moves**. On `job_expired` or
  `stale_tip`, re-poll `work` immediately; do not retry the same nonce.
* Report `hashes` honestly: it feeds hashrate, the HUD and pool stats.
* The job table is capped at 400 entries; expired jobs are simply re-issued.

### Submission outcomes

| `code` | HTTP-ish meaning | why |
|---|---|---|
| *(accepted, `block:true`)* | new block appended | met the **block** target |
| *(accepted, `share:true`)* | pool share credited | met the **share** target only |
| `below_share_target` | rejected | `leadingZeroBits < difficultyBits − shareDifficultyOffset` |
| `job_expired` | stale | `now ≥ job.expiresAt` |
| `stale_tip` | stale | `job.prevHash ≠ chain tip` — somebody else found the block |
| `duplicate_block` | orphaned | that hash is already in the chain |
| `unknown or expired job` (404) | — | bad `jobId` |
| `nonce must be a non-negative integer` (400) | — | malformed submission |

Stale and rejected submissions are **counted, journalled and attributed**
(`stats.stale`, `stats.rejected`, `worker.staleShares`) — a pool that hides
stales is a pool miners cannot trust.

```jsonc
POST /v1/miners/submit  { "jobId":"…", "nonce":0, "workerId":"w-1", "hashes":1 }
{ "accepted": false, "code": "below_share_target",
  "detail": { "hash":"07f7…", "leadingZeroBits":5, "shareTargetBits":5, "blockTargetBits":8 },
  "stats": { "rejected": 1, "shares": 2, "height": 2 } }
```

---

## 6. Shares, the pool and payouts

```
shareTargetBits = max(minDifficultyBits, difficultyBits − shareDifficultyOffset)   // 4 bits easier = 16× more frequent
```

Accepted shares accumulate in a bucket **keyed by the parent tip**:

```js
state.pool.pendingShares[job.prevHash][beneficiary] += 1
```

When a block lands, the bucket for the block's *parent* is paid out by weight and
then deleted:

```js
weight = shares / totalShares
amount = round(totalRlu × weight, 2)          // ledger kind 'share'
```

If the bucket is empty — a solo find, or a miner that solved without submitting
shares — the finder takes the whole reward (`ledger kind 'subsidy'`,
`payouts:[{ solo:true, weight:1 }]`).

Why key the bucket by parent hash? Because that is the only unambiguous
definition of "shares that contributed to *this* block". Keying by time or by
the current tip would let shares submitted after a block steal from it.

`GET /v1/miners/pool` returns the pool address, consensus, live targets, share
counts, per-worker `shareWeight` + `online` (seen in the last 5 minutes),
`pendingShares` for the current tip, the last 10 payouts, and the retarget
history.

```
subsidy  = baseSubsidyRlu + subsidyPerDifficultyBit · difficultyBits     (12 bits → 25 + 36 = 61 RLU)
totalRlu = subsidy + Σ fragment.rlu
```

**No halving.** Content demand grows with players, seasons and raids; a
deflationary schedule would starve exactly the moments the world needs new
reality. Difficulty, not subsidy, is the throttle.

Every credit and debit is a ledger entry with a kind from:

```
subsidy · fragment · share · spend · refund · mission · season · raid · adjustment
```

`spendReality` **fails closed** — it returns
`{ ok:false, code:'insufficient_rlu', detail:{ balance, required, shortfall } }`
rather than throwing, so a UI can show the shortfall instead of a 500.
`refundReality` is the inverse (fracture residue, failed seals).

---

## 7. Difficulty retarget

Every `retargetInterval` blocks (5 by default), on the **median** solve time of
the window:

```js
median = sort(windowBlocks.map(b => b.solveMs))[floor(n/2)]
factor = clamp(median / targetBlockMs, 1/retargetMaxFactor, retargetMaxFactor)   // ×0.5 … ×2
nextBits = clamp(round(currentBits + log2(factor)), minDifficultyBits, maxDifficultyBits)
```

Design notes a reviewer will ask about:

* **Median, not mean.** One 30-second outlier (a laptop sleeping, a GC pause)
  must not halve the network's difficulty. The median is robust to exactly the
  noise a JS process produces.
* **`log2` because bits are logarithmic.** A 2× time overrun ⇒ `+1` bit ⇒ 2×
  expected hashes. If difficulty were a linear target this line would be a
  multiplication and the clamp would need different maths.
* **Clamped ×2 / ÷2 per window** so no single window can runaway — the same
  guard Bitcoin applies per 2016 blocks.
* **`retargetInterval` is checked as `(height + 1) % interval === 0`**, i.e. the
  retarget applies to the *next* block, and the record is journalled + emitted
  (`miners.retarget`) with the full window so the HUD can draw it.
* Retarget history is kept (last 100 records) and exposed via
  `GET /v1/miners/pool` → `retargetHistory` / `lastRetarget`.

```js
// measured in test/systems.test.js:
// median 300 ms vs target 60 ms → factor clamped to 2 → +1 bit
// median  10 ms vs target 60 ms → factor clamped to 0.5 → −1 bit
```

---

## 8. Generated reality (`src/core/reality-gen.js`)

This is the reward. Given a block hash, the network's seed and an index, reality
is a pure function:

```js
fragmentFromHash({ hash, seed, index, kind = null, parent = null })
realityFromBlock({ blockHash, seed, blockAddress, count })
conversationFrom(...)      // dialogue turns from a fragment
briefFrom(...)             // raid brief prose
place(rng)                 // venue names
```

**RNG discipline:** `createRng('reality|' + seed + '|' + hash + '|' + index)` —
a seeded PRNG over a length-prefixed string. No `Date.now()`, no
`Math.random()`, no allocation order dependence. Same inputs ⇒ byte-identical
fragment. This is what `verifyChain({ sampleReality })` re-checks.

**Fragment kinds** (hash-derived unless forced):

| kind | what it becomes | tags |
|---|---|---|
| `scene` | a named place: biome, light, structure, material → mission venues, raid settings | `ar:map`, `mission:venue` |
| `law` | a world rule with a subject and a consequence → lore, sanction precedents | `lore`, `world:law` |
| `voice` | **conversation**: `title`, `text`, `speaker`, `mood` → companion banter, lobby lines | `squad:voice`, `conversation` |
| `terrain` | an 8×8 `heightfield`, `biome`, `hazard`, `cover` → AR map tiles and **raid difficulty** | `ar:map`, `raid:terrain` |
| `artifact` | `family`, `trait`, `stats{power,stability,weaveAffinity}` → **an unlockable ability** | `weave:ability`, `artifact` |
| `glyph` | a glyph with resonance → AR glyph layer contacts | `ar:glyph` |
| `weather` | atmosphere + intensity → the AR weather layer, world-event mood | `ar:weather` |
| `memory` | a recoverable trace (`memoryKind`, `recallCost`, `decayDays`) → Entropy Memory | `memory:trace` |

**Rarity ladder** (weighted, hash-rolled — a natural long tail):

| rarity | weight | RLU multiplier |
|---|---|---|
| `common` | 52 | ×1 |
| `refined` | 26 | ×1.8 |
| `iridescent` | 14 | ×3.4 |
| `plated` (Chromium-Plated) | 6 | ×6.5 |
| `unmasked` (Genesis Unmasked) | 2 | ×14 |

**Fragment value:**

```
resonance = round( rng.float(0.2, 1) · rarityMultiplier, 3 )
rlu       = round( resonance · 12, 2 )
address   = EX-RLT-…  from (seed, blockHash, `${index}:${kind}`)
```

**How many per block:** `3`, or `4` when the miner over-achieved
(`leadingZeroBits ≥ difficultyBits + 4`) — a lucky find literally yields more
world — capped by `fragmentCapPerBlock`.

**Artifacts become abilities.** `_acceptBlock` calls `weave.ingestBlock(block)`,
which turns every `artifact` fragment into a catalogued ability:

```js
abilityId = 'gen-' + sha256('weave-gen', sourceHash, index).slice(0,12)
school    = rng.pick(SCHOOL_IDS)                 // 8 schools
tier      = clamp(round(stats.weaveAffinity/2), 1, 5)
power     = clamp(stats.power ?? rng.range(12,40), 6, 90)
stability = clamp(stats.stability ?? rng.range(45,90), 10, 98)
costRlu   = clamp(round((stats.power ?? 20) · 0.9), 8, 200)
origin    = 'mined'      sourceFragment = fragment.address
```

Generation is **idempotent** (`created:false` on a repeat) and failures are
swallowed by design: weaving is an enhancement, never a consensus dependency.

**Terrain sets raid difficulty.** `multiplayer.createRaid` reads mined `terrain`
hazard, so the chain the party mined decides how hard their raid is:

```
difficulty = clamp(1.5 + min(4, season·0.18) + hazard·0.55 + roster·0.35, 1, 10)
```

Library endpoints: `GET /v1/miners/reality?kind=&limit=`,
`GET /v1/miners/fragments/{address}`, `POST /v1/miners/fragments/derive`
(derive without mining — for previews and tests), `miners.library()` (per-kind
counts + samples), `miners.recentFragments()`.

---

## 9. Verification

```js
miners.verifyChain({ limit = 500, sampleReality = 8 } = {})
```

Walks the stored chain and checks, in order:

| problem code | check |
|---|---|
| `height_mismatch` | `block.height` equals its index |
| `broken_link` | `block.prevHash` equals the previous block's hash |
| `hash_mismatch` | `headerHash(headerOf(block)) === block.hash` |
| `insufficient_work` | `leadingZeroBits(hash) ≥ block.difficultyBits` |
| `time_reversal` | `timestamp` more than `maxFutureTimeMs` **before** its parent's |
| `reality_not_reproducible` | re-derived fragments match the stored ones (sampled) |

Returns `{ valid, height, blocks, tip, tipAddress, difficultyBits,
realityRechecks, problems[], verifiedAt }`.

```bash
npm run entropy:verify
curl -s -X POST "$URL/v1/miners/verify" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"sampleReality":25}'
```

`test/systems.test.js` proves this is not decoration: it patches a stored block's
`difficultyBits` and asserts `valid:false` with `insufficient_work`, patches a
`reality` fragment text and asserts `reality_not_reproducible`, and asserts
`verifyChain` on a freshly-mined chain reports zero problems with
`realityRechecks > 0`.

---

## 10. Local and threaded mining

```js
miners.mineLocal({ profileId, seconds = 5, blocks = 1, workerId = null, onBlock, onProgress })
// → { blocksRequested, blocksMined, hashes, elapsedMs, hashrateHps, mined[], tip, height, difficultyBits, wallet }
```

Single-threaded: `_searchNonce(header, bits, { maxHashes, onProgress })` loops
`nonce++` until the target is met or the budget runs out, then submits through
the **same** `submitWork()` path a remote miner uses. There is no privileged
"internal" append — which is why the CLI demo and an HTTP miner produce
identical chain state.

Threaded mining is a CLI concern (`mine --threads N` →
`bin/miner-worker.js`):

```
main thread                          worker i of N
─────────────                        ─────────────
getWork() ─────────────────────────►  { type:'work', header, difficultyBits,
                                        startNonce: i, step: N, budgetMs }
                                      searches its disjoint nonce lane
                                      (i, i+N, i+2N …) — no overlap, no lock
             ◄──────────────────────  { type:'progress', hashes, nonce, ms }
             ◄──────────────────────  { type:'found', nonce, hash, hashes, ms }
first 'found' wins → terminate all → submitWork(jobId, nonce, hashes)
```

**Workers only search; they never touch the vault.** The chain is a single JSON
snapshot written atomically by one process. Two threads appending blocks would
clobber each other exactly like two miners writing one file. One writer, many
searchers — which is also precisely how a real pool is shaped.

Lanes are disjoint by construction (`startNonce: i, step: N`), so no work is
duplicated and no coordination is needed beyond "first reply wins".

```bash
npm run entropy:mine                                  # 5 s, 2 blocks
node entropy/bin/entropy.js mine --threads 4 --seconds 10 --blocks 3 --json
```

---

## 11. Writing an external miner (any language)

The whole protocol is three HTTP calls plus `sha256` over canonical JSON.

```python
import json, time, hashlib, requests

URL   = "http://localhost:8080"
TOKEN = "entk.v1.…"            # npm run entropy:token
H     = {"authorization": f"Bearer {TOKEN}", "content-type": "application/json"}

def canonical(obj):
    """Sorted keys, no whitespace — must match canonicalize() in entropy-core."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def leading_zero_bits(hex_digest: str) -> int:
    """Whole zero nibbles, then the partial nibble: 0xf → 0, 0x1 → 3, 0x8 → 0."""
    bits = 0
    for ch in hex_digest:
        nib = int(ch, 16)
        if nib == 0:
            bits += 4
            continue
        bits += 4 - nib.bit_length()
        break
    return bits

requests.post(f"{URL}/v1/miners/workers", headers=H,
              json={"workerId": "py-rig", "label": "python rig", "pool": True})

while True:
    job  = requests.get(f"{URL}/v1/miners/work?workerId=py-rig", headers=H).json()["data"]
    hdr  = job["headerTemplate"]
    bits = job["shareTarget"]["difficultyBits"]          # submit shares, not just blocks
    nonce, t0 = 0, time.time()

    while time.time() - t0 < 40:                          # stay inside jobTtlMs
        hdr["nonce"] = nonce
        h = hashlib.sha256(canonical(hdr).encode()).hexdigest()
        if leading_zero_bits(h) >= bits:
            r = requests.post(f"{URL}/v1/miners/submit", headers=H,
                              json={"jobId": job["jobId"], "nonce": nonce,
                                    "workerId": "py-rig", "hashes": nonce + 1}).json()["data"]
            print("block" if r.get("block") else "share", r.get("code", ""), r.get("totalRlu", ""))
            break
        nonce += 1
    else:
        continue                                            # job expired → re-poll
```

Notes for a production miner client:

* `ensure_ascii=False` matters if a header ever contains non-ASCII (genesis
  `note`); canonicalisation in `entropy-core` is UTF-8.
* Re-poll on `job_expired` / `stale_tip`; never resubmit the same nonce.
* Subscribe to `GET /v1/stream` and re-poll on `miners.block` — that is the
  stratum `mining.notify` equivalent, and it saves you from polling blind.
* `GET /v1/miners/consensus` tells you the current difficulty, targets and
  offsets: read it, do not hard-code.

---

## 12. Endpoints

| method | path | risk | notes |
|---|---|---|---|
| GET | `/v1/miners/consensus` | — | parameters, live targets, `explanation`, unit card (public) |
| GET | `/v1/miners/chain?limit=` | — | height, tip, difficulty, blocks (tip-first) |
| GET | `/v1/miners/blocks/{heightOrHash}` | — | one block with its reality |
| POST | `/v1/miners/verify` | — | `verifyChain` with a reality sample |
| GET | `/v1/miners/pool` | — | pool state, workers, payouts, retargets |
| POST | `/v1/miners/workers` | LOW | register a rig (pool or solo) |
| GET | `/v1/miners/work` | — | long-poll a job (scope `miner:work`) |
| POST | `/v1/miners/submit` | LOW | submit a nonce (share or block, scope `miner:work`) |
| POST | `/v1/miners/mine` | MEDIUM | server-side mining for demos/HUD |
| GET | `/v1/miners/wallet/{profileId}` | — | RLU, ledger, fragments, unit card |
| GET | `/v1/miners/reality` | — | mined content library |
| GET | `/v1/miners/fragments/{address}` | — | one fragment |
| POST | `/v1/miners/fragments/derive` | — | derive a fragment from a hash |
| GET | `/v1/miners/stats` | — | counters, hashrate, retarget state |

Events: `miners.genesis`, `miners.block`, `miners.share`, `miners.retarget`,
`miners.worker.registered` — on SSE and via `app.bus.on(type, fn)`.

---

## 13. Numbers from a real run

`npm run entropy:demo` on a fresh data directory (3 seconds of mining, default
12-bit genesis difficulty):

```
── 4 · mined reality ─────────────────────────────────────────────
  blocks     3/3
  hashes     4.4k
  hashrate   76.4k H/s
  wallet     437.11 RLU (lifetime 437.11)
  fragments  3, 3, 4                      ← the third block over-achieved
…
── 12 · chain verification ───────────────────────────────────────
  valid             true
  blocks            4                     ← genesis + 3
  reality rechecks  4
  problems          0
```

And the fan-out that makes it a *world* rather than a ledger:

```
block  →  artifact fragment  →  EX-WEA-… mined ability (unlockable, catalogued)
       →  terrain fragment   →  AR map tile + raid hazard → raid difficulty
       →  voice fragment     →  companion banter lines (mood, tactic, address)
       →  scene fragment     →  mission venue ("Bright Spire of Unmask Light")
       →  memory fragment    →  an Entropy Memory trace
       →  RLU                →  ability unlocks, mission claims, raid payouts
       →  trace              →  "Mined reality block 3 (12 zero bits, 117 RLU)…"
       →  mission progress   →  miner.block / miner.share objectives advance
```

---

## 14. Tuning guide

| you want | change | effect |
|---|---|---|
| faster blocks for a demo/test | `consensus.genesisDifficultyBits: 8…9`, `targetBlockMs: 60` | milliseconds per block; keep `shareDifficultyOffset ≥ 2` |
| a real persistent world | `targetBlockMs: 30_000…60_000`, `retargetInterval: 10…20` | stable cadence, retarget less twitchy |
| more content per block | `fragmentCapPerBlock` ↑ | richer worlds, bigger state files |
| a scarcer economy | `baseSubsidyRlu` / `subsidyPerDifficultyBit` ↓ | ability unlocks and mission rewards get relatively more valuable |
| more share traffic | `shareDifficultyOffset` ↑ (5…6) | finer pool statistics, more `/submit` calls |
| stricter time policy | `maxFutureTimeMs` ↓ | rejects clock-skewed miners sooner |
| longer job life | `jobTtlMs` ↑ | fewer `job_expired` on high-latency links |

Whatever you change: `verifyChain()` must still report `valid: true` for blocks
mined before the change, because consensus parameters are **not** part of the
header hash. If you need a hard fork, bump `CONSENSUS.version` and store it in
the header (`version` is already a consensus field).

---

## 15. Honest limitations

Stated plainly, because a pro reads the limitations section first:

* **Single-writer chain.** One process owns `state/miners.json`. There is no
  peer-to-peer gossip, no fork choice rule beyond "the tip we appended to", and
  no signature aggregation across nodes. `orphaned` counts duplicate hashes, not
  reorged branches — a true reorg would need a longest-work rule.
* **Timestamps are miner-declared**, bounded only by `maxFutureTimeMs` and the
  no-time-reversal check. There is no median-time-past window.
* **`solveMs` measures acceptance, not search.** It is the time the server spent
  validating and appending — which is what the retarget needs for a
  server-authoritative chain, but it is *not* the miner's wall-clock search time.
  For a distributed pool, retarget on submitted `hashes` ÷ hashrate instead.
* **Difficulty is bits, not a 256-bit target.** Coarser granularity (2× steps) in
  exchange for explainability. Fine at 8…24 bits; not what you would want at 70.
* **No sybil resistance.** Worker registration is free; a pool payout split is
  only as trustworthy as the token that submitted the shares.
* **RLU has no exchange rate, by design.** Anything that looks like a price is a
  bug in your integration, not a feature of this one.

---

*See also:* [`README.md`](../README.md) (whole stack) ·
[`INTEGRATIONS.md`](INTEGRATIONS.md) (client cookbook) ·
[`../../ENTROPY_GENESIS_UNMASK.md`](../../ENTROPY_GENESIS_UNMASK.md) (overview).
