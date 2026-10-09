# Integration Cookbook

**Custom integrations for game clients, metaverse servers, tools and contracts.**

Every recipe below runs against a stock server:

```bash
npm run entropy:serve                      # API :8080, HUD :8080/ui/
export URL=http://localhost:8080
export ENTROPY_TOKEN=$(node entropy/bin/entropy.js token --subject commander --tier sovereign --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
```

Companion docs: [`../README.md`](../README.md) (architecture) ·
[`MINING_STACK.md`](MINING_STACK.md) (consensus + mining) ·
[`../openapi.snapshot.json`](../openapi.snapshot.json) (full API contract).

---

## 1. Pick an integration shape

| shape | when | entry point |
|---|---|---|
| **HTTP client** | any language, any process | `POST /v1/auth/token` then the 123 handlers |
| **JS SDK** | Node services, Electron, browser tooling | `src/sdk/client.js` (CJS) / `client.mjs` (ESM) |
| **SSE listener** | dashboards, bots, live ops | `GET /v1/stream` or `client.stream()` |
| **In-process embed** | a game server that *is* the platform | `createApp()` from `src/api/server.js` |
| **External miner** | rigs, farms, CI content generation | `work` → search → `submit` (§11) |
| **Event bridge** | webhooks, Discord/Slack, Kafka, indexing | `app.bus.on(type, fn)` (§10) |
| **On-chain binding** | minting/verifying entropy addresses | `evmAddress` + `contracts/` (§12) |
| **HUD embed** | in-game browser, kiosk, overlay | `/ui/`, `/ui/chromium.css`, `/v1/ar/overlay.svg` (§13) |

---

## 2. Auth patterns

### 2.1 Bootstrap (first contact)

The boot banner prints a **sovereign bootstrap token** (smart value 6956, 12 h).
It exists so a fresh deployment is usable before any auth plumbing — treat it as
a root password: use it to mint *narrow* tokens, then put it away.

```bash
node entropy/bin/entropy.js token --subject commander --tier sovereign --json
```

### 2.2 Issue a scoped integration token

```bash
curl -s -X POST $URL/v1/auth/token -H 'content-type: application/json' -d '{
  "subject": "integration:discord-bridge",
  "tier": "operator",
  "scopes": ["entropy:read", "memory:write", "mission:write"],
  "ttlSeconds": 86400,
  "pendingBudget": 3,
  "meta": { "owner": "community-team", "service": "discord-bridge" }
}'
```

Response: `{ token, address (EX-KEY-…), tier, scopes, issuedAt, expiresAt,
smartValue, entropyPhrase, warning }`.

**Choosing a tier/scopes by integration type:**

| integration | tier | scopes |
|---|---|---|
| read-only dashboard / exporter | `observer` | `entropy:read` |
| game client (player-owned) | `operator` | `entropy:read`, `memory:write`, `squad:write`, `ar:write`, `lobby:write`, `miner:work` |
| content pipeline / mission bot | `architect` | `entropy:read`, `mission:write`, `weave:write` |
| moderation service | `weaver` | `entropy:read`, `lobby:write`, `unmask:seal` |
| platform admin / deployer | `sovereign` | all, incl. `admin:root` |

Ask for the *fewest* scopes that work: smart value counts only the scopes the
handler actually requires (`45 · |scopes ∩ opScopes|`), so a bloated token does
not buy authority — it buys blast radius.

### 2.3 Verify, refresh, introspect

```bash
curl -s -X POST $URL/v1/auth/verify -H 'content-type: application/json' \
     -d "{\"token\":\"$ENTROPY_TOKEN\",\"opScopes\":[\"weave:write\"]}"
curl -s $URL/v1/auth/me        -H "Authorization: Bearer $ENTROPY_TOKEN"
curl -s -X POST $URL/v1/auth/refresh -H "Authorization: Bearer $ENTROPY_TOKEN" -d '{}'
curl -s $URL/v1/auth/catalog   -H "Authorization: Bearer $ENTROPY_TOKEN"   # tiers, scopes, risk ladder, formula
```

Tokens are **stateless HMAC** (`entk.v1.<b64url claims>.<b64url sig>`), so any
service holding the master key can verify offline:

```js
const { Keyring } = require('./entropy/src/core/keyring');
const keyring = new Keyring({ vault, masterKey: process.env.ENTROPY_MASTER_KEY, seed });
const auth = keyring.verifyToken(token, ['weave:write']);
// { valid, claims, smartValue, reason, code }   code ∈ token_missing|malformed|signature|payload|key_rotation|expired|scope
```

### 2.4 Production

* `ENTROPY_MODE=prod` → `POST /v1/auth/token` itself requires `admin:root`.
* `ENTROPY_MASTER_KEY` from a secrets manager. Rotating it changes `kid`, and
  every old token fails with `token_key_rotation` — that is the revocation path.
* Smart value decays to 55 % of base at expiry, so long-lived tokens are
  intrinsically weaker. Prefer short TTLs + `POST /v1/auth/refresh`.
* Store tokens server-side. In a browser, keep them out of `localStorage` for
  privileged tiers; the HUD is designed for a session-scoped token.

---

## 3. The response contract

Every JSON response is `{ ok, data | error, meta }`. Read `meta`, not the HTTP
status alone:

```js
const res = await fetch(`${URL}/v1/weave/analyze`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ abilityIds: ['gate-seal', 'tidal-step'] }),
});
const { ok, data, meta, error } = await res.json();

meta.requestId        // quote this in any bug report
meta.handler          // 'weave.analyze'
meta.entropyAddress   // EX-HND-… the handler that answered
meta.risk             // declared risk of this operation
meta.sealed           // false ⇔ the effect was parked, not applied
meta.smartValue       // the live authority you presented
meta.tookMs           // server-side timing
```

**`res.status === 202` means "parked, not done."** Handle it explicitly — see §4.

### Error codes you will actually see

| code | status | do this |
|---|---|---|
| `token_missing` / `token_malformed` / `token_signature` | 401 | re-issue the token |
| `token_expired` | 401 | refresh, then retry once |
| `token_key_rotation` | 401 | the master key rotated — re-issue |
| `token_scope` | 403 | request a token with the missing scope (`error.detail.required`) |
| `bad_request` | 400 | fix the payload; `error.detail` names the field |
| `not_found` | 404 | the record does not exist on this network |
| `conflict` | 409 | state moved on (lobby full, seal closed, party dissolved) |
| `rate_limited` | 429 | back off for `retry-after` seconds |
| `seal_expired` / `seal_closed` / `seal_already_unmasked` | 409 | re-park the write; do not retry the unmask |
| `unmask_insufficient` | 403 | co-sign more authority, or void |
| `insufficient_rlu` | *(in `data`)* | `data.ok === false` with `detail.shortfall` — a normal outcome, not an HTTP error |

**Retry policy:** retry only on 429 and network errors, with jittered backoff.
Writes are idempotent by construction where it matters (`ensureProfile` by
subject, `accept` a mission twice, `recruit` twice → `status:'existing'`,
`abilityFromArtifact` twice → `created:false`, `importProfile` twice →
`noop`), so a retry after a timeout is safe — but a *parked* write must never be
blindly re-posted: you would park a second seal. Check `meta.sealed` first.

---

## 4. Handling pending seals — three strategies

### A. Wait for authority (default, best for player clients)

```js
const res = await fetch(`${URL}/v1/weave/fuse`, { method: 'POST', headers, body });
if (res.status === 202) {
  const { data: seal } = await res.json();
  queueForReview(seal);              // sealId, requiredSmartValue, expiresAt, nextSteps[]
  notifyModerators(seal);            // the seal is now discoverable via GET /v1/pending
  return { pending: true, sealId: seal.sealId };
}
```

A parked effect is **visible to the whole pool** (`GET /v1/pending`), carries its
own `EX-PND-…` address, and expires (default 30 minutes) rather than lingering.

### B. Co-sign to clear (authority holders)

```bash
curl -s -X POST "$URL/v1/pending/$SEAL/cosign" -H "Authorization: Bearer $MOD_TOKEN" \
     -H 'content-type: application/json' -d '{"note":"reviewed in Discord"}'
# → { coSigned:true, autoUnmasked:true, status:'unmasked', result:{ … } }   when the
#   signature threshold AND the aggregate smart value are both satisfied
```

`coSignRequired` is 1 / 2 / 2 / 3 for LOW / MEDIUM / HIGH / GENESIS. One call can
both co-sign and apply, which is what a moderation bot wants.

### C. Force or forbid parking (per request)

```js
// review flow: park it even though I could apply it now
headers['x-entropy-pending'] = 'force';

// transactional flow: never park — 403 instead, so I can fail fast
headers['x-entropy-pending'] = 'never';
```

Query form for clients that cannot set headers (`EventSource`, `<img>`):
`?pending=force` / `?pending=never` / `?token=entk.v1.…`.

### Resolving a seal

```bash
curl -s -X POST "$URL/v1/pending/$SEAL/unmask" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"note":"genesis unmask"}'
# → { status:'unmasked', sealId, kind, sealAddress, unmaskedBy, authority,
#     required, coSignatures, result:{ …the real system return value… }, at }

curl -s -X POST "$URL/v1/pending/$SEAL/void" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"reason":"player cancelled"}'
```

`result` is the applier's return value — for `weave.fuse` that is the fusion (or
the fracture residue), for `memory.remember` the trace, for
`multiplayer.sanction` the applied sanction. Terminal states are terminal:
re-unmasking a voided/expired/failed seal returns 409.

---

## 5. Live events (SSE)

```bash
curl -N $URL/v1/stream                       # raw frames
curl -N "$URL/v1/stream" | grep --line-buffered 'event: miners.block'
```

```js
// browser
const es = new EventSource(`${URL}/v1/stream`);
es.addEventListener('miners.block', (e) => hud.addBlock(JSON.parse(e.data).payload));
es.addEventListener('pending.parked', (e) => review.push(JSON.parse(e.data).payload));
```

```js
// Node service — the SDK reconnects with exponential backoff and filters for you
const sub = client.stream(
  ({ type, payload, at }) => log.info({ type, payload, at }),
  { types: ['miners.block', 'weave.fused', 'pending.unmasked', 'missions.completed'] },
);
// … later
sub.close();
```

Default `types` when you pass none: `miners.block, miners.retarget, weave.fused,
pending.parked, pending.unmasked, memory.match, missions.completed,
multiplayer.raid.resolved, squad.quirk, ar.scan`.

Node without `EventSource` (Node < 22 or a worker) — read the stream directly:

```js
const res = await fetch(`${URL}/v1/stream`, { headers: { accept: 'text/event-stream' } });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop();
  for (const frame of frames) {
    const type = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (type && data) onEvent(type, JSON.parse(data));
  }
}
```

Frames are `event: <type>\ndata: <record>\n\n` where `record` is
`{ id, type, payload, meta, at }`; a `: ping` comment arrives every 20 s so
proxies do not close an idle connection. `GET /v1/status` and `GET /v1/journal`
are the polling fallbacks.

---

## 6. JavaScript SDK

```js
const { EntropyClient, EntropyApiError } = require('./entropy/src/sdk/client.js');   // CJS
// import { EntropyClient } from './entropy/src/sdk/client.mjs';                      // ESM

const client = new EntropyClient({
  baseUrl: process.env.ENTROPY_BASE_URL || 'http://localhost:8080',
  subject: 'integration:game-server',
  tier: 'operator',
  scopes: ['entropy:read', 'memory:write', 'squad:write', 'lobby:write', 'miner:work'],
  pendingMode: 'auto',                    // 'auto' | 'force' | 'never'
  autoUnmask: false,                      // true ⇒ co-sign + unmask parked seals immediately
  onPending: (seal) => metrics.pending(seal),
  onPendingError: (err, seal) => log.error({ err, seal }),
  autoRefreshSec: 300,                    // refresh this long before expiry
  timeoutMs: 120_000,
});

await client.login({ ttlSeconds: 3600 });  // mints + stores the token, fills client.claims
```

Namespaced surfaces (each method is one handler; each returns `data`, not the
envelope — `meta` is attached non-enumerably as `data.__meta` and mirrored on
`client.lastMeta`):

```
client.system.{index,health,status,journal,handlers,handler,openapi,resolveAddress}
client.auth.{issue,verify,me,refresh,catalog}
client.pending.{list,get,cosign,unmask,void,stats}
client.memory.{ensureProfile,listProfiles,profile,skills,useSkill,remember,recall,
               forget,consolidate,graph,saveLoadout,loadouts,equipLoadout,
               recordMatch,companionBehaviors,exportProfile,importProfile,stats}
client.weave.{catalog,schools,ability,unlock,analyze,fuse,useFusion,unweave,
              holdings,recipes,leaderboard,stats}
client.ar.{layers,scan,history,tile,overlayUrl,overlaySvg,anchors,createAnchor,
           removeAnchor,stats}
client.squad.{roster,tactics,recruit,companions,model,drill,learn,recommend,
              briefing,banter,dismiss,stats}
client.missions.{board,generate,accept,complete,observe,worldEvents,triggerEvent,
                 season,seasonProgress,leaderboard,stats}
client.multiplayer.{safetyModel,createLobby,lobbies,find,lobby,join,leave,invite,
                    moderate,consent,report,safeExit,createParty,joinParty,party,
                    createRaid,raids,raid,ready,tick,heartbeat,presence,stats}
client.miners.{consensus,chain,block,verify,pool,registerWorker,work,submit,mine,
               wallet,reality,fragment,deriveFragment,stats}
client.chromium.{alloy,cssUrl,css,plate,verifyPlate,deriveAddress}
client.{get,post,patch,delete,raw,request,login,decodeToken,stream,
        bootstrapPlayer,handlePending,maybeRefreshToken}
client.stats → { calls, pending, errors, unmasked }
```

**The one-shot onboarding flow** (profile + companions + accepted missions):

```js
const boot = await client.bootstrapPlayer('player-42', { alias: 'Commander Bleu', recruitCompanions: 2 });
// → { profileId, address: 'EX-MEM-…', recruited: […], missions: 7 }
```

**Typed errors:**

```js
try {
  await client.memory.profile('does-not-exist');
} catch (err) {
  if (err instanceof EntropyApiError) {
    err.status;   // 404
    err.code;     // 'not_found'
    err.detail;   // { hint: 'POST /v1/memory/profiles { subject } to create it' }
    err.meta;     // { requestId, handler, entropyAddress, … }
  }
}
```

---

## 7. A complete player loop (curl)

```bash
# 1 · identity
PID=$(curl -s -X POST $URL/v1/memory/profiles -H "Authorization: Bearer $ENTROPY_TOKEN" \
      -H 'content-type: application/json' -d '{"subject":"player-42","alias":"Commander Bleu"}' \
      | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.profile.profileId')

# 2 · mine some reality (also feeds missions, memory, raid terrain)
curl -s -X POST $URL/v1/miners/mine -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"seconds\":3,\"blocks\":2}"

# 3 · unlock + preview + commit a fusion
curl -s -X POST $URL/v1/weave/unlock -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"abilityId\":\"gate-seal\"}"
curl -s -X POST $URL/v1/weave/analyze -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"abilityIds\":[\"gate-seal\",\"tidal-step\"]}"
curl -s -X POST $URL/v1/weave/fuse -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"abilityIds\":[\"gate-seal\",\"tidal-step\"]}"

# 4 · recruit, teach, ask what the companion learned
CID=$(curl -s $URL/v1/squad/roster -H "Authorization: Bearer $ENTROPY_TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.companions[0].companionId')
curl -s -X POST "$URL/v1/squad/$PID/recruit" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"companionId\":\"$CID\"}"
curl -s -X POST "$URL/v1/squad/$PID/companions/$CID/drill" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"tactic":"hold-gate","intensity":2}'
curl -s "$URL/v1/squad/$PID/briefing" -H "Authorization: Bearer $ENTROPY_TOKEN"

# 5 · missions: accept FIRST, then play, then claim
curl -s "$URL/v1/missions/board/$PID" -H "Authorization: Bearer $ENTROPY_TOKEN"
curl -s -X POST "$URL/v1/missions/$MID/accept" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\"}"
curl -s -X POST $URL/v1/missions/observe -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"event\":\"match.win\",\"amount\":1}"
curl -s -X POST "$URL/v1/missions/$MID/complete" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\"}"

# 6 · AR scan + overlay image (the overlay needs no token)
curl -s -X POST $URL/v1/ar/scan -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"mode\":\"deep\"}"
curl -s "$URL/v1/ar/overlay.svg?w=960&h=540&title=SECTOR%207" -o overlay.svg

# 7 · safe lobby + party + raid
curl -s -X POST $URL/v1/multiplayer/lobbies -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"profileId\":\"$PID\",\"name\":\"Spire Watch\",\"mode\":\"raid\"}"
curl -s -X POST "$URL/v1/multiplayer/lobbies/$LID/join" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"profileId":"ally-1","consentShared":true}'
curl -s -X POST $URL/v1/multiplayer/raids -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d "{\"lobbyId\":\"$LID\"}"
curl -s -X POST "$URL/v1/multiplayer/raids/$RID/tick" -H "Authorization: Bearer $ENTROPY_TOKEN" -d '{}'

# 8 · memory: what does the platform remember about this player?
curl -s -X POST "$URL/v1/memory/$PID/recall" -H "Authorization: Bearer $ENTROPY_TOKEN" \
     -H 'content-type: application/json' -d '{"query":"raid loadout","limit":5}'
curl -s "$URL/v1/memory/$PID/export" -H "Authorization: Bearer $ENTROPY_TOKEN"
```

---

## 8. Python integration

```python
"""Entropy bridge: mine reality, scan, park a write, unmask it."""
import os, requests

URL   = os.environ.get("ENTROPY_BASE_URL", "http://localhost:8080")
TOKEN = os.environ["ENTROPY_TOKEN"]
H     = {"authorization": f"Bearer {TOKEN}", "content-type": "application/json"}


def data(method: str, path: str, **kw):
    """Unwrap the envelope; raise on error; surface parked seals."""
    r = requests.request(method, f"{URL}{path}", headers=H, timeout=60, **kw)
    body = r.json()
    if not r.ok or body.get("ok") is False:
        err = body.get("error", {})
        raise RuntimeError(f"{r.status_code} {err.get('code')}: {err.get('message')} "
                           f"(request {body.get('meta', {}).get('requestId')})")
    if r.status_code == 202:                       # parked, not applied
        return {"pending": True, **body["data"]}
    return body["data"]


# 1 · identity (idempotent by subject)
profile = data("POST", "/v1/memory/profiles", json={"subject": "python-bridge", "alias": "Bridge"})
pid = profile["profile"]["profileId"]
print("profile", pid, profile["address"])

# 2 · mine reality, then read what the world now contains
mined = data("POST", "/v1/miners/mine", json={"profileId": pid, "seconds": 3, "blocks": 2})
print("blocks", mined["blocksMined"], "RLU", mined["wallet"]["rlu"])
library = data("GET", "/v1/miners/reality?limit=3")   # { totalFragments, kinds[], rluEmitted }
for group in library["kinds"]:
    for frag in group["samples"]:
        print(" ", frag["kind"], frag["rarity"], frag["address"], "—", frag.get("title"))

# 3 · a deep AR scan, plated for integrity
scan = data("POST", "/v1/ar/scan", json={"profileId": pid, "mode": "deep"})
print("contacts", scan["contactCount"], "plate", scan["chromePlate"])

# 4 · live world events + today's board
events = data("GET", "/v1/missions/events")          # { live, scheduledToday, kinds, multipliers }
for ev in events["live"]:
    print("live event", ev["kind"], ev["modifier"], ev["startsAt"], "→", ev["endsAt"])
print("multipliers now", events["multipliers"])
board = data("GET", f"/v1/missions/board/{pid}")
mission = board["daily"][0]
data("POST", f"/v1/missions/{mission['missionId']}/accept", json={"profileId": pid})
for obj in mission["objectives"]:
    data("POST", "/v1/missions/observe",
         json={"profileId": pid, "event": obj["event"], "amount": obj["target"]})
print("claimed", data("POST", f"/v1/missions/{mission['missionId']}/complete", json={"profileId": pid}))

# 5 · reverse index: what owns this address?
print(data("GET", f"/v1/addresses/{scan['address']}"))

# 6 · live events over SSE
with requests.get(f"{URL}/v1/stream", headers={"authorization": f"Bearer {TOKEN}"},
                  stream=True, timeout=(5, None)) as sse:
    for line in sse.iter_lines(decode_unicode=True):
        if line and line.startswith("event:"):
            print("SSE", line[7:])
```

Python notes: `requests` is the only dependency and it is *yours*, not ours — the
platform has none. For the SSE tail, `httpx` or `sseclient-py` also work; the
frame format is standard (`event:` / `data:` / blank line).

---

## 9. Embedding in-process (a game server that *is* the platform)

Skip HTTP entirely. `createApp()` returns the same wiring the server uses, so a
game process can call systems directly — with no sockets, no serialisation and
no auth overhead (you are already trusted in-process):

```js
const { createApp } = require('./entropy/src/api/server');

const app = createApp({
  dataDir: './data/entropy',
  seed: process.env.ENTROPY_GENESIS_SEED,      // stable seed ⇒ stable addresses
  mode: 'prod',
  surface: 'bright',
  grade: 'Cr-7',
  consensus: { targetBlockMs: 30_000 },        // optional override
});

const { memory, weave, ar, squad, missions, multiplayer, miners } = app.systems;

// your own auth layer decides who the actor is; the systems take an `actor`
const profile = memory.ensureProfile('player-42', { alias: 'Commander Bleu' });
memory.recordMatch(profile.profileId, { result: 'win', mode: 'raid', tactics: ['hold-gate'] }, { actor: 'player-42' });
const scan = ar.scan({ profileId: profile.profileId, mode: 'deep' }, { actor: 'player-42' });

// authority still applies when you want it: use the keyring directly
const auth = app.keyring.verifyToken(req.headers.authorization?.slice(7), ['weave:write']);
const seal = app.keyring.parkPending({ kind: 'weave.fuse', payload: { … }, claims: auth.claims,
                                       requiredSmartValue: app.keyring.requiredFor('HIGH'),
                                       handler: 'in-process', reason: 'review required' });

// serve HTTP too, if you want the HUD alongside (optional)
await app.listen({ port: 8080, host: '0.0.0.0' });

// shutdown: clears every timer, closes the vault and the server
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
```

Rules for embedding:

* **One writer per data directory.** Two processes on the same `dataDir` will
  clobber each other's snapshots (atomic writes protect against corruption, not
  against lost updates).
* Always `await app.close()` — `createApp` starts four timers (seal sweep,
  idle decay, consolidation, world events).
* The `actor` argument is *your* attribution; the journal records it verbatim.
* Cross-system effects still fire: calling `miners.mineLocal()` will generate
  abilities, write memory traces and advance missions, exactly as over HTTP.

---

## 10. Event bridge (webhooks, Discord, Kafka, indexers)

In-process listeners are the cheapest bridge. They cannot break the write path
(listener exceptions are swallowed) and `off()` never leaks a hook:

```js
const { createApp } = require('./entropy/src/api/server');
const app = createApp({ dataDir: './data/entropy' });

const offBlock = app.bus.on('miners.block', async (record) => {
  await fetch(process.env.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'entropy',
      type: record.type,
      at: record.at,
      height: record.payload.height,
      address: record.payload.address,       // EX-BLK-…
      rlu: record.payload.rlu,
      reality: record.payload.realityCount,
    }),
  });
});

// firehose for an indexer or an audit sink
const offAll = app.bus.on('*', (record) => sink.write(`${record.type}\t${JSON.stringify(record.payload)}\n`));

// Discord/Slack flavour
app.bus.on('pending.parked', (r) => chat.post({
  text: `🔒 *${r.payload.kind}* parked — needs ${r.payload.requiredSmartValue} authority ` +
        `(offered ${r.payload.offeredSmartValue}). Unmask: POST /v1/pending/${r.payload.sealId}/unmask`,
}));
app.bus.on('weave.fused', (r) => chat.post({ text: `✨ ${r.payload.name} (${r.payload.outcome}, power ${r.payload.power})` }));
app.bus.on('multiplayer.report', (r) => modQueue.push(r.payload));   // moderation, not auto-action
```

Out-of-process, subscribe to SSE instead (§5) — same payloads, no code inside
the platform. `GET /v1/journal?limit=` is the durable audit trail (it records
who did what, with which handler, and why) and `GET /v1/status` is the polling
counterpart.

---

## 11. External miners and content farms

See [`MINING_STACK.md` §11](MINING_STACK.md#11-writing-an-external-miner-any-language)
for a complete Python miner. The short version:

```
POST /v1/miners/workers   { workerId, label, pool:true }      scope miner:work
GET  /v1/miners/work?workerId=…                                → job (45 s TTL)
   …search nonce until leadingZeroBits(sha256(canonical(header))) ≥ shareTargetBits…
POST /v1/miners/submit    { jobId, nonce, workerId, hashes }   → share | block | code
```

* Submit **every** share-grade solution; the pool pays block rewards by share
  weight of the parent tip.
* On `job_expired` / `stale_tip`, re-poll — do not retry the nonce.
* Prefer SSE (`miners.block`) over polling to learn the tip moved.
* A CI "content farm" is legitimate: run `mine --threads 4 --seconds 30` on a
  schedule to keep the world stocked with venues, terrain, lore and abilities.

---

## 12. On-chain binding (Solidity)

Every entropy address ships a 20-byte EVM form (`evmAddress`), so an address can
be minted, mapped or verified against `contracts/` without a translation table:

```
EX-MEM-McDHs2oA4PNiAvAC5W2T2wQYb6BGPrDhs
   └─ payload (20 bytes) → 0xe20b5589538c05c0da12323103965aebf386ce8c
```

```solidity
// contracts/EntropyRealityRegistry.sol — bind mined reality to the EVM side
// (the repo already has WalletID / EV0L721 / EV0L1155 / BLEUToken to hook into)
pragma solidity ^0.8.20;

interface IEV0L721 {
    function safeMint(address to, uint256 tokenId, string calldata uri) external;
}

contract EntropyRealityRegistry {
    struct Reality {
        bytes20 entropyPayload;   // EX-RLT-… payload (the 20 bytes inside the address)
        bytes32 blockHash;        // sha256(canonical(header)) of the mining block
        bytes32 contentHash;      // canonical JSON hash of the fragment
        uint16  rarityMultiplier; // ×100 (common 100 … genesis-unmasked 1400)
        uint64  mintedAt;
        bool    exists;
    }

    IEV0L721 public immutable token;
    address  public oracle;                        // the entropy bridge service
    mapping(bytes20 => Reality) public reality;    // entropyPayload → record

    event RealityRegistered(bytes20 indexed entropyPayload, bytes32 indexed blockHash, bytes32 contentHash);
    event RealityMinted(bytes20 indexed entropyPayload, uint256 indexed tokenId, address to);

    constructor(address ev0l721, address oracle_) { token = IEV0L721(ev0l721); oracle = oracle_; }

    modifier onlyOracle() { require(msg.sender == oracle, "not the entropy oracle"); _; }

    /// The oracle submits a proof package it built from GET /v1/miners/fragments/{address}
    /// plus POST /v1/miners/verify. Off-chain verification is cheap and reproducible:
    /// anyone can re-derive the fragment from (blockHash, seed, index).
    function register(
        bytes20 entropyPayload, bytes32 blockHash, bytes32 contentHash, uint16 rarityMultiplier
    ) external onlyOracle {
        require(!reality[entropyPayload].exists, "already registered");
        reality[entropyPayload] = Reality(entropyPayload, blockHash, contentHash, rarityMultiplier,
                                          uint64(block.timestamp), true);
        emit RealityRegistered(entropyPayload, blockHash, contentHash);
    }

    /// tokenId = uint256(entropyPayload) keeps the mapping 1:1 and guessable from the address.
    function mint(bytes20 entropyPayload, address to, string calldata uri) external onlyOracle {
        Reality storage r = reality[entropyPayload];
        require(r.exists, "unknown reality");
        uint256 tokenId = uint256(r.entropyPayload);
        token.safeMint(to, tokenId, uri);
        emit RealityMinted(entropyPayload, tokenId, to);
    }

    /// View helper for a wallet UI: is this entropy address already on-chain?
    function owner(bytes20 entropyPayload) external view returns (bool exists, uint16 rarityMultiplier, bytes32 contentHash) {
        Reality storage r = reality[entropyPayload];
        return (r.exists, r.rarityMultiplier, r.contentHash);
    }
}
```

Bridge recipe (Node):

```js
// 1. take a mined fragment (reality library: { totalFragments, kinds[{kind,count,samples}] })
const frag = (await client.miners.reality({ limit: 1 })).kinds[0].samples[0];

// 2. prove the chain it came from
const verified = await client.miners.verify(25);            // { valid:true, problems:[] }
if (!verified.valid) throw new Error('refusing to bridge an invalid chain');

// 3. hand the EVM form + content hash to the registry
const payload = `0x${frag.evmAddress.slice(2)}`;            // 20 bytes, as-is
await wallet.sendTransaction({ to: REGISTRY, data: iface.encodeFunctionData('register', [
  payload, frag.sourceHash /* blockHash */, contentHash(frag), Math.round(frag.rarityMultiplier * 100),
])});
```

Personas follow the repo's existing `schemas/BLEU_PERSONA.v1.schema.json`
(`personaId ^0x[0-9a-fA-F]{64}$`, `account ^0x[0-9a-fA-F]{40}$`): use a memory
profile's `evmAddress` as `account`, and its `memorySignature.evmAddress`-style
content hash as the 32-byte persona id.

---

## 13. HUD embedding and theming

```html
<!-- full console -->
<iframe src="http://localhost:8080/ui/" style="width:100%;height:100%;border:0"></iframe>

<!-- generated theme for YOUR UI (live, never a stale file) -->
<link rel="stylesheet" href="http://localhost:8080/ui/chromium.css" />

<!-- a ready-made AR overlay frame as an <img> (no token needed) -->
<img src="http://localhost:8080/v1/ar/overlay.svg?mode=deep&w=960&h=540&title=SECTOR%207" />
```

Theming is a two-parameter API — surface and grade — and the alloy is derived
from the genesis seed, so a network has one coherent look:

```bash
curl -s "$URL/v1/chromium/css?surface=bright&grade=Cr-9" | head -40
curl -s "$URL/v1/chromium/alloy?surface=scan&grade=Cr-5" -H "Authorization: Bearer $ENTROPY_TOKEN"
```

```jsonc
GET /v1/chromium/alloy            (public — no token needed)
{ "alloy": {
    "id":"…", "address":"EX-CHR-…", "evmAddress":"0x…", "label":"Genesis Chromium",
    "seedFingerprint":"…", "surface":{ "id":"bright", "base":"light", … },
    "grade":{ "grade":"Cr-7", "tier":"architect", "iridescence":0.74, "gloss":0.8, … },
    "hues":{…},
    "colors":{ "bg":"…", "panel":"…", "ink":"…", "muted":"…", "line":"…", "accent":"…", "states":{…} },
    "contrast":{ "inkOnPanel":12.4, "accentOnPanel":4.8, "aa":true, "aaa":true },
    "material":{ "gloss":0.8, … }, "type":{…}, "motion":{…},
    "arHud":{ "reticle":{…}, "scanline":{…}, "layers":{…}, "maxContacts":…, "anchorMarker":{…} } },
  "surfaces":{ "bright":{…}, "dusk":{…}, "scan":{…} },
  "grades":[ { "grade":"Cr-2", … }, … ],
  "cssUrl":"/v1/chromium/css" }
```

Always check `contrast.aa` / `contrast.aaa` before shipping a custom grade — the
alloy computes WCAG relative luminance for you, so an inaccessible theme is a
choice, not an accident.

**Payload integrity in a client:**

```js
const { plate, verifyPlate } = require('./entropy/src/core/chromium');
const stamp = plate(scanPayload, { seed, masterKey, subject: 'ar', kind: 'ar.payload', grade: 'Cr-7' });
// → { plate:'chrp.v1.Cr-7.<hash16>.<hmac16>', contentHash, address:'EX-CHR-…', platedAt, grade, subject, kind }
verifyPlate(stamp.plate, scanPayload, { masterKey, subject: 'ar', kind: 'ar.payload' });
// → { valid:true, reason:null, contentHash, grade:'Cr-7' }   (constant-time on the HMAC half)
```

Over HTTP: `POST /v1/chromium/plate` and `POST /v1/chromium/verify-plate` (scope
`entropy:read`) — the server supplies `seed`, `masterKey` and the active grade. Scans
and map tiles are already plated server-side (`chromePlate`, `plateAddress`), so
a client can prove the overlay it drew is the one the server issued.

---

## 14. Data contracts

* **Memory portability** — `GET /v1/memory/{profileId}/export` returns an
  `ENTROPY-MEMORY` bundle `{ protocol, version, exportedAt,
  networkSeedFingerprint, profile{…traces}, signature, contentHash }`;
  `POST /v1/memory/import` accepts it. Import is idempotent by
  `(subject, signature)` → `noop` | `merged` (max of each durable number, union
  of traces) | `created`. Use it for server merges, backups and cross-network
  migration.
* **Handlers** — `GET /v1/handlers` is the machine-readable contract for
  codegen: `{ handler, method, path, url, group, title, summary, risk,
  requiredSmartValue, scopes[], auth, entropyAddress, evmAddress, digest,
  checksum, idempotent, pendingCapable }` for all 123 handlers, grouped.
* **OpenAPI** — `GET /v1/openapi.json` (3.1) with `x-entropy-address`, `x-risk`,
  `x-required-smart-value`, `x-scopes` on every operation. A committed snapshot
  lives at `entropy/openapi.snapshot.json`; regenerate with
  `npm run entropy:openapi`.
* **Genesis** — `entropy/config/genesis.json` (validated by
  `genesis.schema.json`) pins seed/network/alloy for a deployment.
* **Addresses** — `POST /v1/chromium/derive-address { domain, label, sublabel }`
  derives any address without touching state; `GET /v1/addresses/{address}`
  reverses it.

---

## 15. Operations

| concern | knob |
|---|---|
| throughput | `ENTROPY_RATE_CAPACITY` (tokens) / `ENTROPY_RATE_REFILL` (per second); reads cost 1, writes cost 2, bucketed per subject (per IP when anonymous) |
| seal backlog | `ENTROPY_PENDING_TTL_MINUTES`, `GET /v1/pending/stats`, hourly sweep |
| world freshness | timers: world events 5 m, squad idle decay 15 m, memory consolidation 30 m |
| storage | `data/entropy/state/*.json` (atomic), `cas/` (content-addressed), `journal.jsonl` (append-only) |
| observability | `GET /v1/health` (chain, pool, vault bytes, RSS), `GET /v1/status` (every system), `GET /v1/journal`, SSE `http.response` events with `tookMs` |
| CORS | `ENTROPY_CORS_ORIGIN` (default `*`); `x-entropy-pending` is in the allowed-headers list, preflight answered with 204 |
| backup | copy `data/entropy/` (keep `keyring.json` secret) **or** re-genesis from `ENTROPY_GENESIS_SEED` + replay the journal |
| reset | delete `data/entropy/` — everything regenerates from the seed (addresses stay identical if the seed does) |

---

## 16. Production checklist

- [ ] `ENTROPY_MODE=prod` (closes open token issuance)
- [ ] `ENTROPY_MASTER_KEY` from a secrets manager; rotation plan = revocation plan
- [ ] `ENTROPY_GENESIS_SEED` pinned and backed up (it *is* the network identity)
- [ ] `ENTROPY_CORS_ORIGIN` narrowed to your origins
- [ ] rate limits tuned; 429 handled with backoff in every client
- [ ] one writer per `ENTROPY_DATA_DIR`; `app.close()` on SIGTERM
- [ ] journal shipped to your log store (`journal.jsonl` is the audit trail)
- [ ] SSE consumer registered for `pending.parked` → a human or bot reviews seals
- [ ] `verifyChain()` scheduled (`npm run entropy:verify`); alert on `valid:false`
- [ ] integration tokens are scoped per service; no shared sovereign token
- [ ] RLU never appears in a price, storefront or payout context — it is content
      accounting, and the API's `unit` card says so
- [ ] presence/coordinate handling respects the 25 m quantisation and the
      per-lobby consent flag in anything you render or log

### Common mistakes

| mistake | symptom | fix |
|---|---|---|
| treating 202 as success | the write never happened | check `meta.sealed` / `data.status === 'pending'` |
| re-posting a parked write | duplicate seals in the pool | track `sealId`; co-sign or void instead |
| requesting every scope | no extra authority, bigger blast radius | ask only for what the handler declares |
| hard-coding difficulty | `below_share_target` forever | read `GET /v1/miners/consensus` |
| resubmitting an expired job | `job_expired` / `stale_tip` | re-poll `work`, listen to SSE |
| mutating a stored block header | `verifyChain` → `hash_mismatch` | use `headerOf()`; derived data goes in new keys |
| two processes on one data dir | lost updates | one writer; others use HTTP |
| expecting missions to advance before accept | objectives stay at 0 | accept, then play |
| reading `recall` as a list | "why are unrelated traces here?" | it is a ranked score; filter by `score` or `kind` |

---

*See also:* [`../README.md`](../README.md) · [`MINING_STACK.md`](MINING_STACK.md) ·
[`../../ENTROPY_GENESIS_UNMASK.md`](../../ENTROPY_GENESIS_UNMASK.md).
