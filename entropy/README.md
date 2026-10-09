# ENTROPY — Genesis Unmask stack

**API + HUD + reality miners for the 3V30OS / EV0LVERSE platform.**
Zero npm dependencies. Node 18+ (developed on Node 22). CommonJS on the server,
ESM + CJS in the SDK, plain browser JS in the HUD.

```
123 content handlers · 116 OpenAPI paths · 44 smart-value-gated writes
15 entropy address domains · 7 gameplay systems · 52 tests · 1 CLI · 1 HUD
```

Everything in this stack is **addressed, journalled and gated**:

* every record — profile, ability, fusion, scan, anchor, companion, mission,
  season, world event, lobby, party, raid, report, wallet, worker, job, block,
  reality fragment, chromium alloy, handler, seal, key — carries an
  entropy-generated address (`EX-<DOMAIN>-…`) plus a 20-byte EVM form;
* every mutation is written atomically and appended to an audit journal;
* every mutation that matters is gated by a **key auth token with a smart
  value**; if the offered value is below the risk gate, the effect is *parked*
  as a **pending seal** (HTTP 202) and only commits when enough authority
  co-signs it — a **genesis unmask**.

---

## 1. Sixty-second quickstart

```bash
# no install step — the stack has no dependencies
npm run entropy:demo        # guided end-to-end run (mine → weave → scan → raid → unmask)
npm run entropy:serve       # API on :8080, HUD on :8080/ui/
npm run entropy:test        # 52 tests, ~6 s
```

The boot banner prints a **bootstrap token** (tier `sovereign`, smart value
6956, 12 h TTL). Copy it:

```bash
export URL=http://localhost:8080
export ENTROPY_TOKEN='entk.v1.…'          # from the banner

curl -s $URL/v1/status -H "Authorization: Bearer $ENTROPY_TOKEN" | head -40
curl -s -X POST $URL/v1/miners/mine -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"seconds":3,"blocks":2}'
open $URL/ui/                              # the Entropy HUD
```

Or drive it from JavaScript:

```js
const { EntropyClient } = require('./entropy/src/sdk/client.js');

const client = new EntropyClient({ baseUrl: 'http://localhost:8080', subject: 'commander' });
await client.login({ tier: 'sovereign', scopes: ['entropy:read', 'memory:write', 'miner:work'] });
await client.bootstrapPlayer('commander', { alias: 'Commander Bleu', recruitCompanions: 2 });
await client.miners.mine({ seconds: 3, blocks: 2 });
```

State lives in `data/entropy/` (git-ignored): `genesis.json`, `keyring.json`
(mode `0600`), `journal.jsonl`, `state/*.json`, `cas/`. Delete the directory to
re-genesis; keep `ENTROPY_GENESIS_SEED` stable to keep every address stable.

---

## 2. Architecture

```
                         ┌──────────────────────────────────────────────┐
   browser / curl /      │              entropy/bin/entropy.js          │  CLI
   python / Solidity     │   serve · demo · mine · token · verify · …   │
        │                └───────────────────────┬──────────────────────┘
        │ HTTP + SSE                             │ in-process (same wiring)
        ▼                                        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ src/api/server.js  createApp() — boot order is the architecture           │
│                                                                           │
│  1 genesis seed   env ENTROPY_GENESIS_SEED → else generated once          │
│  2 Vault          atomic domain writes · CAS · journal · keyring 0600     │
│  3 EventBus       in-process listeners (on/off) + SSE ring buffer         │
│  4 Keyring        master key · entk.v1 tokens · smart value · Unmask Pool │
│  5 Chromium       generated alloy (colour/type/motion/AR HUD) + plating   │
│  6 Systems        memory · weave · ar · squad · missions · multiplayer ·  │
│                   miners        → then attach() cross-links them          │
│  7 Router         123 handlers; each derives its EX-HND-… address         │
│  8 HTTP server    middleware chain · static /ui · generated css+openapi    │
│  9 Timers         seal sweep 60 m · idle decay 15 m · consolidate 30 m ·  │
│                   world event 5 m                                         │
└───────────────────────────────────────────────────────────────────────────┘
        │                                     ▲
        ▼                                     │ cross-system attach (no cycles)
┌───────────────────────────────────────────────────────────────────────────┐
│ src/core/    entropy-core (hash, addresses, RNG, cadence)                 │
│              vault · keyring · http (bus, router, limiter, server)        │
│              chromium (alloy, contrast, CSS, plates) · reality-gen        │
└───────────────────────────────────────────────────────────────────────────┘
```

**Cross-links** are attached *after* construction, so no module has a circular
`require`:

| producer | consumers | effect |
|---|---|---|
| `miners` | weave, memory, missions | artifact fragments → generated abilities; block traces + lifetime RLU; `miner.block` / `miner.share` objectives |
| `weave` | memory, miners, missions | weave-hand xp + traces; RLU spend/refund; `weave.*` objectives |
| `memory` | squad, miners, missions, weave | every recorded match trains companions; `match.*` / `memory.recall` objectives |
| `squad` | memory, miners, missions | drills + quirks write traces; `squad.*` objectives |
| `missions` | miners, memory, squad, weave | RLU + season xp on claim; completion traces |
| `multiplayer` | squad, missions, miners, memory, ar | raids field each member's own companion, pay RLU + fragments, write memory |
| `ar` | miners, missions, multiplayer, squad, memory | scans surface mined reality, party presence, objectives |

Directory map:

```
entropy/
├── bin/entropy.js            CLI (boots the same app as the server)
├── bin/miner-worker.js       worker_threads nonce search (PoW off the main thread)
├── config/genesis.json       optional genesis/alloy/network config + JSON schema
├── openapi.snapshot.json     committed API contract (regenerate: npm run entropy:openapi)
├── src/core/                 entropy-core, vault, keyring, http, chromium, reality-gen
├── src/systems/              memory, weave, ar, squad, missions, multiplayer, miners
├── src/api/                  server.js (boot), routes.js (123 handlers), handlers.js
│                             (registry + unmask dispatch table)
├── src/ui/                   index.html, hud.css, hud.js (the bright premium HUD)
├── src/sdk/                  client.js (CJS) + client.mjs (ESM)
├── test/                     core · keyring · systems · api (node:test, 52 tests)
└── docs/                     MINING_STACK.md · INTEGRATIONS.md
```

---

## 3. Entropy-generated addresses

Every content handler and every record is addressed. One function, one format:

```
EX-<DOMAIN>-<base58check( payload20 ‖ checksum4 )>

payload  = sha256("eax", version, genesisSeed, domainCode, label, sublabel)[0:20]
checksum = sha256("eax-checksum", version, domainCode, payload)[0:4]
evm form = 0x<payload as 40 hex chars>        → binds to contracts/ (WalletID, EV0L721…)
digest   = sha256("eax-full", …)              → 32-byte full digest for indexing
```

* **Length-prefixed hashing**: each part is prefixed with its byte length, so
  `("ab","c")` can never collide with `("a","bc")`.
* **Domain separation**: the domain code is hashed in, so `MEM` and `WEA`
  addresses cannot collide even for identical labels.
* **Self-verifying**: `parseAddress()` re-derives the checksum; one flipped
  character fails `isAddress()` instead of resolving to somebody else's record.
* **Deterministic**: same genesis seed + label ⇒ same address forever. That is
  what makes mined reality reproducible from a block hash alone.

| code | domain | what it addresses |
|---|---|---|
| `GEN` | Genesis | network identity, genesis block |
| `KEY` | Keyring | token subjects, the root signing key |
| `PND` | Pending | parked seals (the Unmask Pool) |
| `HND` | Handler | **every content handler** (`handlerId` + `METHOD /path`) |
| `MEM` | Memory | profiles, traces, loadouts, skills, habits, signatures |
| `WEA` | Weave | abilities, holdings, fusions |
| `ARX` | AR | scans, anchors, layers, map tiles |
| `SQD` | Squad | companion archetypes + per-player instances |
| `MSN` | Mission | missions, seasons, world events |
| `LBY` | Lobby | lobbies, parties, raids, reports |
| `MIN` | Miner | wallets, workers, jobs, the pool |
| `BLK` | Block | chain blocks |
| `RLT` | Reality | mined fragments (scene/law/voice/terrain/artifact/glyph/weather/memory) |
| `ART` | Artifact | minted artifacts |
| `CHR` | Chromium | alloys and integrity plates |

Handler addresses derive from `(seed, handlerId, "METHOD /path")`, so the same
route on two networks has two addresses — and a renamed route gets a new one.

**Reverse index.** `GET /v1/addresses/{address}` decodes any address, verifies
its checksum and returns the record that owns it (`recordType` ∈ profile,
ability, fusion, companion, instance, mission, world-event, season, lobby,
party, raid, report, block, fragment, wallet, worker, job, pool, scan, anchor,
layer, handler, alloy, root-key, genesis). Every system implements
`findByAddress(address)` for this.

```bash
curl -s "$URL/v1/addresses/EX-HND-TnmbCuhmx4X8Q4suzruzCcqhCCD51h6H" \
     -H "Authorization: Bearer $ENTROPY_TOKEN"
# → { parsed:{domain:"HND", checksumValid:true}, recordType:"handler",
#     record:{ handler:"weave.fuse", method:"POST", risk:"HIGH", requiredSmartValue:900 } }
```

---

## 4. Key auth tokens with a smart value

Token wire format (compact, stateless, verifiable offline):

```
entk.v1.<base64url(claims JSON)>.<base64url(HMAC-SHA256(masterKey))>
```

Claims: `v, sub, addr (EX-KEY-…), scopes[], tier, root, iat, exp, jti, kid,
entropyCredits, pendingBudget, meta, sv, svLive`.

### The formula (documented so integrators can reason about it)

```
base = 120 · tierIndex · tierMultiplier      identity
     +  45 · |scopes ∩ opScopes|             fitness for THIS operation
     +   8 · pendingBudget                   how much may be parked
     +   3 · entropyCredits                  mined standing (RLU/4 + wins·6 + unmarks·4)
     + 250 · has(admin:root) + 400 · root    network authority

live = floor( base · (0.55 + 0.45 · freshness) )
freshness = clamp((exp − now) / (exp − iat), 0, 1)
```

Long-lived tokens lose authority on purpose: a leaked key decays to 55 % of its
base value without a revocation round-trip, and `kid` rotation rejects tokens
signed by a retired master key.

### Tiers

| tier | index | multiplier | intended use |
|---|---|---|---|
| `guest` | 0 | 0.35 | lobby spectator, read-only HUD |
| `observer` | 1 | 0.60 | read + scan |
| `operator` | 2 | 1.00 | standard player / integrator |
| `weaver` | 3 | 1.60 | power-weave authority |
| `architect` | 4 | 2.40 | missions, seasons, world events |
| `sovereign` | 5 | 3.60 | unmask + network control |

### Risk ladder (declared per handler)

| risk | required smart value | co-sign threshold | examples |
|---|---|---|---|
| `NONE` | 0 | — | reads, derived content |
| `LOW` | 180 | 1 | memory traces, loadouts |
| `MEDIUM` | 420 | 2 | anchors, lobbies, in-process mining |
| `HIGH` | 900 | 2 | fusions, raids, sanctions, unmask |
| `SEVERE` | 1600 | 2 | seasons, world events |
| `GENESIS` | 2600 | 3 | keyring, network config |

### Scopes

`entropy:read` · `memory:write` · `weave:write` · `ar:write` · `squad:write` ·
`mission:write` · `lobby:write` · `miner:work` · `unmask:seal` · `admin:root`

Verification order (each step returns a precise `code`):
`token_missing` → `token_malformed` → `token_signature` → `token_payload` →
`token_key_rotation` → `token_expired` → `token_scope` → **valid**.

```bash
npm run entropy:token                              # sovereign bootstrap token
curl -s -X POST $URL/v1/auth/token -H 'content-type: application/json' \
     -d '{"subject":"integration-a","tier":"operator","scopes":["entropy:read","memory:write"],"ttlSeconds":3600}'
```

In `ENTROPY_MODE=prod`, `POST /v1/auth/token` itself requires `admin:root`;
in `dev` it is open (and says so in the response `warning`).

---

## 5. The Unmask Pool — everything pending by code

A gated write either **seals** (applies now) or **parks** (becomes a seal).

```
POST /v1/weave/fuse            Authorization: Bearer <observer token>
HTTP/1.1 202 Accepted
{
  "ok": true,
  "data": {
    "status": "pending",
    "sealId": "9357488ca0b5040af53a",
    "sealAddress": "EX-PND-EShw8ZrDZ48wdBZQGuEV2RFbo5YfbsYY",
    "kind": "weave.fuse",
    "requiredSmartValue": 900,
    "offeredSmartValue": 170,
    "aggregateSmartValue": 170,
    "coSignRequired": 2,
    "coSignatures": [{ "subject": "scout", "smartValue": 170, "at": "…" }],
    "expiresAt": "2026-10-09T02:04:11.514Z",
    "nextSteps": [
      "POST /v1/pending/9357488ca0b5040af53a/cosign — add authority (needs 2 signature(s) and 900 aggregate smart value)",
      "POST /v1/pending/9357488ca0b5040af53a/unmask — resolve with a token whose smart value ≥ 900 and scope unmask:seal",
      "POST /v1/auth/token { subject, tier:\"architect\"|\"sovereign\" } — re-issue a stronger key auth token",
      "POST /v1/pending/9357488ca0b5040af53a/void — cancel the parked effect"
    ],
    "preview": { "name": "Circuit of Held Breath", "result": { "outcome": "stable", "stability": 91.4 } }
  },
  "meta": { "sealed": false, "risk": "HIGH", "handler": "weave.fuse", "entropyAddress": "EX-HND-…" }
}
```

A seal clears when **co-signatures ≥ coSignRequired** *and* **aggregate smart
value ≥ requiredSmartValue**, or when a `root` token holding `unmask:seal`
overrides. On clear, the parked payload is dispatched to the real system call
(`src/api/handlers.js` → `buildUnmaskDispatch`) and the journal records who
unmasked it, with what authority, and why.

Seal lifecycle: `pending → unmasked | voided | expired | failed`. Terminal
states are terminal — not even root may re-open a voided or failed seal, and an
applier that throws marks the seal `failed` without corrupting state.

**Caller control** (per request):

| header / query | effect |
|---|---|
| `x-entropy-pending: force` (or `?pending=force`) | park it even with sufficient authority — for review flows |
| `x-entropy-pending: never` (or `?pending=never`) | refuse instead of parking → HTTP 403 with `{offered, required, risk}` |
| *(absent)* | apply if authorised, else park (HTTP 202) |

Pool endpoints: `GET /v1/pending` (public list, filters `subject`/`status`),
`GET /v1/pending/stats` (public depth), `GET /v1/pending/{sealId}`,
`POST …/cosign`, `POST …/unmask`, `POST …/void`. A sweep runs every 60 minutes
and on every stats read.

---

## 6. Systems

### 6.1 Entropy Memory (`src/systems/memory.js`)

Remembers skills, loadouts, wins and companion behaviour.

* **Traces** — `{kind, text, tags[], resonance 0…4, decayDays, source, ref}`.
  Soft-delete (`forget`) redacts the text to `[redacted]` and keeps the fact of
  forgetting in the journal.
* **Recall scoring** (not a list — a ranked retrieval):

  ```
  score = 0.45·keywordOverlap + 0.25·e^(−ageDays/decayDays)
        + 0.20·resonance/4    + 0.10·min(accesses,20)/20
  ```

  Recalling increments `accesses`, so repeated recall keeps a trace alive
  (spacing effect). Results below `0.02` are dropped.
* **Consolidation** — decays resonance by strength, archives dead traces,
  promotes repeated kinds to **habits** and repeated tags to **skill xp**, then
  recomputes the profile **memory signature** (`EX-MEM-…` over the whole
  profile: a content hash of who you have become).
* **Skills** — 4 schools × skills; `xpForLevel(L) = floor(100·L^1.35)`.
* **Loadouts** — 5 slots (`core, offhand, visor, tether, sigil`), versioned,
  each with its own win/loss record, so "what did I win with?" is answerable.
* **Matches** — `recordMatch` updates the record, the loadout record, the skill
  tree, play-window and tactic-bias preferences, writes a trace, and delegates
  companion learning to Squad.
* **Portability** — `exportProfile` / `importProfile` (`ENTROPY-MEMORY` bundle,
  content-hashed). Import is idempotent by `(subject, signature)`: `noop`,
  `merged` (keep the higher of each durable number, union traces) or `created`.

### 6.2 Power Weaving (`src/systems/weave.js`)

Unlock and combine custom abilities. 8 schools (`kinetic, tidal, chromatic,
aegis, signal, memory, thermal, void`), 16 base abilities plus **mined**
abilities generated from artifact fragments.

```
pairBoost = Σ SYNERGY_MATRIX[schoolA][schoolB]                    (over all pairs)
power     = Σ powerᵢ·(1 + 0.1·levelᵢ/10) · (1 + pairBoost) · (1 + 0.18·(n−2))
stability = clamp( meanStability − 11·(n−2) − 26·incompatiblePairs
                   + 0.35·weaveHandLevel + resonanceBonus, 4, 100 )
```

| outcome | stability | effect |
|---|---|---|
| `STABLE` | ≥ 70 | reusable fusion, ×1 power |
| `VOLATILE` | ≥ 40 | ×0.85 power, loses 1 durability per use, dissolves into residue |
| `FRACTURE` | < 40 | no fusion; `residue += Σ costRlu × 0.45` |

`analyze()` is a **dry run** that returns the exact fusion the commit will
produce (same `fusionId`, name, address, outcome) — so a UI can preview a weave
before spending anything. `recipes` and `leaderboard` accumulate community
knowledge; `unweave` refunds `power·0.2 + 4·components` as residue.

### 6.3 AR overlay (`src/systems/ar.js`)

Scanning, missions and map layers with a privacy floor.

* **Layers**: `scan, mission, map, party, threat, glyph, weather` — each with
  its own address, tint and stroke weight taken from the chromium alloy.
* **Scan modes**: `sweep` (depth 3, 20 s cooldown), `deep` (6, 90 s),
  `mission` (4, 30 s), `recon` (5, 60 s). Contacts come from mined reality,
  live world events, party presence, mission objectives and anchors; a young
  chain still yields contacts via derived top-ups (`derived:true`).
* **Plating**: every scan payload is sealed with a chromium integrity plate
  (`chrp.v1.<grade>.<hash16>.<hmac16>`) so a client can prove the overlay it
  drew is the one the server issued.
* **Quantisation**: shared positions snap to 25 m cells
  (`{x,y,z,cell:25,precision:'coarse'}`); raw coordinates never leave the
  device, and presence sharing is **opt-in per lobby** (`consentShared:false`
  by default, with the consent text recorded when granted).
* **Map tiles**: `tile(z,x,y)` is a pure function of `z/x/y` + seed (biome,
  8×8 heightfield, hazard, cover, markers) — byte-identical between calls, so
  it is cacheable; only `generatedAt`/`platedAt` move.
* **Overlay SVG**: `GET /v1/ar/overlay.svg` returns a ready-to-composite HUD
  frame (reticle, contacts, legend) generated from the alloy — no token needed.

### 6.4 AI squad companions (`src/systems/squad.js`)

Companions that learn your preferred tactics over time.

* 6 roles (`vanguard, marksman, medic, scout, weaver, sentinel`) × 10 tactics
  (`flank-left, hold-gate, overwatch, burst-scan, shield-front, kite-back,
  focus-fire, revive-first, high-ground, split-push`); 13 seeded archetypes with
  unique names, inborn affinities, traits and voice.
* **Learning** (exponential moving average, α = 0.22):

  ```
  signal(win) = +1     signal(draw) = +0.25    signal(loss) = −0.45
  sample      = signal · (0.55 + 0.6·affinity)
  used tactic : weight ← ewma(weight, sample, α)
  unused      : weight ← ewma(weight, affinity·0.15, α·0.25)   (keeps a personality)
  bond        : +3.5 win · +0.6 draw · −1.1 loss · +1.2 raid clear
  confidence  = matches / 20
  ```

* **Quirks** — 9 rules; one surfaces at ≥ 5 matches when the top weight leads
  the runner-up by > 0.25 (e.g. *Gatebound*, *Revive Instinct*, *Sky Reader*).
* **Drills** — explicit teaching, faster than match play; drilling against a
  companion's inborn affinity costs bond (a real trade-off).
* **Idle decay** — 0.35 bond/day away, applied by a timer and by
  `decayIdle({now})`.
* **Recommendation** — `score = 0.45·roleCoverage + 0.35·learnedAlignment +
  0.20·bond`, with the missing roles named so the UI can suggest recruits.
* **Briefing + banter** — prose generated from the model (aggregate tactic bias
  vs. your own), and per-companion lines with mood, tactic and address.

### 6.5 Missions, world events, seasons (`src/systems/missions.js`)

* **Cadence boards** are generated, not stored: `daily` (4) from
  `dailySeed(seed, epochDay)`, `weekly` (3) from `weeklySeed(seed, ISO week)`,
  `seasonal` (2). Same day ⇒ same board ⇒ same mission addresses.
* **7 archetypes**, **19 objective events** (`match.win, match.play,
  match.raid.win, scan.run, scan.deep, scan.rare, weave.unlock, weave.fuse,
  weave.stable, squad.recruit, squad.drill, squad.quirk, miner.block,
  miner.share, unmask.seal, lobby.join, party.form, memory.recall, ar.anchor`).
  Progress only moves through `observe()`, which every system already calls —
  so **accept first, play second**.
* **Claim** pays `rewardRlu × eventMultiplier` into the RLU ledger, adds season
  xp, writes a memory trace and a skill use.
* **Seasons** — 28-day seasons from `2026-06-01T00:00:00Z`; 7 tiers
  (`Unmasked 0 · Plated 400 · Woven 1100 · Tide-Bound 2200 · Chorus 3800 ·
  Architect 6000 · Genesis 9000`), each with an RLU reward and a claimable seal.
* **World events** — 7 kinds (`chromium-rain, tidal-surge, weave-bloom,
  quiet-accord, unmask-vigil, signal-chorus, memory-tide`), 1–3 scheduled per
  day plus manually triggered ones (SEVERE risk). Each carries a modifier
  (`rluMultiplier`, `xpMultiplier`, `stabilityBonus`, …) that the payout and
  weave paths actually read.

### 6.6 Safe multiplayer (`src/systems/multiplayer.js`)

Lobbies, parties and co-op raids with safety as a first-class number.

```
safetyScore = 34 base
            + privacy   (invite 22 · party-code 14 · public 0)
            + 8         proximity voice off
            + 4/filter  up to 20 (profanity, harassment, pii, hate,
                                 spam-links, doxxing, minors-safety)
            + 10 host moderation  + 8 reporting  + 6 safe exit
            + 6 age band declared + 8 verified host + 6 lobby ≤ 8 members
```

`safetyBreakdown()` returns only the contributing items, so a lobby card can
show *why* it scored 100. Defaults are locked down because defaults are policy.

* **Gates, cheapest and least-revealing first**: ban list → your safety floor →
  invite-only membership → spectator policy → capacity. Discovery
  (`findLobbies`) never surfaces invite-only lobbies.
* **Presence** is quantised and consent-gated; `heartbeat` + `presence` expose
  only cell positions and aliases.
* **Reports** park a HIGH-risk `multiplayer.sanction` seal — moderation is
  authority-gated, never instant, never silent. `applySanction` runs only after
  an unmask, and bans are recorded.
* **safeExit** is the panic path: leaves every lobby, dissolves empty parties,
  revokes consent, clears presence.
* **Raids** — 7 weighted phases (`assemble .6 · brief .8 · approach 1.0 ·
  breach 1.35 · hold 1.2 · unmask 1.5 · resolve .4`):

  ```
  capability = rosterSize · mean(best member score) · (1 + 0.1·roleCoverage)
             + 0.05 · Σ bond / 100
  pressure   = difficulty · phaseWeight · (1 + 0.05·max(0, roster − 3))
  successP   = clamp(0.5 + (capability·3 − pressure)/6, 0.05, 0.95)
  member score = 0.45·roleCoverage + 0.35·learnedAlignment + 0.20·bond
                 (untrained floor 0.42)
  cleared ⇔ performance ≥ 0.5 AND costlyPhases < 3     performance = cleared/totalPhases
  difficulty = clamp(1.5 + min(4, season·0.18) + hazard·0.55 + roster·0.35, 1, 10)
  ```

  Every member fields **their own** trained companion — a raid cannot be
  carried by one player's bench. Difficulty reads the season *and* mined
  terrain hazard, so the reality chain literally sets raid difficulty. Payouts
  are RLU + fragments split per member, plus xp, memory traces and a companion
  learning pass (including `revive-first` on a down).

### 6.7 Reality miners (`src/systems/miners.js`)

A complete proof-of-work stack whose reward is **generated world content**
instead of a coin. See **[`docs/MINING_STACK.md`](docs/MINING_STACK.md)** for
the full pro-level walkthrough (header hashing, difficulty, retarget, shares,
pool split, stale/orphan taxonomy, reality generation, verification, tuning).

```
unit            RLU — Reality Unit. Internal content accounting. Not money,
                no market, not transferable off-network (the API says so).
hash            sha256(canonicalJson(header))   header = version, prevHash,
                height, timestamp, seedRoot, difficultyBits, miner, nonce
difficulty      leading zero bits, 8…24 (genesis 12); expected hashes ≈ 2^bits
retarget        every 5 blocks on the window MEDIAN solve time, toward 4000 ms,
                clamped to ×2 / ÷2 (bits are logarithmic: 2× overrun ≈ +1 bit)
shares          share target = block target − 4 bits (16× easier), job TTL 45 s
reward          25 + 3·difficultyBits RLU subsidy + Σ fragment RLU; no halving
reality         1–4 fragments per block, hash-derived: scene, law, voice,
                terrain, artifact, glyph, weather, memory
```

---

## 7. Entropy Chromium

Generated design system: the theme is *derived from the genesis seed*, not
hand-written, and it is provably accessible.

* **Surfaces**: `bright` (default premium daylight, `color-scheme: light`),
  `dusk` (night ops, low-blue), `scan` (AR passthrough, max legibility).
* **Grades**: `Cr-2` matte → `Cr-3` brushed → `Cr-5` polished → `Cr-6` mirror →
  `Cr-7` iridescent architectural → `Cr-9` genesis unmask plate. Each grade maps
  to a tier and carries `iridescence` + `gloss`.
* **Alloy** = colours (bg, panel, ink, muted, line, accent, semantic states),
  material (gloss, blur, elevation, border radius), type scale, motion curve and
  an `arHud` block (reticle, scanline, per-layer tints, max contacts), plus a
  **contrast report**: `{inkOnPanel, accentOnPanel, aa, aaa}` computed with the
  WCAG relative-luminance formula. `bright/Cr-7` clears AAA (≥ 7:1) for ink.
* **`toCss(alloy)`** emits the whole theme as CSS custom properties — served
  live at `/ui/chromium.css` and `/v1/chromium/css?surface=&grade=` (never a
  stale file on disk). `POST /v1/chromium/derive-address` derives any address.
* **Plates**: `plate(payload)` → `chrp.v1.<grade>.<hash16>.<hmac16>`;
  `verifyPlate(plate, payload)` re-checks both the payload hash and the HMAC, so
  a client can prove an overlay, scan or tile is authentic and unmodified.

The HUD (`src/ui/`) consumes the alloy: light, high-contrast panels, a
crystalline accent ramp, tabbed consoles (overview · memory · weave · AR ·
squad · missions · multiplayer · mining · pending · handlers), live SSE updates
and generated AR overlays.

---

## 8. HTTP surface

### Envelope (every JSON response)

```jsonc
{
  "ok": true,
  "data": { /* … */ },
  "meta": {
    "requestId": "89500f…",
    "handler": "weave.fuse",
    "title": "Weave a fusion",
    "entropyAddress": "EX-HND-TnmbCuhmx4X8Q4suzruzCcqhCCD51h6H",
    "handlerEvmAddress": "0x…",
    "domain": "weave",
    "risk": "HIGH",
    "sealed": true,                 // false ⇔ the effect was parked (202)
    "smartValue": 6956,
    "subject": "commander",
    "tier": "sovereign",
    "tookMs": 3.41,
    "at": "2026-10-09T01:35:12.004Z"
  }
}
```

Errors are JSON too, never HTML:

```jsonc
{ "ok": false,
  "error": { "code": "token_scope", "message": "missing scope(s): unmask:seal",
             "detail": { "subject": "scout", "tier": "observer", "scopes": ["entropy:read"] } },
  "meta": { "requestId": "…", "handler": "pending.unmask", "entropyAddress": "EX-HND-…" } }
```

| status | when |
|---|---|
| 200 | read, or a write that sealed |
| 201 | a create that declares `created: true` |
| **202** | the write was **parked** as a pending seal |
| 400 | bad request / validation (`bad_request`) |
| 401 | `token_missing`, `token_malformed`, `token_signature`, `token_expired` |
| 403 | `token_scope`, insufficient smart value with `pending: never`, safety gates |
| 404 | `not_found`, `route_not_found` (with a hint) |
| 405 | `method_not_allowed` (the path exists, the verb does not) |
| 409 | `conflict`, `seal_closed`, `seal_already_unmasked` |
| 429 | `rate_limited` + `retry-after` (token bucket per subject; reads cost 1, writes 2) |
| 500 | unexpected; logged with the request id, never leaked to the client |

Response headers always include `x-request-id`, `x-entropy-protocol`,
CORS (`access-control-allow-origin`, `…-headers` including `x-entropy-pending`),
`x-content-type-options: nosniff` and `referrer-policy: no-referrer`.

### Token sources (any one)

`Authorization: Bearer entk.v1.…` · `x-entropy-token: entk.v1.…` ·
`?token=entk.v1.…` (for `<img>`/`EventSource` that cannot set headers).

### Live events — `GET /v1/stream` (SSE)

```
event: hello
data: {"ok":true,"requestId":"…","protocol":"ENTROPY/1.0.0"}

event: miners.block
data: {"id":"…","type":"miners.block","payload":{"height":4,"hash":"00…","address":"EX-BLK-…","rlu":117.05,"realityCount":3,"retarget":null},"at":"…"}
```

Event families: `miners.{genesis,block,share,retarget,worker.registered}`,
`weave.{fused,fracture,unwoven,ability.generated}`, `memory.{profile,trace,
forget,consolidated,match}`, `ar.{scan,anchor}`, `squad.*`,
`missions.{accepted,ready,completed,event,worldEvent}`,
`multiplayer.{lobby.*,party.*,raid.*,report,sanction,safeExit}`,
`pending.{parked,cosigned,unmasked,voided,failed}`, `chromium.alloy.changed`,
`system.listening`, `http.response`.

In-process integrations can skip HTTP entirely:

```js
const off = app.bus.on('miners.block', (record) => index(record.payload));
const offAll = app.bus.on('*', (record) => audit(record));   // firehose
off();                                                        // never leaks a hook
```

### Discovery

| endpoint | what you get |
|---|---|
| `GET /v1` | protocol card: seed fingerprint, addresses, quickstart |
| `GET /v1/health` | liveness, chain vitals, pool depth, vault bytes, RSS |
| `GET /v1/status` | every system's counters + season + live world events |
| `GET /v1/handlers[?group=]` | **all 123 handlers** with address, EVM form, method, path, risk, `requiredSmartValue`, scopes, `pendingCapable` |
| `GET /v1/handlers/{handlerId}` | one handler in full |
| `GET /v1/openapi.json` | OpenAPI 3.1 with `x-entropy-address`, `x-risk`, `x-required-smart-value`, `x-scopes` per operation |
| `GET /v1/addresses/{address}` | reverse index (see §3) |
| `GET /v1/journal?limit=` | audit journal tail |
| `GET /v1/auth/catalog` | tiers, scopes, risk ladder, smart-value formula |
| `GET /ui/` | the HUD |

`entropy/openapi.snapshot.json` is a committed copy of the contract; regenerate
with `npm run entropy:openapi`.

---

## 9. Persistence (`src/core/vault.js`)

```
data/entropy/
├── genesis.json      protocol, version, createdAt, seedFingerprint, entropyPhrase,
│                     alloy, network, domains          ← the seed itself is NOT stored
├── keyring.json      keyId + (dev only) master key, mode 0600, chmod enforced
├── journal.jsonl     append-only audit: one canonical JSON record per mutation
├── state/*.json      one snapshot per domain, written atomically (tmp → rename)
└── cas/              content-addressed blobs (contentHash → payload)
```

* Domains: `memory, weave, ar, squad, missions, multiplayer, miners, pending,
  handlers, chromium` (unknown domains are rejected unless explicitly allowed).
* `write(domain, value|fn, meta)` → temp file + `rename` (atomic on POSIX and
  Windows) → cache update → journal record `{kind, domain, actor, handler,
  reason, contentHash, bytes, at, seq}` → event-bus tap.
* `cas(object)` / `getCas(hash)` for content-addressed storage;
  `tail(limit)` for the journal; `inspect()` for the HUD's storage strip.
* A broken event subscriber can never break persistence (the tap is wrapped).
* The master key comes from `ENTROPY_MASTER_KEY` in production. With no env key,
  a 32-byte key is generated once, stored `0600`, and the file carries a warning
  that says exactly that.

---

## 10. CLI

```
node entropy/bin/entropy.js <command> [options]      (npm run entropy:*)
```

| command | purpose | flags |
|---|---|---|
| `serve` | API + HUD | `--port --host --surface --grade` |
| `demo` | guided end-to-end run | `--profile --seconds` |
| `status` | network status card | `--json` |
| `seed` | genesis identity + entropy phrase | |
| `token` | issue a key auth token | `--subject --tier --scopes --ttl --json` |
| `verify` | verify the whole reality chain | `--sample` |
| `chain` | print blocks | `--limit --json` |
| `mine` | mine reality | `--profile --seconds --blocks --threads --json` |
| `reality` | mined content library | `--kind --limit` |
| `wallet` | RLU balance + ledger | `--profile` |
| `memory` | profile summary | `--profile --json` |
| `remember` / `recall` | write / query memory | `--profile --kind --text --tags` · `--query --limit` |
| `weave` | catalog / unlock / analyze / fuse | `--profile --abilities --action` |
| `missions` | today's board | `--profile --cadence --json` |
| `scan` | run an AR scan | `--profile --mode --layers` |
| `squad` | roster / recruit / drill / banter / recommend / briefing | `--profile --action --companion --tactic` |
| `lobby` | list / create / join / raid | `--profile --action --mode --name` |
| `pending` | list / stats / cosign / unmask / void | `--action --seal` |
| `handlers` | content handler addresses | `--group --json` |
| `addresses` | derive / inspect an address | `--domain --label --sublabel` |
| `css` | emit generated chromium CSS | `--surface --grade --out` |
| `openapi` | emit the OpenAPI document | `--out` |
| `events` / `journal` | live world events / audit tail | `--limit` |

Globals: `--data <dir>` · `--seed <seed>` · `--json` · `--help`.
`mine --threads N` runs the nonce search in `worker_threads`
(`bin/miner-worker.js`); workers only search and post nonces — the main thread
stays the single vault writer.

---

## 11. Configuration

| variable | default | meaning |
|---|---|---|
| `ENTROPY_MASTER_KEY` | generated (0600) | HMAC key for `entk.v1` tokens |
| `ENTROPY_GENESIS_SEED` | generated once | identity of the network → every address |
| `ENTROPY_DATA_DIR` | `./data/entropy` | canonical state |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP binding (HUD at `/ui/`) |
| `ENTROPY_MODE` | `dev` | `prod` closes open token issuance |
| `ENTROPY_SURFACE` / `ENTROPY_CHROMIUM_GRADE` | `bright` / `Cr-7` | generated theme |
| `ENTROPY_NETWORK` | `local-genesis` | label in the genesis document |
| `ENTROPY_RATE_CAPACITY` / `ENTROPY_RATE_REFILL` | `400` / `60` | token bucket |
| `ENTROPY_PENDING_TTL_MINUTES` | `30` | seal lifetime |
| `ENTROPY_BASE_URL` / `ENTROPY_CORS_ORIGIN` | derived / `*` | OpenAPI servers, CORS |

`entropy/config/genesis.json` (optional, validated by `genesis.schema.json`) can
pin the seed, network, alloy surface/grade and label for a deployment.

---

## 12. Tests

```bash
npm run entropy:test          # node --test entropy/test/*.test.js  → 52 tests
node --test entropy/test/core.test.js       # addressing, RNG, vault, chromium, reality-gen
node --test entropy/test/keyring.test.js    # tokens, smart value, the Unmask Pool
node --test entropy/test/systems.test.js    # all seven systems on a FAST consensus profile
node --test entropy/test/api.test.js        # real sockets: envelope, 202 gate, SSE, SDK
```

`systems.test.js` and `api.test.js` boot the whole app with a **fast consensus
override** (`createApp({ consensus: { genesisDifficultyBits: 9, retargetInterval:
3, targetBlockMs: 60, … } })`) so a full chain lifecycle costs milliseconds.
The miners tests search nonces with an *independent* implementation, so the PoW
is verified from outside the code that produces it, and they tamper with stored
blocks to prove `verifyChain` notices.

---

## 13. Extending the stack

**Add a content handler (5 steps).**

1. Pick a group + `handlerId` (`domain.noun.verb`) in `src/api/routes.js`.
2. Declare metadata: `title`, `summary`, `scopes`, `risk`, `body`/`query` JSON
   schema, `example`. The address, OpenAPI operation and registry entry are
   generated from this — nothing to register by hand.
3. Write the handler. Reads return data; writes go through the gate:

   ```js
   router.post('/v1/weave/reforge', {
     handler: 'weave.reforge', group: 'weave', domain: 'weave',
     title: 'Reforge a fusion', summary: '…',
     scopes: ['weave:write'], risk: 'HIGH',
     body: { type: 'object', properties: { fusionId: { type: 'string' } }, required: ['fusionId'] },
   }, (ctx) => gated(ctx, {
     risk: 'HIGH',
     kind: 'weave.reforge',                                  // ← dispatch key
     payload: { profileId: resolveProfile(ctx.subject), fusionId: ctx.body.fusionId },
     apply: () => weave.reforge(profileId, ctx.body.fusionId, { actor: ctx.subject }),
   }));
   ```

4. Add the unmask applier in `src/api/handlers.js` →
   `buildUnmaskDispatch`: `'weave.reforge': (seal) => weave.reforge(seal.payload.profileId, seal.payload.fusionId, { actor: seal.unmaskedBy })`.
   Without it a parked seal cannot be resolved (`no unmask dispatcher for kind`).
5. Add a test. `npm run entropy:test`.

**Add a system.** Construct it in `createApp`, add it to `systems`, then
`attach()` the peers it needs (producers first). Give it a vault domain, a
`stats()`, and — if records are addressable — a `findByAddress()` so the reverse
index keeps working.

**Emit an event.** `bus.emit('domain.thing.happened', payload)`; the HUD, SSE
clients and `bus.on()` listeners all pick it up with no extra wiring.

---

## 14. Invariants (do not break these)

* **Block headers are immutable.** `minedBy`, `reality`, `payouts` are metadata;
  the hashed fields are `version, prevHash, height, timestamp, seedRoot,
  difficultyBits, miner, nonce` (+`note` on genesis). Use
  `RealityMiners.headerOf(block)` when submitting *and* verifying. Overriding a
  consensus field after the spread silently invalidates the whole chain.
* **Workers never write state.** `mineThreaded` workers only search nonces and
  post results; the main thread is the single vault writer.
* **Reality is derived, not stored-then-trusted.** Fragments come from
  `sha256(blockHash ‖ seed ‖ index)`; `verifyChain({sampleReality})` re-derives
  them to prove it.
* **RLU is not money.** No market, no transfer off-network, no halving schedule;
  every credit is ledgered with a kind (`subsidy, fragment, share, spend,
  refund, mission, season, raid, adjustment`) and spends fail closed.
* **Missions are generated, not mutated.** Boards are pure functions of
  (seed, day/week/season); progress lives in `state.progress`, never in the
  mission object.
* **`observe()` is the only way objectives advance.** Adding a new player verb
  means adding an objective event *and* calling `missions.observe` from the
  system that owns the verb.
* **Presence and coordinates are quantised.** 25 m cells, consent default off.
* **Route specificity, not registration order.** The router scores patterns, so
  `/v1/memory/stats` is never swallowed by `/v1/memory/:profileId`.
* **The HUD is browser code.** No `require()` in `src/ui/hud.js`; re-render
  explicitly instead of observing your own DOM.

---

## 15. Where this sits in the repository

| existing asset | how Entropy binds to it |
|---|---|
| `contracts/WalletID.sol`, `EV0L721/1155`, `BLEUToken` | every entropy address ships an `evmAddress` (`0x` + 20-byte payload) ready to be minted, mapped or verified on-chain |
| `schemas/BLEU_PERSONA.v1.schema.json` (`^0x[0-9a-fA-F]{64}$`) | same checksummed-hex identity discipline; memory bundles are content-hashed the same way |
| `data/overlay_registry.json` (ŽEON archetypes) | AR layers + scan modes are the runtime counterpart; anchors can reference registry ids in `ref` |
| `src/runtime/*.py` (hypergrid, metaverse, persistence) | `docs/INTEGRATIONS.md` shows the Python bridge (HTTP + SSE + reverse index) |
| `docs/gallery/glyph_overlay.css` (dark) | superseded aesthetically by the generated bright alloy at `/ui/chromium.css`; the gallery still works unchanged |
| `.github/copilot-instructions.md` voice | the HUD and generated prose stay in EV0LVERSE register without leaking lore into consensus data |

---

## 16. Further reading

* **[`docs/MINING_STACK.md`](docs/MINING_STACK.md)** — the reality miners stack
  end to end: PoW, difficulty, retarget, shares, pool, stale handling, reality
  generation, verification, tuning. Simple, with every detail a pro would ask
  about.
* **[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)** — integration cookbook:
  auth patterns, the three pending strategies, SSE, the JS SDK, curl and Python
  recipes, Solidity binding, in-process embedding, security checklist.
* **[`../ENTROPY_GENESIS_UNMASK.md`](../ENTROPY_GENESIS_UNMASK.md)** — the
  one-page overview: what was asked for, where each piece lives, how to run it.

> *This is the Genesis Unmask.*
