# ENTROPY — GENESIS UNMASK

**The API, the integrations and the reality miners for the 3V30OS / EV0LVERSE platform.**

> *This is the Genesis Unmask.*
> Every record is addressed. Every mutation is journalled. Every consequential
> write waits for authority — and when enough authority arrives, it unmasks.

Built in `entropy/` beside the existing Solidity (`contracts/`), Python runtime
(`src/`) and data ledgers (`data/`). **Zero npm dependencies**, Node 18+, no
build step, no database server.

```
123 content handlers · 116 OpenAPI paths · 44 smart-value-gated writes
15 entropy address domains · 7 gameplay systems · 52 passing tests
1 CLI · 1 bright premium HUD · 1 complete proof-of-work reality stack
```

---

## Run it

```bash
npm run entropy:demo       # the whole platform, end to end, in ~4 seconds
npm run entropy:serve      # API :8080 · HUD :8080/ui/ · SSE :8080/v1/stream
npm run entropy:test       # 52 tests (core · keyring · systems · api)
```

The boot banner prints a **bootstrap key auth token** (tier `sovereign`,
smart value 6956). Export it and drive everything:

```bash
export URL=http://localhost:8080
export ENTROPY_TOKEN='entk.v1.…'
curl -s $URL/v1/status  -H "Authorization: Bearer $ENTROPY_TOKEN" | head -40
curl -s $URL/v1/handlers                                        | head -60
open $URL/ui/
```

`npm run` shortcuts added to the root `package.json` (the Hardhat scripts are
untouched):

```
entropy:serve  entropy:demo   entropy:status entropy:seed   entropy:token
entropy:mine   entropy:verify entropy:chain  entropy:handlers
entropy:reality entropy:wallet entropy:memory entropy:recall
entropy:weave  entropy:missions entropy:scan entropy:squad  entropy:lobby
entropy:pending entropy:events entropy:journal entropy:css  entropy:openapi
entropy:test
```

Runtime state lives in `data/entropy/` and is **git-ignored** (`genesis.json`,
`keyring.json` at mode `0600`, `journal.jsonl`, `state/*.json`, `cas/`).
Environment variables are documented in `.env.example` under *ENTROPY STACK*.

---

## What was asked for → where it lives

| # | the ask | implementation | try it |
|---|---|---|---|
| 1 | **Entropy Memory** — remembers skills, loadouts, wins, companion behaviours | `src/systems/memory.js` · 18 handlers | `POST /v1/memory/profiles` → `POST /v1/memory/{id}/matches` → `POST /v1/memory/{id}/recall` |
| 2 | **Power Weaving** — unlock and combine custom abilities | `src/systems/weave.js` · 8 schools · 16 base + mined abilities · STABLE / VOLATILE / FRACTURE | `POST /v1/weave/analyze` (dry run) → `POST /v1/weave/fuse` |
| 3 | **AR-style UI overlay** — scanning, missions, map layers | `src/systems/ar.js` · 7 layers · 4 scan modes · integrity-plated payloads · 25 m privacy quantisation · `GET /v1/ar/overlay.svg` | `POST /v1/ar/scan {"mode":"deep"}` |
| 4 | **AI squad companions that learn preferred tactics over time** | `src/systems/squad.js` · EMA learner (α 0.22) · 10 tactics · 6 roles · 9 quirk rules · bond + idle decay | `POST /v1/squad/{id}/learn` → `GET /v1/squad/{id}/briefing` |
| 5 | **Daily/weekly missions, world events, seasonal progression** | `src/systems/missions.js` · generated boards (7 archetypes, 19 objective events) · 7 world-event kinds · 28-day seasons, 7 tiers | `GET /v1/missions/board/{id}` → `POST /v1/missions/{id}/accept` → `…/complete` |
| 6 | **Safe multiplayer lobbies, parties, co-op raids** | `src/systems/multiplayer.js` · scored safety model (0–100, breakdown shown) · consent-gated quantised presence · reports park HIGH-risk seals · 7-phase raids | `POST /v1/multiplayer/lobbies` → `POST /v1/multiplayer/raids` → `…/tick` |
| 7 | **Brighter, cleaner, more premium interface** | `src/core/chromium.js` + `src/ui/` · generated alloy (bright / dusk / scan × Cr-2…Cr-9) · WCAG contrast report · `color-scheme: light` · live at `/ui/chromium.css` | open `/ui/` |
| 8 | **Entropy-generated addresses for ALL content handlers** | `src/core/entropy-core.js` → `EX-<DOMAIN>-<base58check>` + 20-byte `evmAddress`; every one of the 123 handlers addressed by `(seed, handlerId, "METHOD /path")` | `GET /v1/handlers` · `GET /v1/addresses/{address}` |
| 9 | **Entropy Chromium** added to entropy-based coding | `src/core/chromium.js` · deterministic alloy, generated CSS, integrity plates `chrp.v1.…`, `EX-CHR-…` addresses, `POST /v1/chromium/derive-address` | `GET /v1/chromium/alloy` |
| 10 | **Key auth token with a smart value on everything pending by code** | `src/core/keyring.js` · `entk.v1` HMAC tokens · smart-value formula · risk ladder · **Unmask Pool**: 202 + `EX-PND-…` seal → co-sign → **genesis unmask** | `POST /v1/auth/token` → park → `POST /v1/pending/{seal}/unmask` |
| 11 | **A full crypto-miners stack, simple but complete, generating reality instead of cryptocurrency** | `src/systems/miners.js` + `src/core/reality-gen.js` + `bin/miner-worker.js` · PoW, difficulty, retarget, shares, pool split, stale/orphan handling, wallets, verification — rewarding **RLU (Reality Units)** and generated world content | `npm run entropy:mine` → `npm run entropy:verify` |

---

## The three ideas that hold it together

### 1 · Everything is addressed

```
EX-<DOMAIN>-<base58check( payload20 ‖ checksum4 )>          evm form: 0x<payload hex>

payload  = sha256("eax", version, genesisSeed, domainCode, label, sublabel)[0:20]
checksum = sha256("eax-checksum", version, domainCode, payload)[0:4]
```

Length-prefixed hashing, domain separation, self-verifying checksums, and a
deterministic seed — so the same network always yields the same addresses, a
one-character typo fails verification instead of resolving to somebody else's
record, and every address has a 20-byte EVM twin ready for `contracts/`.

Fifteen domains: `GEN KEY PND HND MEM WEA ARX SQD MSN LBY MIN BLK RLT ART CHR`.
`HND` is the one the ask named: **all content handlers**.

`GET /v1/addresses/{address}` is the reverse index — hand it any address and it
returns the record that owns it (profile, ability, fusion, companion, mission,
world event, season, lobby, party, raid, report, block, fragment, wallet,
worker, job, pool, scan, anchor, layer, handler, alloy, root key, genesis).

### 2 · Authority is a number, and it decays

```
base = 120·tierIndex·tierMultiplier + 45·|scopes ∩ opScopes|
     +   8·pendingBudget + 3·entropyCredits + 250·admin:root + 400·root
live = floor( base · (0.55 + 0.45 · freshness) )
```

Tiers `guest → observer → operator → weaver → architect → sovereign`;
risk gates `NONE 0 · LOW 180 · MEDIUM 420 · HIGH 900 · SEVERE 1600 · GENESIS 2600`;
co-sign thresholds `1 / 2 / 2 / 3`. Long-lived tokens lose authority on purpose,
and rotating the master key invalidates every old token (`token_key_rotation`) —
that is the revocation story, with no session table.

### 3 · Nothing consequential happens silently

A gated write either **seals** (applies now) or **parks**:

```
HTTP/1.1 202 Accepted
{ "ok": true,
  "data": { "status":"pending", "sealId":"…", "sealAddress":"EX-PND-…",
            "requiredSmartValue":900, "offeredSmartValue":170,
            "coSignRequired":2, "expiresAt":"…", "nextSteps":[ … ] },
  "meta": { "sealed": false, "risk": "HIGH", "handler": "weave.fuse" } }
```

The seal is visible to the whole pool, carries its own address, expires rather
than lingering, and only commits when **co-signatures ≥ threshold AND aggregate
smart value ≥ required** — or when a `root` token overrides. Then a single
dispatch table (`src/api/handlers.js`) applies the parked payload through the
real system call and journals who unmasked it, with what authority, and why.

Callers choose the behaviour per request: `x-entropy-pending: force` (park it for
review even with authority) or `never` (403 instead of parking). Moderation
reports, sanctions, raids, fusions, world events and seasons all flow through
this gate. **That is the unmask.**

---

## Reality mining — the reward is the world

```
work  →  block  →  reality fragments  →  abilities · venues · raid terrain · lore ·
                                          companion banter · AR contacts · memories
                       ↓
                 RLU ledger  (monetary: false, market: null, no halving)
```

* `sha256(canonical(header))` must show ≥ `difficultyBits` leading zero bits;
  header = `version · prevHash · height · timestamp · seedRoot · difficultyBits · miner · nonce`.
* Difficulty 8–24 bits (genesis 12), retargeted every 5 blocks on the **window
  median**, clamped ×2/÷2 — bits are logarithmic, so `+1 bit = 2× work`.
* Shares are 4 bits easier than blocks; the pool pays block rewards by share
  weight of the parent tip. Stale, orphaned, duplicate and under-target
  submissions are counted, journalled and attributed.
* Each block generates 3–4 fragments (4 when the miner over-achieved) from
  `sha256(blockHash ‖ seed ‖ index)`: `scene, law, voice, terrain, artifact,
  glyph, weather, memory`, rolled against a rarity ladder
  (`common ×1 → refined ×1.8 → iridescent ×3.4 → plated ×6.5 → unmasked ×14`).
* **Artifacts become unlockable abilities.** Terrain sets raid difficulty. Voice
  fragments become companion banter. Scenes become mission venues. Memory
  fragments become Entropy Memory traces.
* `verifyChain()` re-checks every link, every PoW, the time ordering, and
  **re-derives the reality** of sampled blocks to prove content is reproducible
  from the hash alone.

Full walkthrough — including an external miner in Python, the worker-thread
model, the tuning guide and the honest limitations — in
[`entropy/docs/MINING_STACK.md`](entropy/docs/MINING_STACK.md).

---

## The interface

`entropy/src/ui/` is a bright, high-contrast, premium console built on the
generated alloy: crystalline light panels, AAA ink contrast at `bright/Cr-7`,
`color-scheme: light`, tabbed consoles for **overview · memory · weave · AR ·
squad · missions · multiplayer · mining · pending · handlers**, live SSE updates,
generated AR overlay SVG, and a seal-review pane that shows exactly why a write
is parked and what authority would clear it.

The theme is not hand-written: it is derived from the genesis seed and served
live at `/ui/chromium.css` and `/v1/chromium/css?surface=&grade=`, with a WCAG
contrast report attached so an inaccessible grade is a choice, not an accident.
The older `docs/gallery/glyph_overlay.css` remains untouched and still works.

---

## Integrating

[`entropy/docs/INTEGRATIONS.md`](entropy/docs/INTEGRATIONS.md) is the cookbook:

* auth patterns (bootstrap → scoped service tokens → refresh → verify offline),
* the response contract, error-code table and a retry policy that respects seals,
* **three pending strategies** with code (wait / co-sign / force-or-forbid),
* SSE recipes for curl, browser, Node and Python,
* the JS SDK (`src/sdk/client.js` CJS, `client.mjs` ESM) — every namespace,
  typed errors, `bootstrapPlayer()`, `autoUnmask`, `stream()`,
* a complete player loop in curl and a complete bridge in Python,
* **in-process embedding** (`createApp()`) for a game server that *is* the platform,
* an **event bridge** (`app.bus.on(type, fn)`) for webhooks, Discord/Slack, Kafka, indexers,
* an **external miner** client,
* **on-chain binding**: a sample `EntropyRealityRegistry.sol` that maps entropy
  payloads to `contracts/EV0L721` token ids, plus the persona mapping onto
  `schemas/BLEU_PERSONA.v1.schema.json`,
* HUD embedding, theming and payload-integrity verification,
* data contracts (memory export/import bundles, handler registry, OpenAPI),
* operations, a production checklist and a common-mistakes table.

---

## Repository changes

| path | change |
|---|---|
| `entropy/` | **new** — the whole stack (`src/core`, `src/systems`, `src/api`, `src/ui`, `src/sdk`, `bin`, `config`, `test`, `docs`, `openapi.snapshot.json`) |
| `ENTROPY_GENESIS_UNMASK.md` | **new** — this document |
| `package.json` | **added** 25 `entropy:*` scripts; Hardhat/ethers scripts and dependencies untouched |
| `.env.example` | **added** an *ENTROPY STACK* section (master key, genesis seed, data dir, port/host, mode, surface/grade, rate limits, seal TTL, CORS) |
| `.gitignore` | **added** entropy runtime state (`data/entropy/state|cas|journal.jsonl|keyring.json|genesis.json`) |
| `contracts/`, `src/`, `data/`, `schemas/`, `docs/gallery/`, `README.md` | **unchanged** — the stack binds to them, it does not rewrite them |

Nothing was installed: `node --test`, `node:http`, `node:crypto`,
`node:worker_threads` and `fetch` are all built in.

---

## Verification

```bash
npm run entropy:test
# core.test.js       14 tests — addressing, canonical hashing, RNG, vault, chromium, reality-gen
# keyring.test.js    12 tests — tokens, smart value, decay, rotation, the Unmask Pool lifecycle
# systems.test.js    15 tests — all seven systems, cross-system attach, independent PoW search,
#                               tamper detection via verifyChain
# api.test.js        11 tests — real sockets: envelope, 202 gate, co-sign/unmask/void, forced and
#                               forbidden parking, SSE, generated assets, 404/405/429, the JS SDK
# tests 52 · pass 52 · fail 0
```

```bash
npm run entropy:verify      # valid: true · problems: 0 · reality re-derived from hashes
npm run entropy:demo        # mine → unlock → weave → scan → squad → missions → lobby → raid → unmask
```

The systems tests run a whole chain lifecycle in milliseconds by overriding
consensus (`createApp({ consensus: { genesisDifficultyBits: 9, retargetInterval:
3, targetBlockMs: 60 } })`), search nonces with an **independent**
implementation, and patch stored blocks to prove `verifyChain` notices.

---

## Documentation map

```
ENTROPY_GENESIS_UNMASK.md          ← you are here (overview + requirement map)
entropy/README.md                  architecture · addresses · tokens · systems · HTTP · CLI · config
entropy/docs/MINING_STACK.md       the reality miners stack, end to end
entropy/docs/INTEGRATIONS.md       integration cookbook (8 shapes, 6 languages/runtimes)
entropy/openapi.snapshot.json      committed OpenAPI 3.1 contract (116 paths)
GET /v1                            live protocol card
GET /v1/handlers                   live handler registry (123 addressed handlers)
GET /v1/openapi.json               live contract
GET /v1/miners/consensus           live consensus parameters + human explanation
```

---

*Sealed, addressed, journalled, gated — and unmasked.*
