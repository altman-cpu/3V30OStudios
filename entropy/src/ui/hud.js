/* ═══════════════════════════════════════════════════════════════════════════
   ENTROPY HUD — browser client
   ───────────────────────────────────────────────────────────────────────────
   Vanilla JS, no build step, no dependencies. Talks to the same origin so it
   works behind any proxy (the preview host included).

   Structure:
     1. tiny helpers        (api(), escapeHtml(), dom(), toast())
     2. state + boot        (token, index, status, SSE stream)
     3. per-tab renderers   (overview, memory, weave, ar, squad, missions,
                             multiplayer, miners, pending, handlers)
     4. one delegated click handler → data-act actions

   Every response envelope carries meta.entropyAddress — the HUD shows it next
   to each card title so you can always see *which content handler* produced
   what you are looking at.
   ═══════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── 1. helpers ──────────────────────────────────────────────────────── */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const store = {
    get token() { return localStorage.getItem('entropy.token') || ''; },
    set token(v) { v ? localStorage.setItem('entropy.token', v) : localStorage.removeItem('entropy.token'); },
    get subject() { return localStorage.getItem('entropy.subject') || 'commander'; },
    set subject(v) { localStorage.setItem('entropy.subject', v); },
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const esc = escapeHtml;

  class ApiError extends Error {
    constructor(message, { code = null, detail = null, status = 0 } = {}) {
      super(message);
      this.code = code; this.detail = detail; this.status = status;
    }
  }

  /**
   * Call the Entropy API. Returns envelope.data and stashes envelope.meta on
   * the returned object when it is an object (as __meta) so cards can show the
   * handler address.
   */
  async function api(path, { method = 'GET', body = null, pending = null, raw = false } = {}) {
    const headers = {};
    if (store.token) headers.authorization = `Bearer ${store.token}`;
    if (body) headers['content-type'] = 'application/json';
    if (pending) headers['x-entropy-pending'] = pending; // force|never

    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (raw) return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };

    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { throw new ApiError(`non-JSON response (${res.status})`, { status: res.status }); }
    if (!res.ok || json?.ok === false) {
      const err = json?.error || { code: `http_${res.status}`, message: res.statusText || 'request failed' };
      throw new ApiError(err.message, { code: err.code, detail: err.detail, status: res.status });
    }
    const data = json.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      try { Object.defineProperty(data, '__meta', { value: json.meta, enumerable: false }); } catch { /* frozen */ }
    }
    if (data?.status === 'pending') onPendingSeal(data);
    return data;
  }

  function toast(kind, title, message) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<b>${esc(title)}</b><span>${esc(message)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 420); }, kind === 'err' ? 7000 : 4200);
  }

  function modal(title, contentHtml) {
    $('#modal-title').textContent = title;
    $('#modal-content').innerHTML = contentHtml;
    const dlg = $('#modal');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  const fmt = {
    num(n, digits = 0) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: digits }); },
    compact(n) {
      const abs = Math.abs(Number(n || 0));
      if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return Number(n || 0).toFixed(abs < 10 && abs % 1 !== 0 ? 2 : 0);
    },
    pct(n, digits = 0) { return `${(Number(n || 0) * 100).toFixed(digits)}%`; },
    time(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); },
    date(iso) { if (!iso) return '—'; return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); },
    ago(iso) {
      if (!iso) return '—';
      const sec = Math.round((Date.now() - Date.parse(iso)) / 1000);
      if (sec < 60) return `${sec}s ago`;
      if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
      return `${Math.round(sec / 86400)}d ago`;
    },
    short(addr, head = 12, tail = 6) {
      const s = String(addr || '—');
      return s.length > head + tail + 3 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
    },
  };

  const bar = (value01, label = '') => `<div class="bar" title="${esc(label)}"><i style="width:${Math.max(0, Math.min(100, Number(value01 || 0) * 100)).toFixed(1)}%"></i></div>`;

  function card({ title, kicker = '', addr = '', span = 12, note = '', body = '' }) {
    return `<article class="card span-${span}">
      <div class="card-head">
        ${kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''}
        <h2>${esc(title)}</h2>
        ${addr ? `<span class="addr copyable mono" data-act="copy" data-copy="${esc(addr)}" title="entropy address · click to copy">${esc(fmt.short(addr, 16, 8))}</span>` : ''}
      </div>
      ${note ? `<p class="card-note">${note}</p>` : ''}
      ${body}
    </article>`;
  }

  function tiles(items) {
    return `<div class="tiles">${items
      .map((t) => `<div class="tile ${t.tone || ''}"><span>${esc(t.label)}</span><b>${t.value}</b>${t.sub ? `<small>${esc(t.sub)}</small>` : ''}</div>`)
      .join('')}</div>`;
  }

  function rows(items) {
    if (!items.length) return `<p class="empty">Nothing here yet.</p>`;
    return `<div class="rows">${items.join('')}</div>`;
  }

  /* ── 2. state + boot ─────────────────────────────────────────────────── */

  const state = {
    tab: 'overview',
    index: null,
    status: null,
    me: null,
    handlers: null,
    profile: null,
    selectedAbilities: [],
    weavePreview: null,
    arLayers: ['scan', 'glyph', 'map'],
    arMode: 'deep',
    arScan: null,
    arTile: null,
    squadMode: 'raid',
    missionsBoard: null,
    lobbies: null,
    raids: null,
    chain: null,
    pool: null,
    wallet: null,
    library: null,
    seals: [],
    stream: null,
    feed: [],
    busy: false,
    lastHandlerAddress: null,
  };

  async function boot() {
    wireChrome();
    try {
      state.index = await api('/v1');
    } catch (err) {
      toast('err', 'api unreachable', err.message);
    }
    if (!store.token && state.index?.auth?.openTokenIssue) {
      await issueToken(store.subject, 'sovereign');
    }
    await refreshAll();
    openStream();
    setInterval(() => refreshVitals(), 15000);
  }

  function wireChrome() {
    $('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });
    document.addEventListener('click', onAction);
    $('#btn-clear-feed').addEventListener('click', () => { state.feed = []; renderFeed(); });
    $('#btn-token').addEventListener('click', () => issueTokenModal());
    $('#btn-refresh-token').addEventListener('click', () => issueToken(store.subject, state.me?.tier || 'operator'));
  }

  function switchTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-hidden', p.dataset.panel !== tab));
    renderTab(tab);
  }

  async function refreshAll() {
    renderChrome();
    await Promise.allSettled([refreshMe(), refreshVitals()]);
    renderTab(state.tab);
  }

  async function refreshMe() {
    if (!store.token) { state.me = null; return; }
    try {
      state.me = await api('/v1/auth/me');
    } catch (err) {
      state.me = null;
      if (err.code === 'token_expired' || err.code === 'token_signature') {
        store.token = '';
        toast('err', 'token rejected', `${err.code}: ${err.message}`);
      }
    }
    renderAuthority();
  }

  async function refreshVitals() {
    try {
      const [stats, pending] = await Promise.all([api('/v1/miners/stats'), api('/v1/pending/stats')]);
      $('#vital-height').textContent = fmt.num(stats.height);
      $('#vital-diff').textContent = `${stats.difficultyBits}b`;
      $('#vital-pending').textContent = fmt.num(pending.pending ?? 0);
      $('#vital-rlu').textContent = fmt.compact(stats.rluEmitted);
      const count = pending.pending ?? 0;
      $('#tab-pending-count').textContent = count ? `(${count})` : '';
      state.pendingStats = pending;
    } catch { /* vitals are best-effort */ }
    if (state.me) {
      $('#vital-rlu').textContent = fmt.compact(state.me.wallet?.rlu ?? 0);
    }
  }

  function renderAuthority() {
    const me = state.me;
    if (!me) {
      $('#auth-subject').textContent = 'anonymous';
      $('#auth-tier').textContent = 'no token';
      $('#auth-address').textContent = '—';
      $('#auth-smart').textContent = '0';
      $('#auth-smart-bar').style.width = '0%';
      $('#auth-expiry').textContent = 'issue a token to begin';
      return;
    }
    $('#auth-subject').textContent = me.subject;
    $('#auth-tier').textContent = `${me.tierLabel}${me.root ? ' · root' : ''}`;
    $('#auth-address').textContent = fmt.short(me.address, 10, 6);
    $('#auth-address').title = me.address;
    const live = me.smartValue?.live ?? 0;
    const base = me.smartValue?.base ?? 1;
    $('#auth-smart').textContent = `${fmt.num(live)} / ${fmt.num(base)}`;
    $('#auth-smart-bar').style.width = `${Math.min(100, (live / 3000) * 100).toFixed(1)}%`;
    $('#auth-expiry').textContent = `expires in ${Math.max(0, Math.round((me.expiresInMs || 0) / 60000))}m · decay ${fmt.pct(me.smartValue?.decay || 0, 0)} · credits ${fmt.num(me.entropyCredits)}`;
  }

  function renderChrome() {
    const idx = state.index;
    if (!idx) return;
    $('#brand-sub').textContent = `${idx.name} · v${idx.version} · ${idx.mode}`;
    $('#foot-alloy').textContent = `chromium ${idx.chromium.alloy} · ${idx.chromium.grade} · ${fmt.short(idx.chromium.address, 10, 6)}`;
    $('#foot-genesis').textContent = `genesis ${idx.genesis.seedFingerprint}`;
    $('#foot-genesis').title = idx.genesis.entropyPhrase;
    const systems = idx.systems || {};
    const total = Object.values(systems).reduce((sum, s) => sum + (s.profiles || s.blocks || s.lobbies || 0), 0);
    $('#foot-handlers').textContent = `mode ${idx.mode} · chain h${systems.miners?.height ?? 0} · ${fmt.num(total)} records`;
  }

  /* ── token issuance ──────────────────────────────────────────────────── */

  async function issueToken(subject, tier = 'operator', scopes = null) {
    const payload = { subject, tier };
    if (scopes) payload.scopes = scopes;
    try {
      const issued = await api('/v1/auth/token', { method: 'POST', body: payload });
      store.token = issued.token;
      store.subject = issued.claims.sub;
      toast('ok', 'key auth token issued', `${issued.claims.sub} · ${issued.claims.tier} · smart value ${fmt.num(issued.smartValue)}`);
      await refreshAll();
      return issued;
    } catch (err) {
      toast('err', 'token issue failed', `${err.code || ''} ${err.message}`.trim());
      return null;
    }
  }

  function issueTokenModal() {
    const tiers = ['guest', 'observer', 'operator', 'weaver', 'architect', 'sovereign'];
    modal('Issue a key auth token', `
      <div class="grid-form">
        <label class="field">subject<input id="tk-subject" value="${esc(store.subject)}" /></label>
        <label class="field">tier<select id="tk-tier">${tiers.map((t) => `<option value="${t}" ${t === (state.me?.tier || 'operator') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field">ttl seconds<input id="tk-ttl" type="number" value="43200" /></label>
      </div>
      <p class="hint">Smart value = 120·tierIndex·multiplier + 45·matchedScopes + 8·pendingBudget + 3·entropyCredits (+250 admin:root, +400 root). It decays with token age, so a stale key loses authority on its own.</p>
      <div class="btn-row" style="margin-top:.8rem">
        <button class="btn btn-primary" data-act="tk-all" type="button">issue with all scopes</button>
        <button class="btn" data-act="tk-read" type="button">read-only</button>
        <button class="btn" data-act="tk-player" type="button">player set</button>
        <button class="btn btn-ghost" data-act="tk-clear" type="button">clear token</button>
      </div>`);
  }

  /* ── SSE stream ──────────────────────────────────────────────────────── */

  function openStream() {
    try {
      const es = new EventSource('/v1/stream');
      state.stream = es;
      es.onopen = () => { $('#vital-stream').textContent = 'live'; $('#ticker-dot').classList.add('live'); $('.vital-live').classList.remove('is-off'); };
      es.onerror = () => { $('#vital-stream').textContent = 'retry'; $('#ticker-dot').classList.remove('live'); $('.vital-live').classList.add('is-off'); };
      const interesting = ['miners.block', 'miners.share', 'miners.retarget', 'weave.fused', 'weave.fracture', 'weave.unlocked', 'weave.ability.generated', 'pending.parked', 'pending.unmasked', 'pending.cosigned', 'memory.match', 'memory.profile.created', 'memory.consolidated', 'missions.completed', 'missions.worldEvent', 'missions.season.turn', 'multiplayer.lobby.created', 'multiplayer.lobby.joined', 'multiplayer.raid.created', 'multiplayer.raid.phase', 'multiplayer.raid.resolved', 'multiplayer.report', 'multiplayer.sanction', 'squad.recruited', 'squad.quirk', 'ar.scan', 'ar.anchor', 'chromium.alloy.changed'];
      for (const type of interesting) {
        es.addEventListener(type, (e) => {
          let payload = {};
          try { payload = JSON.parse(e.data).payload || {}; } catch { /* ignore */ }
          pushFeed(type, payload);
        });
      }
    } catch { /* SSE unsupported — HUD still works by polling */ }
  }

  function pushFeed(type, payload) {
    state.feed = [{ type, payload, at: new Date().toISOString() }, ...state.feed].slice(0, 60);
    renderFeed();
    const t = state.tab;
    if ((type.startsWith('miners') && t === 'miners') || (type.startsWith('pending') && t === 'pending') || (type.startsWith('weave') && t === 'weave') || (type.startsWith('memory') && t === 'memory') || (type.startsWith('multiplayer') && t === 'multiplayer') || (type.startsWith('missions') && t === 'missions') || (type.startsWith('squad') && t === 'squad') || (type.startsWith('ar') && t === 'ar')) {
      clearTimeout(state.feedDebounce);
      state.feedDebounce = setTimeout(() => renderTab(t), 700);
    }
    refreshVitals();
  }

  function renderFeed() {
    const feed = $('#feed');
    if (!state.feed.length) { feed.innerHTML = '<li><span>waiting for entropy…</span></li>'; return; }
    feed.innerHTML = state.feed
      .slice(0, 24)
      .map((e) => {
        const summary = summariseEvent(e.type, e.payload);
        return `<li><b>${esc(e.type.replace('.', '·'))}</b><span>${esc(summary)}</span><time>${fmt.time(e.at)}</time></li>`;
      })
      .join('');
  }

  function summariseEvent(type, p) {
    switch (type) {
      case 'miners.block': return `h${p.height} · ${p.realityCount} fragments · ${p.rlu} RLU · ${p.leadingZeroBits}b`;
      case 'miners.share': return `${p.bits} bits · pool ${p.shares}`;
      case 'miners.retarget': return `${p.fromBits}b → ${p.toBits}b (median ${p.medianSolveMs}ms)`;
      case 'weave.fused': return `${p.name} · ${p.outcome} · power ${p.power}`;
      case 'weave.fracture': return `${p.name} fractured · +${p.residue} residue`;
      case 'weave.ability.generated': return `${p.rarity} ${p.school} ability from mined reality`;
      case 'pending.parked': return `${p.kind} needs ${p.requiredSmartValue} (has ${p.offeredSmartValue})`;
      case 'pending.unmasked': return `${p.kind} unmasked by ${p.unmaskedBy}`;
      case 'memory.match': return `${p.result} · ${p.mode}`;
      case 'missions.completed': return `${p.title} +${p.rewardRlu} RLU`;
      case 'missions.worldEvent': return `${p.title} until ${fmt.time(p.endsAt)}`;
      case 'multiplayer.raid.resolved': return `${p.outcome} · performance ${fmt.pct(p.performance)}`;
      case 'squad.quirk': return `${p.name} → ${(p.quirks || []).join(', ')}`;
      case 'ar.scan': return `${p.mode} · ${p.contacts} contacts`;
      default: return p.address ? fmt.short(p.address, 10, 6) : '';
    }
  }

  /* ── pending seal handling ───────────────────────────────────────────── */

  function onPendingSeal(data) {
    toast('pending', 'parked in the unmask pool', `${data.kind} needs smart value ${fmt.num(data.requiredSmartValue)} — you offered ${fmt.num(data.offeredSmartValue)}. Seal ${fmt.short(data.sealId, 10, 6)}.`);
    if (state.tab === 'pending') renderTab('pending');
    refreshVitals();
  }

  function sealCard(seal) {
    const cls = seal.status === 'unmasked' ? 'unmasked' : ['expired', 'voided', 'failed'].includes(seal.status) ? seal.status : '';
    return `<div class="seal ${cls}">
      <div class="seal-head">
        <span class="chip chip-mono">${esc(seal.sealId)}</span>
        <b>${esc(seal.kind)}</b>
        <span class="chip ${seal.status === 'unmasked' ? 'chip-good' : seal.status === 'pending' ? 'chip-warn' : ''}">${esc(seal.status)}</span>
        <span class="spacer"></span>
        <span class="chip chip-mono copyable" data-act="copy" data-copy="${esc(seal.address || '')}">${esc(fmt.short(seal.address, 12, 6))}</span>
      </div>
      <div class="kv">
        <dt>required</dt><dd>${fmt.num(seal.requiredSmartValue)} smart value · ${seal.coSignRequired} signature(s)</dd>
        <dt>offered</dt><dd>${fmt.num(seal.offeredSmartValue)} (aggregate ${fmt.num(seal.aggregateSmartValue || seal.offeredSmartValue)})</dd>
        <dt>co-signs</dt><dd>${(seal.coSignatures || []).map((c) => `${esc(c.subject)}(${fmt.num(c.smartValue)})`).join(', ') || '—'}</dd>
        <dt>requester</dt><dd>${esc(seal.subject)} · ${esc(seal.tier || '—')}</dd>
        <dt>payload</dt><dd>${esc(JSON.stringify(seal.payloadPreview || seal.payload || {}).slice(0, 220))}</dd>
        <dt>expires</dt><dd>${fmt.date(seal.expiresAt)} (${fmt.ago(seal.createdAt)})</dd>
        ${seal.unmaskedBy ? `<dt>unmasked</dt><dd>${esc(seal.unmaskedBy)} · authority ${fmt.num(seal.unmaskAuthority)}</dd>` : ''}
      </div>
      ${seal.status === 'pending' ? `<div class="btn-row">
        <button class="btn btn-xs" data-act="seal-cosign" data-id="${esc(seal.sealId)}" type="button">co-sign</button>
        <button class="btn btn-xs btn-primary" data-act="seal-unmask" data-id="${esc(seal.sealId)}" type="button">genesis unmask</button>
        <button class="btn btn-xs btn-ghost" data-act="seal-void" data-id="${esc(seal.sealId)}" type="button">void</button>
        <button class="btn btn-xs btn-ghost" data-act="seal-detail" data-id="${esc(seal.sealId)}" type="button">detail</button>
      </div>` : ''}
    </div>`;
  }

  /* ── 3. tab renderers ────────────────────────────────────────────────── */

  async function renderTab(tab) {
    const panel = $(`#panel-${tab}`);
    if (!panel) return;
    panel.innerHTML = `<p class="empty">loading ${esc(tab)}…</p>`;
    try {
      const renderers = { overview: renderOverview, memory: renderMemory, weave: renderWeave, ar: renderAr, squad: renderSquad, missions: renderMissions, multiplayer: renderMultiplayer, miners: renderMiners, pending: renderPending, handlers: renderHandlers };
      panel.innerHTML = await renderers[tab]();
      if (tab === 'ar') loadAnchors();
      if (tab === 'multiplayer') loadRaids();
    } catch (err) {
      panel.innerHTML = card({ title: 'Handler error', body: `<p class="empty">${esc(err.code || '')} ${esc(err.message)}</p><p class="hint">${esc(typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail || {}))}</p>` });
    }
  }

  /* ── overview ────────────────────────────────────────────────────────── */

  async function renderOverview() {
    const [status, season] = await Promise.all([api('/v1/status'), api('/v1/missions/season')]);
    state.status = status;
    const s = status.systems;
    const addr = status.__meta?.entropyAddress;

    const authorityRows = Object.entries(status.pending || {}).map(([k, v]) => `<div class="row"><span class="row-title">${esc(k)}</span><span class="row-sub">${esc(JSON.stringify(v))}</span></div>`);

    return [
      card({
        kicker: 'network', title: 'Genesis Unmask — live state', addr, span: 12,
        note: `Season <b>${esc(season.season.seasonId)}</b> · ${esc(season.season.name)} · day ${season.season.dayOfSeason}/${season.seasonLengthDays || 28} · ${status.liveWorldEvents.length} world event(s) live. Every record below carries a checksummed entropy address.`,
        body: tiles([
          { label: 'chain height', value: fmt.num(s.miners.height), sub: `${s.miners.difficultyBits} bits · tip ${fmt.short(s.miners.tip, 10, 6)}` },
          { label: 'reality mined', value: fmt.compact(s.miners.rluEmitted), sub: `${s.miners.fragments} fragments · ${s.miners.artifactsMinted} artifacts`, tone: 'accent' },
          { label: 'profiles', value: fmt.num(s.memory.profiles), sub: `${s.memory.activeTraces} active traces · ${s.memory.totalWins} wins` },
          { label: 'abilities', value: fmt.num(s.weave.catalogSize), sub: `${s.weave.minedAbilities} from mining · ${s.weave.activeFusions} fusions` },
          { label: 'companions', value: fmt.num(s.squad.instances), sub: `avg bond ${s.squad.averageBond} · ${s.squad.sworn} sworn` },
          { label: 'missions done', value: fmt.num(s.missions.completed), sub: `${fmt.compact(s.missions.rluPaid)} RLU paid` },
          { label: 'lobbies open', value: fmt.num(s.multiplayer.openLobbies), sub: `avg safety ${s.multiplayer.averageSafety} · min ${s.multiplayer.minSafety}` },
          { label: 'pending seals', value: fmt.num(status.pending.pending ?? 0), sub: `${fmt.num(status.pending.unmasked ?? 0)} unmasked · ${fmt.num(status.pending.expired ?? 0)} expired`, tone: 'warn' },
          { label: 'your smart value', value: fmt.num(state.me?.smartValue?.live ?? 0), sub: `${state.me?.tierLabel || 'anonymous'} · credits ${fmt.num(state.me?.entropyCredits ?? 0)}`, tone: 'good' },
          { label: 'your rlu', value: fmt.compact(state.me?.wallet?.rlu ?? 0), sub: `lifetime ${fmt.compact(state.me?.wallet?.lifetimeRlu ?? 0)}` },
        ]),
      }),
      card({
        kicker: 'entropy chromium', title: 'Generated material', addr: status.__meta?.entropyAddress, span: 5,
        note: 'The bright premium theme is derived from the genesis seed — hue triad, glass, elevation, AR HUD spec and WCAG contrast checks. Nothing here is a hard-coded hex value.',
        body: `<div class="kv">
            <dt>alloy</dt><dd>${esc(state.index?.chromium?.alloy || '—')}</dd>
            <dt>address</dt><dd class="copyable" data-act="copy" data-copy="${esc(state.index?.chromium?.address || '')}">${esc(state.index?.chromium?.address || '—')}</dd>
            <dt>grade</dt><dd>${esc(state.index?.chromium?.grade || '—')}</dd>
            <dt>contrast</dt><dd>ink ${state.index?.chromium?.contrast?.inkOnPanel || '—'}:1 · accent ${state.index?.chromium?.contrast?.accentOnPanel || '—'}:1 · ${state.index?.chromium?.contrast?.aaa ? 'AAA' : state.index?.chromium?.contrast?.aa ? 'AA' : 'review'}</dd>
            <dt>css</dt><dd>/ui/chromium.css (generated per request)</dd>
          </div>
          <div class="btn-row" style="margin-top:.7rem">
            <button class="btn btn-xs" data-act="chromium-surface" data-surface="bright" type="button">bright</button>
            <button class="btn btn-xs" data-act="chromium-surface" data-surface="dusk" type="button">dusk</button>
            <button class="btn btn-xs" data-act="chromium-surface" data-surface="scan" type="button">scan glass</button>
            <button class="btn btn-xs btn-ghost" data-act="chromium-grade" type="button">cycle grade</button>
            <button class="btn btn-xs btn-ghost" data-act="open-css" type="button">view css</button>
          </div>`,
      }),
      card({
        kicker: 'authority', title: 'Smart value & the unmask pool', span: 7,
        note: 'Every gated write compares your <em>live</em> smart value against the operation risk. Below the bar, the effect is parked as a seal instead of mutating state.',
        body: `<div class="table-scroll"><table class="data">
            <thead><tr><th>risk</th><th class="num">required</th><th>you</th><th>label</th></tr></thead>
            <tbody>${Object.entries(state.me?.authority || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${fmt.num(v.required)}</td><td>${v.autoSeals ? '<span class="chip chip-good">auto-seals</span>' : '<span class="chip chip-warn">parks pending</span>'}</td><td>${esc(RISK_LABELS[k] || '')}</td></tr>`).join('')}</tbody>
          </table></div>
          <div class="btn-row" style="margin-top:.7rem">
            <button class="btn btn-xs" data-act="goto" data-tab="pending" type="button">open unmask pool</button>
            <button class="btn btn-xs btn-ghost" data-act="verify-token" type="button">verify token</button>
            <button class="btn btn-xs btn-ghost" data-act="show-journal" type="button">audit journal</button>
          </div>`,
      }),
      card({ kicker: 'world', title: 'Live world events', span: 6, body: rows(status.liveWorldEvents.map((e) => `<div class="row"><div><div class="row-title">${esc(e.title)}</div><div class="row-sub">${esc(e.text)}</div><div class="row-sub">modifier ${esc(e.modifier.kind)} × ${esc(e.modifier.value)} · ${esc(e.modifier.scope)}</div></div><div class="row-actions"><span class="chip chip-mono">${esc(fmt.short(e.address, 10, 6))}</span><span class="chip">until ${fmt.time(e.endsAt)}</span></div></div>`)) }),
      card({ kicker: 'cadence', title: 'Season progression', span: 6, body: seasonBody(season) }),
    ].join('');
  }

  /** Season tier ladder rows (browser-safe; no server modules in here). */
  function TIER_LADDER(season) {
    const tiers = (state.status?.season?.tiers) || (season.tiers) || [];
    const xp = season.xp || 0;
    if (!tiers.length) return '<tr><td colspan="5" class="empty">tier ladder unavailable</td></tr>';
    return tiers.map((t) => `<tr><td class="num">${t.tier}</td><td>${esc(t.name)}</td><td class="num">${fmt.num(t.atXp)}</td><td class="num">${fmt.num(t.rewardRlu)}</td><td>${xp >= t.atXp ? '<span class="chip chip-good">reached</span>' : `<span class="chip">${fmt.num(t.atXp - xp)} xp to go</span>`}</td></tr>`).join('');
  }

  const RISK_LABELS = { NONE: 'open / reads', LOW: 'profile-scoped writes', MEDIUM: 'shared-world writes', HIGH: 'economy, weave, raids', SEVERE: 'seasons, world events', GENESIS: 'keyring, network control' };
  function seasonBody(season) {
    const tiers = season.tiers || season.season?.tiers || [];
    return `<div class="kv">
        <dt>season</dt><dd>${esc(season.season?.seasonId || season.seasonId)} · ${esc(season.season?.name || season.name)}</dd>
        <dt>address</dt><dd class="copyable" data-act="copy" data-copy="${esc(season.season?.address || season.address || '')}">${esc(fmt.short(season.season?.address || season.address, 14, 8))}</dd>
        <dt>window</dt><dd>${fmt.date(season.season?.startsAt || season.startsAt)} → ${fmt.date(season.season?.endsAt || season.endsAt)}</dd>
        <dt>days left</dt><dd>${season.season?.daysRemaining ?? season.daysRemaining ?? '—'}</dd>
      </div>
      <p class="section-title" style="margin-top:.7rem">tiers</p>
      <div class="table-scroll"><table class="data"><thead><tr><th class="num">tier</th><th>name</th><th class="num">xp</th><th class="num">RLU</th></tr></thead>
      <tbody>${tiers.map((t) => `<tr><td class="num">${t.tier}</td><td>${esc(t.name)}</td><td class="num">${fmt.num(t.atXp)}</td><td class="num">${fmt.num(t.rewardRlu)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint" style="margin-top:.5rem">Season law (mined or derived): ${esc((season.season?.laws || season.laws || []).map((l) => l.text).join(' · ') || '—')}</p>`;
  }

  /* ── memory ──────────────────────────────────────────────────────────── */

  async function renderMemory() {
    const subject = state.me?.subject || store.subject;
    const [profile, tree, loadouts, companions, graph] = await Promise.all([
      api(`/v1/memory/${encodeURIComponent(subject)}`).catch(() => null),
      api(`/v1/memory/${encodeURIComponent(subject)}/skills`).catch(() => null),
      api(`/v1/memory/${encodeURIComponent(subject)}/loadouts`).catch(() => null),
      api(`/v1/memory/${encodeURIComponent(subject)}/companions`).catch(() => null),
      api(`/v1/memory/${encodeURIComponent(subject)}/graph`).catch(() => null),
    ]);
    state.profile = profile?.summary || null;
    const addr = profile?.summary?.address;

    const skillRows = (tree?.schools || []).map((school) => `
      <div class="row">
        <div style="min-width:9rem"><div class="row-title">${esc(school.school)}</div><div class="row-sub">L${school.level} · ${fmt.num(school.xp)} xp</div></div>
        <div style="flex:1;min-width:160px">
          ${school.skills.map((s) => `<div class="bar-label"><span>${esc(s.name)}</span><span>L${s.level} · ${fmt.num(s.xp)}/${fmt.num(s.nextLevelXp)}</span></div>${bar(s.nextLevelXp ? s.xp / s.nextLevelXp : 1, s.name)}`).join('')}
        </div>
      </div>`).join('');

    const loadoutRows = (loadouts?.loadouts || []).map((l) => `
      <div class="row ${loadouts.equipped === l.loadoutId ? 'is-selected' : ''}">
        <div style="min-width:11rem">
          <div class="row-title">${esc(l.name)} ${loadouts.equipped === l.loadoutId ? '<span class="chip chip-good">equipped</span>' : ''}</div>
          <div class="row-sub">${esc(l.address)}</div>
          <div class="row-sub">v${l.version} · W${l.record.wins}/L${l.record.losses}${l.record.raids ? `/R${l.record.raids}` : ''}</div>
        </div>
        <div class="pill-list">${Object.entries(l.slots || {}).map(([slot, value]) => `<span class="chip chip-mono" title="${esc(value)}">${esc(slot)}: ${esc(fmt.short(value, 14, 4))}</span>`).join('') || '<span class="chip">empty</span>'}</div>
        <div class="row-actions">
          <button class="btn btn-xs" data-act="equip-loadout" data-id="${esc(l.loadoutId)}" type="button">equip</button>
          <button class="btn btn-xs btn-ghost" data-act="copy" data-copy="${esc(l.address)}" type="button">copy addr</button>
        </div>
      </div>`).join('');

    const traceRows = (profile?.recentTraces || []).map((t) => `
      <div class="row">
        <div style="flex:1;min-width:14rem">
          <div class="row-title">${esc(t.kind)} · ${esc(t.text)}</div>
          <div class="row-sub">${esc(t.address)} · resonance ${t.resonance} · decay ${t.decayDays}d · accesses ${t.accesses}</div>
        </div>
        <div class="row-actions"><span class="chip chip-mono">${fmt.date(t.createdAt)}</span>
        <button class="btn btn-xs btn-danger" data-act="forget" data-id="${esc(t.traceId)}" type="button">forget</button></div>
      </div>`).join('');

    return [
      card({
        kicker: 'entropy memory', title: state.profile?.alias || subject, addr, span: 12,
        note: `Remembers skills, loadouts, wins and companion behaviours. Power level <b>${state.profile?.level ?? '—'}</b> · memory pressure <b>${fmt.pct(profile?.pressure ?? 0, 1)}</b> · signature <span class="code copyable" data-act="copy" data-copy="${esc(profile?.summary?.signature?.address || '')}">${esc(fmt.short(profile?.summary?.signature?.address, 14, 8))}</span>`,
        body: `${tiles([
          { label: 'wins', value: fmt.num(state.profile?.record?.wins ?? 0), sub: `losses ${state.profile?.record?.losses ?? 0} · draws ${state.profile?.record?.draws ?? 0}`, tone: 'good' },
          { label: 'streak', value: fmt.num(state.profile?.record?.streak?.current ?? 0), sub: `best ${state.profile?.record?.streak?.best ?? 0}` },
          { label: 'raids', value: fmt.num(state.profile?.record?.raidsCompleted ?? 0), sub: `failed ${state.profile?.record?.raidsFailed ?? 0}` },
          { label: 'seals unmasked', value: fmt.num(state.profile?.record?.sealsUnmasked ?? 0), sub: 'authority exercised' },
          { label: 'blocks mined', value: fmt.num(state.profile?.record?.realityMined ?? 0), sub: `${fmt.compact(state.profile?.record?.rluLifetime ?? 0)} RLU lifetime` },
          { label: 'loadouts', value: fmt.num(loadouts?.loadouts?.length ?? 0), sub: `companions ${companions?.count ?? 0}` },
        ])}
        <hr class="rule" />
        <div class="btn-row">
          <button class="btn btn-primary btn-xs" data-act="mem-match-win" type="button">record win</button>
          <button class="btn btn-xs" data-act="mem-match-loss" type="button">record loss</button>
          <button class="btn btn-xs" data-act="mem-consolidate" type="button">consolidate</button>
          <button class="btn btn-xs btn-ghost" data-act="mem-export" type="button">export bundle</button>
          <button class="btn btn-xs btn-ghost" data-act="mem-import" type="button">import bundle</button>
        </div>
        <div class="grid-form" style="margin-top:.7rem">
          <label class="field">loadout name<input id="lo-name" placeholder="Night Gate" /></label>
          <label class="field">core<input id="lo-core" placeholder="aegis-lattice" /></label>
          <label class="field">offhand<input id="lo-offhand" placeholder="tidal-step" /></label>
          <label class="field">visor<input id="lo-visor" placeholder="prism-lash" /></label>
          <label class="field">tether<input id="lo-tether" placeholder="EX-ART-…" /></label>
          <label class="field">sigil<input id="lo-sigil" placeholder="glyph address" /></label>
          <button class="btn" data-act="save-loadout" type="button">save loadout</button>
        </div>`,
      }),
      card({ kicker: 'skills', title: 'Skill tree', addr: tree?.address, span: 7, note: 'Outcome-weighted xp: win 45 · raid 60 · teach 30 · draw 22 · loss 14 · use 8 · fail 5.', body: rows(skillRows ? [skillRows] : []) }),
      card({
        kicker: 'recall', title: 'Remember & recall', span: 5,
        note: 'Recall is scored: 0.45·keyword + 0.25·recency + 0.20·resonance + 0.10·access. Recalling strengthens a trace (spacing effect).',
        body: `<div class="grid-form">
            <label class="field">trace kind<input id="tr-kind" value="note" /></label>
            <label class="field">resonance<input id="tr-res" type="number" step="0.1" value="1.2" /></label>
            <label class="field">decay days<input id="tr-decay" type="number" value="60" /></label>
          </div>
          <label class="field" style="margin-top:.5rem">text<textarea id="tr-text" placeholder="Switched to the tidal build for night raids — held the gate twice."></textarea></label>
          <label class="field" style="margin-top:.5rem">tags (comma separated)<input id="tr-tags" placeholder="loadout,tidal,raid" /></label>
          <div class="btn-row" style="margin-top:.6rem"><button class="btn btn-primary btn-xs" data-act="remember" type="button">remember</button></div>
          <hr class="rule" />
          <label class="field">recall query<input id="rc-query" placeholder="gate" /></label>
          <div class="btn-row" style="margin-top:.5rem"><button class="btn btn-xs" data-act="recall" type="button">recall</button><button class="btn btn-xs btn-ghost" data-act="recall-all" type="button">recent traces</button></div>
          <div id="recall-out" class="rows" style="margin-top:.6rem"></div>`,
      }),
      card({ kicker: 'loadouts', title: 'Builds & their record', addr: loadouts?.address, span: 7, body: rows(loadoutRows ? [loadoutRows] : []) }),
      card({ kicker: 'companions', title: 'Companion behaviour memory', addr: companions?.address, span: 5, body: rows((companions?.companions || []).map((c) => `<div class="row"><div><div class="row-title">${esc(c.companionId)}</div><div class="row-sub">bond ${c.bond} · ${c.matches} matches · win rate ${fmt.pct(c.winRate, 0)}</div><div class="row-sub">prefers ${esc(c.preferredTactic)} · ${(c.quirks || []).map((q) => esc(q.id)).join(', ') || 'no quirks yet'}</div></div><div class="row-actions"><span class="chip chip-mono copyable" data-act="copy" data-copy="${esc(c.address || '')}">${esc(fmt.short(c.address, 10, 6))}</span></div></div>`)) }),
      card({ kicker: 'traces', title: 'Recent memory traces', span: 8, body: rows(traceRows ? [traceRows] : []) }),
      card({ kicker: 'constellation', title: 'Memory graph', addr: graph?.address, span: 4, body: graphSvg(graph) }),
    ].join('');
  }

  function graphSvg(graph) {
    if (!graph?.nodes?.length) return '<p class="empty">No memory yet.</p>';
    const w = 360; const h = 300; const cx = w / 2; const cy = h / 2;
    const nodes = graph.nodes.slice(0, 34);
    const positions = nodes.map((n, i) => {
      if (i === 0) return { ...n, x: cx, y: cy };
      const ring = i % 3;
      const angle = (i / nodes.length) * Math.PI * 2;
      const radius = 60 + ring * 42;
      return { ...n, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.78 };
    });
    const byId = Object.fromEntries(positions.map((p) => [p.id, p]));
    const edges = (graph.edges || []).filter((e) => byId[e.from] && byId[e.to]).map((e) => `<line x1="${byId[e.from].x.toFixed(1)}" y1="${byId[e.from].y.toFixed(1)}" x2="${byId[e.to].x.toFixed(1)}" y2="${byId[e.to].y.toFixed(1)}" stroke="var(--accent)" stroke-opacity="0.22" stroke-width="1"/>`).join('');
    const kinds = { profile: 'var(--accent)', skill: 'var(--accent-2)', loadout: 'var(--accent-3)', companion: 'var(--success)', win: 'var(--warning)' };
    const dots = positions.map((p, i) => `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === 0 ? 9 : 3 + (p.weight || 0.2) * 6}" fill="${kinds[p.kind] || 'var(--muted)'}" fill-opacity="${i === 0 ? 1 : 0.85}"><title>${esc(p.kind)}: ${esc(p.label)}\n${esc(p.address || '')}</title></circle></g>`).join('');
    return `<div class="ar-frame"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="memory constellation">${edges}${dots}</svg></div>
      <p class="hint">${nodes.length} nodes · ${graph.edges?.length || 0} edges · pressure ${fmt.pct(graph.pressure, 1)}</p>`;
  }

  /* ── weave ───────────────────────────────────────────────────────────── */

  async function renderWeave() {
    const subject = state.me?.subject || store.subject;
    const [catalog, holdings, recipes, schools, stats] = await Promise.all([
      api('/v1/weave/catalog'),
      api(`/v1/weave/holdings/${encodeURIComponent(subject)}`).catch(() => null),
      api('/v1/weave/recipes'),
      api('/v1/weave/schools'),
      api('/v1/weave/stats'),
    ]);
    state.weaveCatalog = catalog;
    state.weaveHoldings = holdings;
    const owned = new Set((holdings?.abilities || []).map((h) => h.abilityId));
    const selected = state.selectedAbilities.filter((id) => catalog.abilities.some((a) => a.id === id));
    state.selectedAbilities = selected;

    const abilityChips = catalog.abilities.map((a) => {
      const isSel = selected.includes(a.id);
      const canOwn = owned.has(a.id);
      return `<div class="row ${isSel ? 'is-selected' : ''}" data-ability="${esc(a.id)}">
        <div style="min-width:12rem">
          <div class="row-title">${esc(a.glyph)} ${esc(a.name)} <span class="chip ${canOwn ? 'chip-good' : ''}">${canOwn ? 'unlocked' : `${a.costRlu} RLU`}</span> ${a.origin === 'mined' ? '<span class="chip chip-warn">mined</span>' : ''}</div>
          <div class="row-sub">${esc(a.schoolLabel)} · tier ${a.tier} · power ${a.power} · stability ${a.stability} · resonance ${a.resonance}</div>
          <div class="row-sub">${esc(fmt.short(a.address, 14, 8))}${a.sourceFragment ? ` · from ${esc(fmt.short(a.sourceFragment, 10, 6))}` : ''}</div>
        </div>
        <div style="flex:1;min-width:120px">${bar(a.stability / 100, 'stability')}<div class="bar-label"><span>stability</span><span>${a.stability}</span></div></div>
        <div class="row-actions">
          <button class="btn btn-xs ${isSel ? 'btn-primary' : ''}" data-act="weave-select" data-id="${esc(a.id)}" type="button" ${!canOwn ? 'disabled title="unlock first"' : ''}>${isSel ? 'remove' : 'select'}</button>
          ${canOwn ? '' : `<button class="btn btn-xs" data-act="weave-unlock" data-id="${esc(a.id)}" type="button">unlock</button>`}
        </div>
      </div>`;
    }).join('');

    const fusionRows = (holdings?.fusions || []).map((f) => `
      <div class="row">
        <div style="min-width:13rem">
          <div class="row-title">${esc(f.name)} <span class="chip ${f.outcome === 'stable' ? 'chip-good' : 'chip-warn'}">${esc(f.outcome)}</span></div>
          <div class="row-sub">${esc(f.components.join(' + '))}</div>
          <div class="row-sub">${esc(f.address)}</div>
        </div>
        <div style="flex:1;min-width:140px">
          <div class="bar-label"><span>power ${f.power}</span><span>stability ${f.stability}</span></div>
          ${bar(f.stability / 100, 'stability')}
          <div class="row-sub">resonance ${f.resonance} · uses ${f.uses}${f.durability !== null && f.durability !== undefined ? ` · durability ${f.durability}/${f.maxDurability}` : ''}</div>
        </div>
        <div class="row-actions">
          <button class="btn btn-xs" data-act="fusion-use" data-id="${esc(f.fusionId)}" type="button">use</button>
          <button class="btn btn-xs btn-ghost" data-act="fusion-unweave" data-id="${esc(f.fusionId)}" type="button">unweave</button>
        </div>
      </div>`).join('');

    return [
      card({
        kicker: 'power weaving', title: 'Unlock & combine custom abilities', addr: catalog.__meta?.entropyAddress, span: 12,
        note: `${stats.catalogSize} abilities (${stats.minedAbilities} generated from mined reality) · ${stats.unlocks} unlocks · ${stats.activeFusions} active fusions · ${stats.fractures} fractures · ${stats.recipes} proven recipes.`,
        body: tiles([
          { label: 'your residue', value: fmt.num(holdings?.residue ?? 0, 2), sub: 'from fractures & unweaves', tone: 'warn' },
          { label: 'your abilities', value: fmt.num(holdings?.count ?? 0), sub: `${(holdings?.fusions || []).length} fusions` },
          { label: 'selected', value: `${selected.length} / 4`, sub: selected.join(' + ') || 'pick 2–4 unlocked abilities' },
          { label: 'max components', value: '4', sub: 'size bonus +0.18 per extra, stability −11' },
        ]),
      }),
      card({
        kicker: 'loom', title: 'Weave loom', span: 5,
        note: 'Analyse first: the maths is shown before anything is spent. Fusing is HIGH risk, so an under-authorised token parks it as a pending seal.',
        body: `${state.weavePreview ? previewBody(state.weavePreview) : '<p class="empty">Select 2–4 unlocked abilities to analyse a fusion.</p>'}
          <div class="btn-row" style="margin-top:.7rem">
            <button class="btn btn-xs" data-act="weave-analyze" type="button" ${selected.length < 2 ? 'disabled' : ''}>analyse</button>
            <button class="btn btn-xs btn-primary" data-act="weave-fuse" type="button" ${selected.length < 2 ? 'disabled' : ''}>weave (commit)</button>
            <button class="btn btn-xs btn-ghost" data-act="weave-fuse-pending" type="button" ${selected.length < 2 ? 'disabled' : ''}>force pending</button>
            <button class="btn btn-xs btn-ghost" data-act="weave-clear" type="button">clear</button>
          </div>
          <hr class="rule" />
          <p class="section-title">synergy matrix</p>
          ${synergyTable(schools.matrix, schools.schools)}`,
      }),
      card({ kicker: 'fusions', title: 'Your woven abilities', span: 7, body: rows(fusionRows ? [fusionRows] : []) }),
      card({ kicker: 'catalog', title: 'Ability catalog', span: 8, note: 'Artifact fragments mined from the reality chain are converted into weaveable abilities automatically.', body: `<div class="scroll-y rows">${abilityChips || '<p class="empty">Catalog empty.</p>'}</div>` }),
      card({
        kicker: 'recipes', title: 'Proven recipes', span: 4,
        body: `<div class="scroll-y rows">${(recipes.recipes || []).map((r) => `<div class="row"><div><div class="row-title">${esc(r.name)}</div><div class="row-sub">${esc(r.componentNames.join(' + '))}</div><div class="row-sub">×${r.count} · best power ${r.bestPower} · best stability ${r.bestStability}</div></div></div>`).join('') || '<p class="empty">No fusions landed yet.</p>'}</div>`,
      }),
    ].join('');
  }

  function previewBody(p) {
    if (p.error) return `<p class="empty">${esc(p.error)}</p>`;
    const r = p.result;
    const tone = r.outcome === 'stable' ? 'chip-good' : r.outcome === 'volatile' ? 'chip-warn' : 'chip-bad';
    return `<div class="kv">
        <dt>name</dt><dd>${esc(p.name)}</dd>
        <dt>address</dt><dd>${esc(p.address)}</dd>
        <dt>codeword</dt><dd>${esc(p.codeword)}</dd>
        <dt>components</dt><dd>${p.components.map((c) => `${esc(c.name)} (${esc(c.school)})`).join(' + ')}</dd>
        <dt>pairs</dt><dd>${p.pairs.map((pair) => `${esc(pair.schools.join('/'))}: ${pair.synergy > 0 ? '+' : ''}${pair.synergy} ${pair.verdict}`).join(' · ')}</dd>
        <dt>maths</dt><dd>raw ${p.metrics.rawPower} × (1 + ${p.metrics.pairBoost}) × size ${p.metrics.sizeFactor} = ${fmt.num(r.preOutcomePower, 1)}</dd>
        <dt>stability</dt><dd>mean ${p.metrics.meanStability} − 11·(n−2) − 26·${p.metrics.incompatiblePairs} + 0.35·weaveHand(${p.metrics.weaveHandLevel}) + resonance ${p.metrics.resonanceBonus} = ${r.stability}</dd>
      </div>
      <div class="tiles" style="margin-top:.6rem">
        <div class="tile accent"><span>power</span><b>${fmt.num(r.power, 1)}</b><small>${r.outcome === 'fracture' ? 'lost to fracture' : `${fmt.pct(r.outcome === 'stable' ? 1 : 0.85)} of raw`}</small></div>
        <div class="tile"><span>stability</span><b>${r.stability}</b><small>${esc(r.outcomeNote)}</small></div>
        <div class="tile"><span>resonance</span><b>${r.resonance}</b><small>harmony ${p.metrics.harmony}</small></div>
        <div class="tile ${r.outcome === 'fracture' ? 'warn' : 'good'}"><span>outcome</span><b><span class="chip ${tone}">${esc(r.outcome)}</span></b><small>${r.outcome === 'fracture' ? `+${r.residueOnFracture} residue` : r.durability ? `durability ${r.durability}` : 'no decay'}</small></div>
      </div>`;
  }

  function synergyTable(matrix, schools) {
    const ids = schools.map((s) => s.id);
    return `<div class="table-scroll"><table class="data"><thead><tr><th></th>${ids.map((id) => `<th class="num" title="${esc(schools.find((s) => s.id === id).note)}">${esc(id.slice(0, 4))}</th>`).join('')}</tr></thead>
      <tbody>${ids.map((a) => `<tr><th>${esc(a)}</th>${ids.map((b) => {
        const v = matrix[a]?.[b] ?? 0;
        const tone = v >= 0.3 ? 'chip-good' : v <= -0.2 ? 'chip-bad' : '';
        return `<td class="num">${tone ? `<span class="chip ${tone}">${v > 0 ? '+' : ''}${v}</span>` : `${v > 0 ? '+' : ''}${v}`}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /* ── AR ──────────────────────────────────────────────────────────────── */

  async function renderAr() {
    const [layers] = await Promise.all([api('/v1/ar/layers')]);
    state.arLayersDef = layers;
    const scan = state.arScan;
    const tile = state.arTile;

    return [
      card({
        kicker: 'ar overlay', title: 'Scanning, missions & map layers', addr: layers.alloy?.address, span: 12,
        note: `Alloy <b>${esc(layers.alloy?.label || '—')}</b> · privacy cell <b>${layers.privacy.positionCellMeters} m</b> · ${esc(layers.privacy.note)}`,
        body: `<div class="grid-form">
            <label class="field">scan mode<select id="ar-mode">${Object.entries(layers.scanModes).map(([id, m]) => `<option value="${id}" ${id === state.arMode ? 'selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('')}</select></label>
            <label class="field">x<input id="ar-x" type="number" value="${scan?.location?.x ?? 120}" /></label>
            <label class="field">y<input id="ar-y" type="number" value="${scan?.location?.y ?? -40}" /></label>
            <label class="field">z<input id="ar-z" type="number" value="${scan?.location?.z ?? 8}" /></label>
            <button class="btn btn-primary" data-act="ar-scan" type="button">run scan</button>
            <button class="btn btn-ghost" data-act="ar-overlay" type="button">open overlay svg</button>
          </div>
          <div class="pill-list" style="margin-top:.7rem">
            ${layers.layers.map((l) => `<label class="layer-toggle ${state.arLayers.includes(l.id) ? 'on' : ''}" style="border-color:${esc(l.tint)}55">
              <input type="checkbox" data-act="ar-layer" data-layer="${esc(l.id)}" ${state.arLayers.includes(l.id) ? 'checked' : ''} />
              <span style="width:8px;height:8px;border-radius:2px;background:${esc(l.tint)};display:inline-block"></span>${esc(l.label)}
            </label>`).join('')}
          </div>`,
      }),
      card({
        kicker: 'hud', title: 'Overlay frame', span: 7,
        note: 'Generated server-side from the chromium alloy: reticle, sweep, contact markers and layer legend. Composite it over a camera feed or use it as the browser HUD.',
        body: `<div class="ar-frame" id="ar-frame">
            <img alt="AR overlay" src="/v1/ar/overlay.svg?mode=${esc(state.arMode)}&layers=${esc(state.arLayers.join(','))}&w=960&h=420&title=ENTROPY%20SCAN" />
            <span class="scanline"></span>
          </div>
          <div class="btn-row" style="margin-top:.6rem">
            <button class="btn btn-xs" data-act="ar-refresh-overlay" type="button">re-render</button>
            <button class="btn btn-xs btn-ghost" data-act="copy" data-copy="/v1/ar/overlay.svg?mode=${esc(state.arMode)}&layers=${esc(state.arLayers.join(','))}" type="button">copy url</button>
          </div>`,
      }),
      card({
        kicker: 'contacts', title: scan ? `Scan ${fmt.short(scan.scanId, 10, 6)} · ${scan.contactCount} contacts` : 'Contacts', addr: scan?.address, span: 5,
        note: scan ? `${esc(scan.modeLabel)} · location ${scan.location.x}/${scan.location.y}/${scan.location.z} (quantised) · next scan ${fmt.time(scan.nextScanAt)} · plate <span class="code">${esc(fmt.short(scan.chromePlate, 16, 6))}</span>` : 'Run a scan to pull contacts from mined reality, live objectives and consented party presence.',
        body: `<div class="scroll-y rows">${(scan?.contacts || []).map((c) => `
            <div class="row">
              <div style="flex:1;min-width:12rem">
                <div class="row-title">${esc(c.label)} <span class="chip badge-rarity-${esc(c.rarity || 'common')}">${esc(c.rarity || c.kind)}</span></div>
                <div class="row-sub">${esc(c.detail || '')}</div>
                <div class="row-sub">${esc(c.layer)} · ${c.distanceM ?? '?'}m · confidence ${c.confidence ?? '—'} · ${esc(fmt.short(c.address, 12, 6))}</div>
              </div>
              <div class="row-actions"><button class="btn btn-xs btn-ghost" data-act="anchor-from-contact" data-label="${esc(c.label)}" data-layer="${esc(c.layer)}" data-addr="${esc(c.address)}" type="button">pin</button></div>
            </div>`).join('') || '<p class="empty">No contacts yet.</p>'}</div>`,
      }),
      card({
        kicker: 'map', title: 'Tile heightfield', addr: tile?.address, span: 5,
        note: tile ? `${esc(tile.biome)} · hazard ${tile.hazard} · cover ${tile.cover}${tile.sourceFragment ? ` · shaped by ${esc(fmt.short(tile.sourceFragment, 12, 6))}` : ' · derived from tile key'}` : 'Mining terrain fragments literally shapes the map.',
        body: tile ? heatGrid(tile.heightfield) + `<div class="rows" style="margin-top:.6rem">${(tile.markers || []).slice(0, 6).map((m) => `<div class="row"><div><div class="row-title">${esc(m.label)}</div><div class="row-sub">${esc(m.layer)} · ${esc(m.kind)} · ${esc(fmt.short(m.address, 12, 6))}</div></div></div>`).join('')}</div>` : '<p class="empty">Load a tile.</p>',
      }),
      card({
        kicker: 'anchors', title: 'World anchors', span: 7,
        note: 'Pinning is MEDIUM risk. Visibility defaults to party; positions are quantised before storage.',
        body: `<div class="grid-form">
            <label class="field">label<input id="an-label" placeholder="Meet at the arch" /></label>
            <label class="field">layer<select id="an-layer">${(state.arLayersDef?.layers || []).map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('')}</select></label>
            <label class="field">visibility<select id="an-vis"><option value="party">party</option><option value="public">public</option><option value="private">private</option></select></label>
            <label class="field">ttl minutes<input id="an-ttl" type="number" value="240" /></label>
            <button class="btn" data-act="anchor-create" type="button">pin anchor</button>
          </div>
          <div class="scroll-y rows" style="margin-top:.7rem" id="anchor-list"><p class="empty">loading…</p></div>`,
      }),
    ].join('');
  }

  function heatGrid(field) {
    if (!field?.length) return '<p class="empty">No heightfield.</p>';
    const cols = field[0].length;
    return `<div class="heat" style="grid-template-columns:repeat(${cols},1fr)">${field
      .map((row) => row.map((v) => `<div style="background:color-mix(in srgb, var(--accent) ${(v * 100).toFixed(0)}%, var(--panel-alt))" title="${v}"></div>`).join(''))
      .join('')}</div>`;
  }

  async function loadAnchors() {
    const list = $('#anchor-list');
    if (!list) return;
    try {
      const data = await api('/v1/ar/anchors');
      list.innerHTML = (data.anchors || []).map((a) => `<div class="row">
          <div style="flex:1;min-width:12rem"><div class="row-title">${esc(a.label)}</div>
          <div class="row-sub">${esc(a.layer)} · ${esc(a.visibility)} · owner ${esc(a.owner)} · expires ${fmt.date(a.expiresAt)}</div>
          <div class="row-sub">${esc(a.address)}</div></div>
          <div class="row-actions"><button class="btn btn-xs btn-danger" data-act="anchor-remove" data-id="${esc(a.anchorId)}" type="button">remove</button></div>
        </div>`).join('') || '<p class="empty">No live anchors.</p>';
    } catch (err) { list.innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
  }

  /* ── squad ───────────────────────────────────────────────────────────── */

  async function renderSquad() {
    const subject = state.me?.subject || store.subject;
    const [roster, companions, briefing, tactics] = await Promise.all([
      api('/v1/squad/roster'),
      api(`/v1/squad/${encodeURIComponent(subject)}/companions`).catch(() => ({ companions: [], briefing: null })),
      api(`/v1/squad/${encodeURIComponent(subject)}/briefing`).catch(() => null),
      api('/v1/squad/tactics'),
    ]);
    state.roster = roster;
    const owned = new Set((companions.companions || []).map((c) => c.companionId));

    return [
      card({
        kicker: 'squad ai', title: 'Companions that learn your tactics', addr: companions.__meta?.entropyAddress, span: 12,
        note: `EWMA learner: α=${roster.learning.alpha}, outcome signal +1/−0.45, quirk thresholds at ${roster.learning.quirkMinMatches} matches and a ${roster.learning.quirkGapThreshold} weight gap. Confidence is shown so you can tell a guess from a learned behaviour.`,
        body: tiles([
          { label: 'roster', value: fmt.num(roster.count), sub: `${roster.roles.length} roles · seed-generated` },
          { label: 'your bench', value: fmt.num(companions.companions?.length ?? 0), sub: `${[...owned].length} recruited` },
          { label: 'avg confidence', value: fmt.pct((companions.companions || []).reduce((s, c) => s + (c.confidence || 0), 0) / Math.max(1, companions.companions?.length || 1), 0), sub: `${roster.learning.confidenceSampleTarget} matches to full` },
          { label: 'quirks surfaced', value: fmt.num((companions.companions || []).reduce((s, c) => s + (c.quirks?.length || 0), 0)), sub: 'emergent behaviour' },
        ]),
      }),
      card({
        kicker: 'briefing', title: 'What the squad learned about you', span: 6,
        body: `<div>${(briefing?.lines || []).map((l) => `<p class="brief-line">${esc(l)}</p>`).join('') || '<p class="empty">Recruit a companion to start learning.</p>'}</div>
          <div class="btn-row" style="margin-top:.7rem">
            <button class="btn btn-xs btn-primary" data-act="squad-recommend" type="button">recommend squad (${esc(state.squadMode)})</button>
            <select id="sq-mode" class="btn btn-ghost btn-xs" style="width:auto">${['skirmish', 'raid', 'scan', 'defense', 'escort'].map((m) => `<option value="${m}" ${m === state.squadMode ? 'selected' : ''}>${m}</option>`).join('')}</select>
            <button class="btn btn-xs btn-ghost" data-act="squad-banter" type="button">banter</button>
          </div>
          <div id="squad-out" style="margin-top:.7rem"></div>`,
      }),
      card({
        kicker: 'bench', title: 'Your companions', span: 6,
        body: rows((companions.companions || []).map((c) => `
          <div class="row">
            <div style="min-width:13rem">
              <div class="row-title">${esc(c.name)} <span class="chip">${esc(c.archetype?.roleLabel || c.role)}</span> <span class="chip ${c.bond >= 80 ? 'chip-good' : ''}">${esc(c.bondLabel)} ${c.bond}</span></div>
              <div class="row-sub">${esc(c.archetype?.traits?.join(' · ') || '')} · ${esc(c.archetype?.voice || '')}</div>
              <div class="row-sub">prefers <b>${esc(c.preferredTactic)}</b> · confidence ${fmt.pct(c.confidence, 0)} · ${c.matches} matches · W${c.wins}/L${c.losses}</div>
              <div class="row-sub">${esc(fmt.short(c.address, 14, 8))}</div>
            </div>
            <div style="flex:1;min-width:150px">
              ${c.weights.slice(0, 5).map((w) => `<div class="bar-label"><span>${esc(w.tactic)}</span><span>${w.value}</span></div>${bar((w.value + 1) / 2, w.tactic)}`).join('')}
            </div>
            <div class="row-actions">
              <select data-role="drill-tactic" data-companion="${esc(c.companionId)}" class="btn btn-xs btn-ghost" style="width:auto">${tactics.tactics.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select>
              <button class="btn btn-xs" data-act="squad-drill" data-id="${esc(c.companionId)}" type="button">drill</button>
              <button class="btn btn-xs btn-ghost" data-act="squad-model" data-id="${esc(c.companionId)}" type="button">model</button>
              <button class="btn btn-xs btn-ghost" data-act="squad-banter-one" data-id="${esc(c.companionId)}" type="button">talk</button>
            </div>
          </div>
          ${(c.quirks || []).length ? `<div class="pill-list" style="margin:-.2rem 0 .2rem .2rem">${c.quirks.map((q) => `<span class="chip chip-warn" title="${esc(q.note)}">${esc(q.label)}</span>`).join('')}</div>` : ''}`))
      }),
      card({
        kicker: 'roster', title: 'Available companions', span: 12,
        note: 'Generated from the network seed — same seed, same companions on every node.',
        body: `<div class="scroll-y rows">${roster.companions.map((c) => `
          <div class="row">
            <div style="min-width:14rem">
              <div class="row-title">${esc(c.glyph)} ${esc(c.name)} <span class="chip">${esc(c.callsign)}</span> <span class="chip chip-tier">${esc(c.roleLabel)}</span></div>
              <div class="row-sub">${esc(c.traits.join(' · '))} · ${esc(c.voice)}</div>
              <div class="row-sub">affinity: ${c.topAffinities.map((t) => `${esc(t.id)} ${t.value}`).join(' · ')}</div>
              <div class="row-sub">${esc(c.address)}</div>
            </div>
            <div class="row-actions">${owned.has(c.companionId) ? '<span class="chip chip-good">on your bench</span>' : `<button class="btn btn-xs btn-primary" data-act="squad-recruit" data-id="${esc(c.companionId)}" type="button">recruit</button>`}</div>
          </div>`).join('')}</div>`,
      }),
    ].join('');
  }

  /* ── missions ────────────────────────────────────────────────────────── */

  async function renderMissions() {
    const subject = state.me?.subject || store.subject;
    const [board, events, season, leaderboard] = await Promise.all([
      api(`/v1/missions/board/${encodeURIComponent(subject)}`),
      api('/v1/missions/events'),
      api(`/v1/missions/season/${encodeURIComponent(subject)}`),
      api('/v1/missions/leaderboard'),
    ]);
    state.missionsBoard = board;

    const missionRow = (m) => `
      <div class="row ${m.status === 'ready' ? 'is-selected' : ''}">
        <div style="min-width:15rem">
          <div class="row-title">${esc(m.title)} <span class="chip">${esc(m.cadence)}</span> <span class="chip ${m.status === 'completed' ? 'chip-good' : m.status === 'ready' ? 'chip-warn' : ''}">${esc(m.status)}</span></div>
          <div class="row-sub">${esc(m.brief)}</div>
          <div class="row-sub">${esc(m.address)} · difficulty ${m.difficulty} · expires ${fmt.date(m.expiresAt)}</div>
        </div>
        <div style="flex:1;min-width:150px">
          ${m.objectives.map((o) => `<div class="bar-label"><span>${esc(o.label)}</span><span>${o.progress}/${o.target}</span></div>${bar(o.progress / o.target, o.label)}`).join('')}
        </div>
        <div class="row-actions">
          <span class="chip">${fmt.num(m.rewardRlu, 1)} RLU</span><span class="chip">${fmt.num(m.rewardXp)} xp</span>
          ${m.status === 'available' ? `<button class="btn btn-xs" data-act="mission-accept" data-id="${esc(m.missionId)}" type="button">accept</button>` : ''}
          ${m.status === 'ready' ? `<button class="btn btn-xs btn-primary" data-act="mission-complete" data-id="${esc(m.missionId)}" type="button">claim</button>` : ''}
        </div>
      </div>`;

    return [
      card({
        kicker: 'cadence', title: 'Mission board', addr: board.__meta?.entropyAddress, span: 12,
        note: `Day ${board.day} · ${esc(board.week)} · season ${esc(board.season.seasonId)}. Missions are generated from (genesisSeed, date) — never stored, so every node agrees.`,
        body: `<p class="section-title">daily</p>${rows(board.daily.map(missionRow))}
          <p class="section-title" style="margin-top:.8rem">weekly</p>${rows(board.weekly.map(missionRow))}
          <p class="section-title" style="margin-top:.8rem">seasonal</p>${rows(board.seasonal.map(missionRow))}`,
      }),
      card({
        kicker: 'season', title: 'Seasonal progression', span: 6,
        note: season.claimableTiers?.length ? `${season.claimableTiers.length} tier reward(s) ready to claim.` : 'Complete missions to earn season xp.',
        body: `<div class="kv">
            <dt>season</dt><dd>${esc(season.season.seasonId)} · ${esc(season.season.name)}</dd>
            <dt>xp</dt><dd>${fmt.num(season.xp)}</dd>
            <dt>tier</dt><dd>${esc(season.tier.name)} (${season.tier.tier})</dd>
            <dt>next</dt><dd>${season.nextTier ? `${esc(season.nextTier.name)} in ${fmt.num(season.nextTier.xpNeeded)} xp` : 'max tier'}</dd>
          </div>
          <div style="margin:.6rem 0">${bar(season.tier.progress, 'tier progress')}<div class="bar-label"><span>${esc(season.tier.name)}</span><span>${fmt.pct(season.tier.progress, 0)}</span></div></div>
          <p class="section-title" style="margin-top:.7rem">tier ladder</p>
          <div class="table-scroll"><table class="data"><thead><tr><th class="num">tier</th><th>name</th><th class="num">xp</th><th class="num">RLU</th><th>you</th></tr></thead>
          <tbody>${(season.claimableTiers || []).length || true ? '' : ''}${TIER_LADDER(season)}</tbody></table></div>
          <div class="btn-row" style="margin-top:.7rem"><button class="btn btn-xs btn-primary" data-act="season-claim" type="button" ${season.claimableTiers?.length ? '' : 'disabled'}>claim tier rewards</button></div>
          <p class="hint">${(season.claimableTiers || []).map((t) => `${esc(t.name)} +${t.rewardRlu} RLU`).join(' · ') || 'nothing claimable'}</p>`,
      }),
      card({
        kicker: 'world events', title: 'Events & modifiers', span: 6,
        note: `Live multipliers — RLU ×${events.multipliers.rluMultiplier}, weave stability +${events.multipliers.stabilityBonus}, bond ×${events.multipliers.bondMultiplier}, pending discount ×${events.multipliers.pendingDiscount}.`,
        body: `${rows(events.live.map((e) => `<div class="row"><div><div class="row-title">${esc(e.title)} <span class="chip">${esc(e.origin || 'scheduled')}</span></div><div class="row-sub">${esc(e.text)}</div><div class="row-sub">${fmt.time(e.startsAt)} → ${fmt.time(e.endsAt)} · intensity ${e.intensity}</div></div><div class="row-actions"><span class="chip chip-mono">${esc(fmt.short(e.address, 10, 6))}</span></div></div>`))}
          <hr class="rule" />
          <div class="grid-form">
            <label class="field">trigger event<select id="ev-kind">${events.kinds.map((k) => `<option value="${k.id}">${esc(k.title)} — ${esc(k.note)}</option>`).join('')}</select></label>
            <label class="field">hours<input id="ev-hours" type="number" value="6" /></label>
            <label class="field">reason<input id="ev-reason" placeholder="community night" /></label>
            <button class="btn" data-act="event-trigger" type="button">trigger (SEVERE)</button>
          </div>
          <p class="hint">SEVERE risk requires 1600 smart value — a normal token parks this as a pending seal for architect co-signature.</p>`,
      }),
      card({ kicker: 'leaderboard', title: 'Mission leaderboard', span: 12, body: `<div class="table-scroll"><table class="data"><thead><tr><th class="num">#</th><th>player</th><th class="num">completions</th><th class="num">RLU</th><th class="num">xp</th><th>last</th></tr></thead><tbody>${(leaderboard.leaderboard || []).map((r) => `<tr><td class="num">${r.rank}</td><td>${esc(r.alias || r.profileId)}</td><td class="num">${r.completions}</td><td class="num">${fmt.num(r.rlu, 1)}</td><td class="num">${fmt.num(r.xp)}</td><td>${fmt.ago(r.lastAt)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">no completions yet</td></tr>'}</tbody></table></div>` }),
    ].join('');
  }

  /* ── multiplayer ─────────────────────────────────────────────────────── */

  async function renderMultiplayer() {
    const subject = state.me?.subject || store.subject;
    const [safety, lobbies, found, stats, presence] = await Promise.all([
      api('/v1/multiplayer/safety'),
      api('/v1/multiplayer/lobbies'),
      api('/v1/multiplayer/find?minSafety=50').catch(() => ({ lobbies: [] })),
      api('/v1/multiplayer/stats'),
      api('/v1/multiplayer/presence').catch(() => ({ presence: [] })),
    ]);
    state.lobbies = lobbies;

    const lobbyRow = (l) => `
      <div class="row">
        <div style="min-width:15rem">
          <div class="row-title">${esc(l.name)} <span class="chip">${esc(l.mode)}</span> <span class="chip ${l.safety >= 80 ? 'chip-good' : l.safety >= 60 ? 'chip-warn' : 'chip-bad'}">safety ${l.safety}</span></div>
          <div class="row-sub">host ${esc(l.hostAlias)} · ${l.memberCount}/${l.capacity} · ${esc(l.settings.privacy)} · ${esc(l.region)} · code ${esc(l.inviteCode)}</div>
          <div class="row-sub">${esc(l.address)}${l.raidId ? ` · raid ${esc(l.raidId)}` : ''}</div>
        </div>
        <div class="pill-list">${(l.members || []).map((m) => `<span class="chip" title="${m.consentShared ? 'sharing quantised position' : 'presence private'}">${esc(m.alias)}${m.host ? ' ★' : ''}${m.consentShared ? ' 📍' : ''}</span>`).join('')}</div>
        <div class="row-actions">
          ${l.youAreMember ? `<button class="btn btn-xs btn-ghost" data-act="lobby-leave" data-id="${esc(l.lobbyId)}" type="button">leave</button>` : `<button class="btn btn-xs" data-act="lobby-join" data-id="${esc(l.lobbyId)}" data-code="${esc(l.inviteCode || '')}" type="button">join</button>`}
          <button class="btn btn-xs" data-act="lobby-detail" data-id="${esc(l.lobbyId)}" type="button">detail</button>
          ${l.isHost ? `<button class="btn btn-xs btn-primary" data-act="raid-create" data-id="${esc(l.lobbyId)}" type="button">start raid</button>` : ''}
        </div>
      </div>`;

    return [
      card({
        kicker: 'safe multiplayer', title: 'Lobbies, parties & co-op raids', addr: lobbies.__meta?.entropyAddress, span: 12,
        note: 'Safety is enforced in code: a hard filter on join, quantised positions, consent-default-off presence, pseudonymous members, and reports that park a seal instead of auto-punishing.',
        body: tiles([
          { label: 'open lobbies', value: fmt.num(stats.openLobbies), sub: `${stats.totalMembers} members` },
          { label: 'avg safety', value: fmt.num(stats.averageSafety, 1), sub: `min ${stats.minSafety}`, tone: 'good' },
          { label: 'active raids', value: fmt.num(stats.activeRaids), sub: `${stats.raidsCleared} cleared lifetime` },
          { label: 'parties', value: fmt.num(stats.activeParties), sub: `${stats.parties} created` },
          { label: 'open reports', value: fmt.num(stats.openReports), sub: `${stats.sanctions} sanctions applied`, tone: 'warn' },
          { label: 'safe exits', value: fmt.num(stats.safeExits), sub: 'single-call panic path' },
        ]),
      }),
      card({
        kicker: 'create', title: 'New lobby', span: 6,
        note: `Default posture scores <b>${safety.score}</b>/100.`,
        body: `<div class="grid-form">
            <label class="field">name<input id="lb-name" placeholder="Night Gate" /></label>
            <label class="field">mode<select id="lb-mode">${safety.modes.map((m) => `<option value="${m}">${m}</option>`).join('')}</select></label>
            <label class="field">privacy<select id="lb-privacy">${safety.privacy.map((p) => `<option value="${p.id}" ${p.id === 'party-code' ? 'selected' : ''}>${esc(p.label)} (+${p.safetyWeight})</option>`).join('')}</select></label>
            <label class="field">max members<input id="lb-max" type="number" value="8" /></label>
            <label class="field">age band<select id="lb-age">${safety.ageBands.map((a) => `<option value="${a}" ${a === 'teen' ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
            <button class="btn btn-primary" data-act="lobby-create" type="button">create lobby</button>
          </div>
          <div class="pill-list" style="margin-top:.6rem">
            <label class="layer-toggle on"><input type="checkbox" id="lb-prox" /> proximity voice (off = +8)</label>
            <label class="layer-toggle on"><input type="checkbox" id="lb-mod" checked /> host moderation (+10)</label>
            <label class="layer-toggle on"><input type="checkbox" id="lb-report" checked /> reporting (+8)</label>
            <label class="layer-toggle on"><input type="checkbox" id="lb-safeexit" checked /> safe exit (+6)</label>
          </div>
          <p class="section-title" style="margin-top:.7rem">filters enabled by default</p>
          <div class="pill-list">${safety.filters.map((f) => `<span class="chip chip-good">${esc(f)}</span>`).join('')}</div>
          <hr class="rule" />
          <p class="section-title">safety breakdown</p>
          <div class="table-scroll"><table class="data"><tbody>${safety.breakdown.items.map((i) => `<tr><td>${esc(i.item)}</td><td class="num">+${i.points}</td></tr>`).join('')}<tr><th>score</th><th class="num">${safety.breakdown.score}</th></tr></tbody></table></div>`,
      }),
      card({
        kicker: 'party', title: 'Party & presence', span: 6,
        body: `<div class="btn-row">
            <button class="btn btn-xs" data-act="party-create" type="button">create party</button>
            <button class="btn btn-xs btn-ghost" data-act="party-show" type="button">show my party</button>
            <button class="btn btn-xs btn-ghost" data-act="presence-beat" type="button">heartbeat</button>
            <button class="btn btn-xs btn-danger" data-act="safe-exit" type="button">SAFE EXIT (leave everything)</button>
          </div>
          <div id="mp-out" style="margin-top:.7rem"></div>
          <p class="section-title" style="margin-top:.6rem">online now (pseudonymous, quantised)</p>
          ${rows((presence.presence || []).map((p) => `<div class="row"><div><div class="row-title">${esc(p.alias)}</div><div class="row-sub">${esc(p.profileId)} · lobby ${esc(p.lobbyId || '—')}${p.position ? ` · cell ${p.position.x}/${p.position.y}` : ''}</div></div><div class="row-actions"><span class="chip ${p.consentShared ? 'chip-good' : ''}">${p.consentShared ? 'sharing' : 'private'}</span><span class="chip chip-mono">${fmt.ago(p.at)}</span></div></div>`))}`,
      }),
      card({ kicker: 'lobbies', title: 'Your lobbies & open rooms', span: 12, body: rows((lobbies.lobbies || []).map(lobbyRow)) }),
      card({ kicker: 'matchmaking', title: 'Safe matches (safety ≥ 50)', span: 7, body: rows((found.lobbies || []).map(lobbyRow)) }),
      card({
        kicker: 'raids', title: 'Co-op raids', span: 5,
        note: 'Deterministic phase machine: capability vs difficulty pressure. Three costly phases ends the run.',
        body: `<div class="btn-row"><button class="btn btn-xs" data-act="raid-list" type="button">refresh raids</button></div><div id="raid-list" class="rows" style="margin-top:.6rem"><p class="empty">load raids</p></div>`,
      }),
    ].join('');
  }

  async function loadRaids() {
    const box = $('#raid-list');
    if (!box) return;
    try {
      const data = await api('/v1/multiplayer/raids');
      box.innerHTML = (data.raids || []).map((r) => `
        <div class="row">
          <div style="flex:1;min-width:13rem">
            <div class="row-title">${esc(r.name)} <span class="chip">${esc(r.status)}</span> <span class="chip chip-warn">d${r.difficulty}</span></div>
            <div class="row-sub">phase ${r.phaseIndex + 1}/${r.phases.length} · ${esc(r.phases[r.phaseIndex]?.label || '—')} · roster ${r.roster.length}</div>
            <div class="row-sub">${esc(r.address)}</div>
            ${r.outcome ? `<div class="row-sub">outcome ${esc(r.outcome)} · performance ${fmt.pct(r.performance)} · ${r.rewards?.rlu ?? 0} RLU</div>` : ''}
          </div>
          <div class="row-actions">
            <button class="btn btn-xs" data-act="raid-ready" data-id="${esc(r.raidId)}" type="button">ready</button>
            <button class="btn btn-xs btn-primary" data-act="raid-tick" data-id="${esc(r.raidId)}" type="button" ${r.status === 'running' ? '' : 'disabled'}>advance phase</button>
            <button class="btn btn-xs btn-ghost" data-act="raid-detail" data-id="${esc(r.raidId)}" type="button">detail</button>
          </div>
        </div>`).join('') || '<p class="empty">No raids yet — create a lobby, then start a raid.</p>';
    } catch (err) { box.innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
  }

  /* ── miners ──────────────────────────────────────────────────────────── */

  async function renderMiners() {
    const subject = state.me?.subject || store.subject;
    const [stats, chain, pool, wallet, library, consensus] = await Promise.all([
      api('/v1/miners/stats'),
      api('/v1/miners/chain?limit=12'),
      api('/v1/miners/pool'),
      api(`/v1/miners/wallet/${encodeURIComponent(subject)}`).catch(() => null),
      api('/v1/miners/reality?limit=4'),
      api('/v1/miners/consensus'),
    ]);
    state.chain = chain; state.pool = pool; state.wallet = wallet;

    return [
      card({
        kicker: 'reality mining', title: 'A full miner stack — mining world content, not currency', addr: chain.__meta?.entropyAddress, span: 12,
        note: 'Proof-of-work, difficulty retargeting, shares, stale/orphan handling, pool payout splits, wallets and a ledger. The coinbase pays <b>reality fragments</b> that become AR terrain, weaveable abilities, companion dialogue, mission venues and memory traces.',
        body: tiles([
          { label: 'height', value: fmt.num(stats.height), sub: `tip ${fmt.short(stats.tip, 10, 6)}`, tone: 'accent' },
          { label: 'difficulty', value: `${stats.difficultyBits} bits`, sub: `≈1 in ${fmt.compact(stats.target.expectedHashes)} hashes` },
          { label: 'median solve', value: `${fmt.num(stats.medianSolveMs ?? 0)} ms`, sub: `target ${stats.targetBlockMs} ms` },
          { label: 'hashes', value: fmt.compact(stats.hashes), sub: `${fmt.compact(stats.averageHashrateHps)} H/s avg` },
          { label: 'shares', value: fmt.num(stats.shares), sub: `stale ${stats.stale} · rejected ${stats.rejected} · orphaned ${stats.orphaned}` },
          { label: 'rlu emitted', value: fmt.compact(stats.rluEmitted), sub: `${fmt.compact(stats.rluOutstanding)} outstanding` },
          { label: 'fragments', value: fmt.num(stats.fragments), sub: `${stats.artifactsMinted} artifacts · ${stats.abilitiesGenerated} abilities generated`, tone: 'good' },
          { label: 'workers', value: fmt.num(stats.workers), sub: `${fmt.compact(pool.totalHashrate)} H/s pool` },
          { label: 'retargets', value: fmt.num(stats.retargets), sub: pool.lastRetarget ? `last ${pool.lastRetarget.fromBits}→${pool.lastRetarget.toBits}b` : 'none yet' },
          { label: 'your rlu', value: fmt.compact(wallet?.rlu ?? 0), sub: `${fmt.num(wallet?.blocksMined ?? 0)} blocks · lifetime ${fmt.compact(wallet?.lifetimeRlu ?? 0)}` },
        ]),
      }),
      card({
        kicker: 'mine', title: 'Mine reality', span: 5,
        note: 'In-process search so the HUD can move the chain with one click. For sustained mining use the CLI or the work/submit protocol.',
        body: `<div class="grid-form">
            <label class="field">seconds<input id="mn-seconds" type="number" value="3" min="1" max="30" /></label>
            <label class="field">blocks<input id="mn-blocks" type="number" value="2" min="1" max="6" /></label>
            <label class="field">worker id<input id="mn-worker" placeholder="hud-01" /></label>
            <button class="btn btn-primary" data-act="mine" type="button">mine now</button>
          </div>
          <div class="btn-row" style="margin-top:.6rem">
            <button class="btn btn-xs" data-act="verify-chain" type="button">verify chain</button>
            <button class="btn btn-xs btn-ghost" data-act="show-consensus" type="button">consensus params</button>
            <button class="btn btn-xs btn-ghost" data-act="show-work" type="button">get work (long-poll)</button>
            <button class="btn btn-xs btn-ghost" data-act="derive-fragment" type="button">derive fragment</button>
          </div>
          <hr class="rule" />
          <p class="section-title">how a block is mined</p>
          <pre class="code" style="white-space:pre-wrap">${esc(consensus.explanation.pow)}
${esc(consensus.explanation.header)}
${esc(consensus.explanation.difficulty)}
${esc(consensus.explanation.shares)}
${esc(consensus.explanation.reward)}
${esc(consensus.explanation.coinbase)}</pre>
          <p class="hint">${esc(consensus.explanation.noHalving)}</p>`,
      }),
      card({
        kicker: 'chain', title: 'Reality blocks', span: 7,
        body: `<div class="table-scroll scroll-y"><table class="data">
            <thead><tr><th class="num">h</th><th>hash / address</th><th class="num">bits</th><th class="num">solve</th><th class="num">RLU</th><th>reality</th></tr></thead>
            <tbody>${chain.blocks.map((b) => `<tr>
              <td class="num">${b.height}${b.isGenesis ? ' ★' : ''}</td>
              <td><span class="copyable" data-act="copy" data-copy="${esc(b.hash)}">${esc(fmt.short(b.hash, 14, 6))}</span><br /><span class="row-sub copyable" data-act="copy" data-copy="${esc(b.address)}">${esc(fmt.short(b.address, 12, 6))}</span></td>
              <td class="num">${b.leadingZeroBits}/${b.difficultyBits}</td>
              <td class="num">${fmt.num(b.solveMs)}ms</td>
              <td class="num">${fmt.num(b.totalRlu, 1)}</td>
              <td>${b.reality.count} · ${esc(b.reality.rarest || '—')}<br /><span class="row-sub">${esc((b.reality.kinds || []).join(', '))}</span></td>
            </tr>`).join('')}</tbody></table></div>`,
      }),
      card({
        kicker: 'wallet', title: 'Reality wallet & ledger', addr: wallet?.address, span: 6,
        note: `${esc(wallet?.unit?.note || '')}`,
        body: `<div class="kv">
            <dt>balance</dt><dd>${fmt.num(wallet?.rlu ?? 0, 2)} RLU</dd>
            <dt>lifetime</dt><dd>${fmt.num(wallet?.lifetimeRlu ?? 0, 2)} RLU</dd>
            <dt>address</dt><dd class="copyable" data-act="copy" data-copy="${esc(wallet?.address || '')}">${esc(wallet?.address || '—')}</dd>
            <dt>evm form</dt><dd class="copyable" data-act="copy" data-copy="${esc(wallet?.evmAddress || '')}">${esc(wallet?.evmAddress || '—')}</dd>
            <dt>blocks</dt><dd>${fmt.num(wallet?.blocksMined ?? 0)} · shares ${fmt.num(wallet?.sharesSubmitted ?? 0)}</dd>
          </div>
          <p class="section-title" style="margin-top:.7rem">ledger</p>
          <div class="scroll-y table-scroll"><table class="data"><thead><tr><th>when</th><th>kind</th><th class="num">amount</th><th class="num">balance</th><th>reason</th></tr></thead>
          <tbody>${(wallet?.ledger || []).map((e) => `<tr><td>${fmt.date(e.at)}</td><td>${esc(e.kind)}</td><td class="num">${e.direction === 'credit' ? '+' : '−'}${fmt.num(e.amount, 2)}</td><td class="num">${fmt.num(e.balance, 2)}</td><td>${esc(e.reason || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">empty ledger</td></tr>'}</tbody></table></div>
          <p class="section-title" style="margin-top:.7rem">artifacts (${wallet?.artifacts?.length ?? 0})</p>
          <div class="pill-list">${(wallet?.artifacts || []).slice(0, 12).map((a) => `<span class="chip badge-rarity-${esc(a.rarity)}" title="${esc(a.address)}">${esc(a.title)}</span>`).join('') || '<span class="chip">none mined yet</span>'}</div>`,
      }),
      card({
        kicker: 'reality library', title: 'What the chain has produced', span: 6,
        note: 'Every fragment is re-derivable from its source block hash — that is the whole point: content is provable, not scarce.',
        body: `<div class="scroll-y rows">${library.kinds.map((k) => `
          <div class="row"><div style="flex:1;min-width:12rem">
            <div class="row-title">${esc(k.kind)} <span class="chip">${k.count}</span></div>
            ${k.samples.map((f) => `<div class="row-sub"><span class="badge-rarity-${esc(f.rarity)}">${esc(f.rarity)}</span> · ${esc(f.title || f.codename)} — ${esc((f.text || '').slice(0, 120))}</div>`).join('')}
          </div>
          <div class="row-actions"><button class="btn btn-xs btn-ghost" data-act="show-kind" data-kind="${esc(k.kind)}" type="button">all</button></div></div>`).join('')}</div>`,
      }),
      card({
        kicker: 'pool', title: 'Pool & workers', addr: pool.address, span: 12,
        note: `Block target ${pool.target.difficultyBits} bits · share target ${pool.shareTarget.difficultyBits} bits (16× easier) · stale ${pool.stale} · orphaned ${pool.orphaned} · rejected ${pool.rejected}.`,
        body: `<div class="table-scroll"><table class="data">
            <thead><tr><th>worker</th><th>profile</th><th>mode</th><th class="num">shares</th><th class="num">blocks</th><th class="num">hashrate</th><th class="num">weight</th><th>state</th></tr></thead>
            <tbody>${pool.workers.map((w) => `<tr>
              <td><span class="copyable" data-act="copy" data-copy="${esc(w.address)}">${esc(w.label || w.workerId)}</span></td>
              <td>${esc(w.profileId)}</td><td>${esc(w.mode)}</td>
              <td class="num">${fmt.num(w.shares)}</td><td class="num">${fmt.num(w.blocks)}</td>
              <td class="num">${fmt.compact(w.hashrate)} H/s</td><td class="num">${fmt.pct(w.shareWeight, 1)}</td>
              <td>${w.online ? '<span class="chip chip-good">online</span>' : '<span class="chip">idle</span>'} ${w.staleShares ? `<span class="chip chip-warn">${w.staleShares} stale</span>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="8" class="empty">no workers registered</td></tr>'}</tbody></table></div>
          <div class="btn-row" style="margin-top:.6rem"><button class="btn btn-xs" data-act="register-worker" type="button">register worker</button></div>
          <p class="section-title" style="margin-top:.7rem">retarget history</p>
          <div class="table-scroll"><table class="data"><thead><tr><th class="num">height</th><th class="num">median</th><th class="num">factor</th><th class="num">bits</th><th>when</th></tr></thead>
          <tbody>${pool.retargetHistory.map((r) => `<tr><td class="num">${r.atHeight}</td><td class="num">${fmt.num(r.medianSolveMs)}ms</td><td class="num">×${r.factor}</td><td class="num">${r.fromBits} → ${r.toBits}</td><td>${fmt.date(r.at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">no retargets yet</td></tr>'}</tbody></table></div>`,
      }),
    ].join('');
  }

  /* ── pending ─────────────────────────────────────────────────────────── */

  async function renderPending() {
    const data = await api('/v1/pending?limit=60');
    state.seals = data.seals || [];
    return [
      card({
        kicker: 'unmask pool', title: 'Everything pending by code', addr: data.__meta?.entropyAddress, span: 12,
        note: `A mutation whose required smart value exceeds the caller's live value is parked here instead of touching canonical state. Seals clear by authority, by co-signature, or by a root unmask — and every clearing is journalled.`,
        body: tiles([
          { label: 'pending', value: fmt.num(data.pool.pending ?? 0), sub: 'awaiting authority', tone: 'warn' },
          { label: 'unmasked', value: fmt.num(data.pool.unmasked ?? 0), sub: 'committed to reality', tone: 'good' },
          { label: 'expired', value: fmt.num(data.pool.expired ?? 0), sub: 'ttl passed' },
          { label: 'voided', value: fmt.num(data.pool.voided ?? 0), sub: 'cancelled' },
          { label: 'failed', value: fmt.num(data.pool.failed ?? 0), sub: 'applier threw' },
          { label: 'outstanding value', value: fmt.num(data.pool.outstandingValue ?? 0), sub: 'smart value still needed' },
        ]),
      }),
      card({ kicker: 'seals', title: 'Seal queue', span: 12, body: rows((data.seals || []).map(sealCard)) }),
      card({
        kicker: 'risk ladder', title: 'Required smart value per risk', span: 12,
        body: `<div class="table-scroll"><table class="data"><thead><tr><th>risk</th><th class="num">required</th><th>label</th><th>your authority</th></tr></thead><tbody>${(data.riskLadder || []).map((r) => `<tr><td class="mono">${esc(r.key)}</td><td class="num">${fmt.num(r.required)}</td><td>${esc(RISK_LABELS[r.key] || '')}</td><td>${(state.me?.smartValue?.live ?? 0) >= r.required ? '<span class="chip chip-good">auto-seals</span>' : '<span class="chip chip-warn">parks pending</span>'}</td></tr>`).join('')}</tbody></table></div>`,
      }),
    ].join('');
  }

  /* ── handlers ────────────────────────────────────────────────────────── */

  async function renderHandlers() {
    const registry = state.handlers || (state.handlers = await api('/v1/handlers'));
    const groups = registry.groups || [];
    return [
      card({
        kicker: 'api', title: 'Content handler registry', addr: registry.networkSeedFingerprint ? `seed:${registry.networkSeedFingerprint}` : '', span: 12,
        note: `${registry.count} handlers, each with an entropy-generated address derived from (genesisSeed, handlerId, "METHOD /path"). Addresses are stable per network — safe to hard-code in an integration.`,
        body: tiles([
          { label: 'handlers', value: fmt.num(registry.count), sub: `${groups.length} groups` },
          { label: 'pending-capable', value: fmt.num(registry.handlers.filter((h) => h.pendingCapable).length), sub: 'gated by smart value' },
          { label: 'public', value: fmt.num(registry.handlers.filter((h) => !h.auth).length), sub: 'no token required' },
          { label: 'seed fingerprint', value: esc(fmt.short(registry.networkSeedFingerprint, 10, 6)), sub: 'same seed ⇒ same addresses' },
        ]) + `<div class="btn-row" style="margin-top:.7rem">
            <button class="btn btn-xs" data-act="open-openapi" type="button">openapi.json</button>
            <button class="btn btn-xs btn-ghost" data-act="copy" data-copy="${location.origin}/v1/openapi.json" type="button">copy spec url</button>
            <button class="btn btn-xs btn-ghost" data-act="show-sdk" type="button">integration snippet</button>
            <button class="btn btn-xs btn-ghost" data-act="show-index" type="button">protocol card</button>
          </div>`,
      }),
      ...groups.map((g) => card({
        kicker: g.label, title: `${g.group} · ${g.handlers.length} handlers`, addr: g.address, span: 12,
        body: `<div class="table-scroll"><table class="data">
          <thead><tr><th>method</th><th>path</th><th>handler</th><th>entropy address</th><th>risk</th><th>scopes</th><th>title</th></tr></thead>
          <tbody>${g.handlers.map((h) => `<tr>
            <td class="mono">${esc(h.method)}</td>
            <td class="mono">${esc(h.path)}</td>
            <td class="mono">${esc(h.handler)}</td>
            <td class="mono copyable" data-act="copy" data-copy="${esc(h.entropyAddress)}" title="${esc(h.entropyAddress)} · evm ${esc(h.evmAddress)}">${esc(fmt.short(h.entropyAddress, 12, 6))}</td>
            <td>${h.risk ? `<span class="chip ${h.risk === 'HIGH' || h.risk === 'SEVERE' || h.risk === 'GENESIS' ? 'chip-bad' : h.risk === 'MEDIUM' ? 'chip-warn' : ''}">${esc(h.risk)} · ${fmt.num(h.requiredSmartValue)}</span>` : '<span class="chip">open</span>'}</td>
            <td class="mono">${esc((h.scopes || []).join(', ') || (h.auth ? '—' : 'public'))}</td>
            <td>${esc(h.title || '')}</td>
          </tr>`).join('')}</tbody></table></div>`,
      })),
    ].join('');
  }

  /* ── 4. actions ──────────────────────────────────────────────────────── */

  function onAction(e) {
    const copyEl = e.target.closest('[data-act="copy"]');
    if (copyEl) {
      const text = copyEl.dataset.copy;
      navigator.clipboard?.writeText(text).then(() => toast('ok', 'copied', fmt.short(text, 24, 8))).catch(() => modal('copy', `<pre>${esc(text)}</pre>`));
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const handlers = {
      goto: () => switchTab(el.dataset.tab),
      'tk-all': () => { closeModal(); issueToken($('#tk-subject').value, $('#tk-tier').value, ['entropy:read', 'memory:write', 'weave:write', 'ar:write', 'squad:write', 'mission:write', 'lobby:write', 'miner:work', 'unmask:seal', 'admin:root']); },
      'tk-player': () => { closeModal(); issueToken($('#tk-subject').value, $('#tk-tier').value, ['entropy:read', 'memory:write', 'weave:write', 'ar:write', 'squad:write', 'mission:write', 'lobby:write', 'miner:work']); },
      'tk-read': () => { closeModal(); issueToken($('#tk-subject').value, 'observer', ['entropy:read']); },
      'tk-clear': () => { store.token = ''; state.me = null; renderAuthority(); closeModal(); toast('ok', 'token cleared', 'you are anonymous again'); },
      'verify-token': async () => { const r = await api('/v1/auth/verify', { method: 'POST', body: { token: store.token } }); modal('token verification', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'show-journal': async () => { const r = await api('/v1/journal?limit=60'); modal('audit journal', `<pre>${esc(JSON.stringify(r.events, null, 2))}</pre>`); },
      'show-index': async () => { const r = await api('/v1'); modal('protocol card', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'open-openapi': () => window.open('/v1/openapi.json', '_blank'),
      'open-css': () => window.open('/ui/chromium.css', '_blank'),
      'show-sdk': () => modal('integration snippet', `<pre>${esc(SDK_SNIPPET)}</pre>`),
      'chromium-surface': async () => { await setChromium(el.dataset.surface, currentGrade()); },
      'chromium-grade': async () => { await setChromium(currentSurface(), nextGrade(currentGrade())); },

      /* memory */
      'mem-match-win': () => recordMatch('win'),
      'mem-match-loss': () => recordMatch('loss'),
      'mem-consolidate': async () => run(`/v1/memory/${sub()}/consolidate`, { method: 'POST', body: {} }, 'memory consolidated'),
      'mem-export': async () => { const r = await api(`/v1/memory/${sub()}/export`); modal('memory bundle', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'mem-import': () => modal('import bundle', `<label class="field">paste an ENTROPY-MEMORY bundle<textarea id="imp-json" style="min-height:12rem"></textarea></label><div class="btn-row" style="margin-top:.6rem"><button class="btn btn-primary" data-act="mem-import-go" type="button">import</button></div>`),
      'mem-import-go': async () => {
        try {
          const bundle = JSON.parse($('#imp-json').value);
          const r = await api('/v1/memory/import', { method: 'POST', body: bundle });
          closeModal(); toast('ok', 'import complete', r.status); renderTab('memory');
        } catch (err) { toast('err', 'import failed', err.message); }
      },
      remember: async () => run(`/v1/memory/${sub()}/remember`, { method: 'POST', body: { kind: $('#tr-kind').value, text: $('#tr-text').value, tags: $('#tr-tags').value.split(',').map((t) => t.trim()).filter(Boolean), resonance: Number($('#tr-res').value), decayDays: Number($('#tr-decay').value) } }, 'trace remembered'),
      recall: async () => {
        const r = await api(`/v1/memory/${sub()}/recall`, { method: 'POST', body: { query: $('#rc-query').value, limit: 8 } });
        $('#recall-out').innerHTML = (r.results || []).map((t) => `<div class="row"><div style="flex:1"><div class="row-title">${esc(t.kind)} · score ${t.score}</div><div class="row-sub">${esc(t.text)}</div><div class="row-sub">overlap ${t.breakdown.overlap} · recency ${t.breakdown.recency} · resonance ${t.breakdown.resonance} · access ${t.breakdown.access}</div></div></div>`).join('') || '<p class="empty">nothing matched</p>';
      },
      'recall-all': async () => {
        const r = await api(`/v1/memory/${sub()}/recall`, { method: 'POST', body: { limit: 12 } });
        $('#recall-out').innerHTML = (r.results || []).map((t) => `<div class="row"><div style="flex:1"><div class="row-title">${esc(t.kind)} · ${t.score}</div><div class="row-sub">${esc(t.text)}</div></div></div>`).join('') || '<p class="empty">no traces yet</p>';
      },
      forget: async () => run(`/v1/memory/${sub()}/forget/${encodeURIComponent(el.dataset.id)}`, { method: 'POST', body: { reason: 'player-requested erasure' } }, 'trace forgotten'),
      'save-loadout': async () => run(`/v1/memory/${sub()}/loadouts`, { method: 'POST', body: { name: $('#lo-name').value || 'Unnamed build', slots: { core: $('#lo-core').value, offhand: $('#lo-offhand').value, visor: $('#lo-visor').value, tether: $('#lo-tether').value, sigil: $('#lo-sigil').value }, notes: 'saved from the HUD' } }, 'loadout saved'),
      'equip-loadout': async () => run(`/v1/memory/${sub()}/loadouts/${encodeURIComponent(el.dataset.id)}/equip`, { method: 'POST', body: {} }, 'loadout equipped'),

      /* weave */
      'weave-select': () => {
        const id = el.dataset.id;
        state.selectedAbilities = state.selectedAbilities.includes(id) ? state.selectedAbilities.filter((x) => x !== id) : [...state.selectedAbilities, id].slice(0, 4);
        renderTab('weave');
      },
      'weave-clear': () => { state.selectedAbilities = []; state.weavePreview = null; renderTab('weave'); },
      'weave-analyze': async () => { state.weavePreview = await api('/v1/weave/analyze', { method: 'POST', body: { abilityIds: state.selectedAbilities } }); renderTab('weave'); },
      'weave-fuse': async () => { const r = await api('/v1/weave/fuse', { method: 'POST', body: { abilityIds: state.selectedAbilities } }); toast(r.status === 'pending' ? 'pending' : r.status === 'fracture' ? 'err' : 'ok', r.status === 'pending' ? 'parked' : `weave ${r.status}`, r.status === 'fracture' ? `${r.analysis.name} fractured — +${r.residue} residue` : r.fusion ? `${r.fusion.name} · power ${r.fusion.power}` : 'sealed'); state.weavePreview = null; renderTab('weave'); },
      'weave-fuse-pending': async () => { await api('/v1/weave/fuse', { method: 'POST', body: { abilityIds: state.selectedAbilities }, pending: 'force' }); renderTab('weave'); },
      'weave-unlock': async () => { await run('/v1/weave/unlock', { method: 'POST', body: { abilityId: el.dataset.id } }, 'ability unlocked'); state.selectedAbilities = []; },
      'fusion-use': async () => run(`/v1/weave/fusions/${encodeURIComponent(el.dataset.id)}/use`, { method: 'POST', body: { outcome: 'use' } }, 'fusion used'),
      'fusion-unweave': async () => run(`/v1/weave/fusions/${encodeURIComponent(el.dataset.id)}/unweave`, { method: 'POST', body: {} }, 'fusion dissolved'),

      /* ar */
      'ar-scan': async () => {
        state.arMode = $('#ar-mode').value;
        state.arScan = await api('/v1/ar/scan', { method: 'POST', body: { mode: state.arMode, layers: state.arLayers, location: { x: Number($('#ar-x').value), y: Number($('#ar-y').value), z: Number($('#ar-z').value) } } });
        toast('ok', 'scan complete', `${state.arScan.contactCount} contacts · plate ${fmt.short(state.arScan.chromePlate, 14, 6)}`);
        renderTab('ar'); loadAnchors();
        const t = await api(`/v1/ar/map/12/${Math.floor((state.arScan.location.x || 0) / 25)}/${Math.floor((state.arScan.location.y || 0) / 25)}`).catch(() => null);
        if (t) { state.arTile = t; renderTab('ar'); loadAnchors(); }
      },
      'ar-layer': () => {
        const id = el.dataset.layer;
        state.arLayers = el.checked ? [...new Set([...state.arLayers, id])] : state.arLayers.filter((l) => l !== id);
        const img = $('#ar-frame img');
        if (img) img.src = `/v1/ar/overlay.svg?mode=${encodeURIComponent(state.arMode)}&layers=${encodeURIComponent(state.arLayers.join(','))}&w=960&h=420&title=ENTROPY%20SCAN&t=${Date.now()}`;
        el.closest('.layer-toggle').classList.toggle('on', el.checked);
      },
      'ar-refresh-overlay': () => { const img = $('#ar-frame img'); if (img) img.src = `/v1/ar/overlay.svg?mode=${encodeURIComponent(state.arMode)}&layers=${encodeURIComponent(state.arLayers.join(','))}&w=960&h=420&title=ENTROPY%20SCAN&t=${Date.now()}`; },
      'ar-overlay': () => window.open(`/v1/ar/overlay.svg?mode=${encodeURIComponent(state.arMode)}&layers=${encodeURIComponent(state.arLayers.join(','))}&w=1280&h=720`, '_blank'),
      'anchor-create': async () => run('/v1/ar/anchors', { method: 'POST', body: { label: $('#an-label').value || 'anchor', layer: $('#an-layer').value, visibility: $('#an-vis').value, ttlMinutes: Number($('#an-ttl').value), position: { x: Number($('#ar-x')?.value || 0), y: Number($('#ar-y')?.value || 0), z: Number($('#ar-z')?.value || 0) } } }, 'anchor pinned'),
      'anchor-from-contact': async () => run('/v1/ar/anchors', { method: 'POST', body: { label: el.dataset.label, layer: el.dataset.layer, visibility: 'party', ref: { address: el.dataset.addr } } }, 'contact pinned'),
      'anchor-remove': async () => run(`/v1/ar/anchors/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' }, 'anchor removed'),

      /* squad */
      'squad-recruit': async () => run(`/v1/squad/${sub()}/recruit`, { method: 'POST', body: { companionId: el.dataset.id } }, 'companion recruited'),
      'squad-drill': async () => {
        const select = $(`select[data-companion="${CSS.escape(el.dataset.id)}"]`);
        await run(`/v1/squad/${sub()}/companions/${encodeURIComponent(el.dataset.id)}/drill`, { method: 'POST', body: { tactic: select?.value || 'flank-left', intensity: 1.5 } }, 'drill complete');
      },
      'squad-model': async () => { const r = await api(`/v1/squad/${sub()}/companions/${encodeURIComponent(el.dataset.id)}`); modal('learning model', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'squad-banter': async () => { const r = await api(`/v1/squad/${sub()}/banter?context=${state.squadMode === 'raid' ? 'raid' : 'lobby'}&turns=5`); $('#squad-out').innerHTML = chatHtml(r); },
      'squad-banter-one': async () => { const r = await api(`/v1/squad/${sub()}/banter?companionId=${encodeURIComponent(el.dataset.id)}&context=raid&turns=4`); $('#squad-out').innerHTML = chatHtml(r); },
      'squad-recommend': async () => {
        state.squadMode = $('#sq-mode')?.value || state.squadMode;
        const r = await api(`/v1/squad/${sub()}/recommend?mode=${state.squadMode}&size=4`);
        $('#squad-out').innerHTML = `<div class="kv"><dt>mode</dt><dd>${esc(r.mode)} · coverage ${fmt.pct(r.roleCoverage, 0)}${r.missingRoles?.length ? ` · missing ${esc(r.missingRoles.join(', '))}` : ''}</dd><dt>avg bond</dt><dd>${r.averageBond} · confidence ${fmt.pct(r.averageConfidence, 0)}</dd></div>` +
          rows((r.recommended || []).map((c) => `<div class="row"><div><div class="row-title">${esc(c.name)} <span class="chip">${esc(c.roleLabel)}</span></div><div class="row-sub">prefers ${esc(c.preferredTactic)} · bond ${c.bond} · score ${c.score}</div><div class="row-sub">${esc(c.reason)}</div></div></div>`));
      },

      /* missions */
      'mission-accept': async () => run(`/v1/missions/${encodeURIComponent(el.dataset.id)}/accept`, { method: 'POST', body: {} }, 'mission accepted'),
      'mission-complete': async () => { const r = await run(`/v1/missions/${encodeURIComponent(el.dataset.id)}/complete`, { method: 'POST', body: {} }, 'mission complete'); if (r?.rewardRlu) toast('ok', 'reward paid', `${r.rewardRlu} RLU · ${r.rewardXp} season xp · tier ${r.season?.tier}`); },
      'season-claim': async () => { const r = await api(`/v1/missions/season/${sub()}?claim=true`); toast('ok', 'season rewards claimed', r.claimed ? `${r.claimed.rlu} RLU across ${r.claimed.tiers.length} tier(s)` : 'nothing claimable'); renderTab('missions'); },
      'event-trigger': async () => { await run('/v1/missions/events', { method: 'POST', body: { kind: $('#ev-kind').value, durationHours: Number($('#ev-hours').value), reason: $('#ev-reason').value || null } }, 'world event triggered'); renderTab('missions'); },

      /* multiplayer */
      'lobby-create': async () => {
        const settings = { privacy: $('#lb-privacy').value, maxMembers: Number($('#lb-max').value), ageBand: $('#lb-age').value, proximityVoice: !$('#lb-prox').checked, hostModeration: $('#lb-mod').checked, reportingEnabled: $('#lb-report').checked, safeExitEnabled: $('#lb-safeexit').checked };
        await run('/v1/multiplayer/lobbies', { method: 'POST', body: { name: $('#lb-name').value || undefined, mode: $('#lb-mode').value, settings } }, 'lobby created');
      },
      'lobby-join': async () => { await run(`/v1/multiplayer/lobbies/${encodeURIComponent(el.dataset.id)}/join`, { method: 'POST', body: { inviteCode: el.dataset.code || null, safetyFloor: 50 } }, 'joined lobby'); },
      'lobby-leave': async () => { await run(`/v1/multiplayer/lobbies/${encodeURIComponent(el.dataset.id)}/leave`, { method: 'POST', body: {} }, 'left lobby'); },
      'lobby-detail': async () => { const r = await api(`/v1/multiplayer/lobbies/${encodeURIComponent(el.dataset.id)}`); modal('lobby detail', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'party-create': async () => { const r = await run('/v1/multiplayer/parties', { method: 'POST', body: { name: `${store.subject}'s party` } }, 'party created'); if (r?.partyId) $('#mp-out').innerHTML = `<pre class="code">${esc(JSON.stringify(r, null, 2))}</pre>`; },
      'party-show': async () => { const r = await api(`/v1/multiplayer/parties/${sub()}`); $('#mp-out').innerHTML = `<pre class="code">${esc(JSON.stringify(r, null, 2))}</pre>`; },
      'presence-beat': async () => { const r = await api('/v1/multiplayer/presence', { method: 'POST', body: { position: { x: 120, y: -40, z: 8 } } }); $('#mp-out').innerHTML = `<pre class="code">${esc(JSON.stringify(r, null, 2))}</pre>`; },
      'safe-exit': async () => { const r = await api('/v1/multiplayer/safe-exit', { method: 'POST', body: { reason: 'HUD safe exit' } }); toast('ok', 'safe exit complete', `left ${r.exitedLobbies.length} lobby(s) · presence cleared · consent revoked`); renderTab('multiplayer'); },
      'raid-create': async () => { const r = await run('/v1/multiplayer/raids', { method: 'POST', body: { lobbyId: el.dataset.id } }, 'raid created'); if (r?.raidId) loadRaids(); },
      'raid-list': () => loadRaids(),
      'raid-ready': async () => { await run(`/v1/multiplayer/raids/${encodeURIComponent(el.dataset.id)}/ready`, { method: 'POST', body: {} }, 'ready'); loadRaids(); },
      'raid-tick': async () => { const r = await api(`/v1/multiplayer/raids/${encodeURIComponent(el.dataset.id)}/tick`, { method: 'POST', body: {} }); toast(r.status === 'pending' ? 'pending' : 'ok', r.status === 'pending' ? 'parked' : `phase ${r.phase?.outcome || r.outcome}`, r.status === 'pending' ? `needs ${r.requiredSmartValue} smart value` : r.outcome ? `${r.outcome} · performance ${fmt.pct(r.performance)} · ${r.rewards?.rlu} RLU` : `next: ${r.nextPhase?.label}`); loadRaids(); },
      'raid-detail': async () => { const r = await api(`/v1/multiplayer/raids/${encodeURIComponent(el.dataset.id)}`); modal('raid detail', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },

      /* miners */
      mine: async () => {
        const seconds = Number($('#mn-seconds').value) || 3;
        const blocks = Number($('#mn-blocks').value) || 1;
        toast('ok', 'mining…', `${blocks} block(s) with a ${seconds}s budget`);
        const r = await api('/v1/miners/mine', { method: 'POST', body: { seconds, blocks, workerId: $('#mn-worker').value || 'hud-01' } });
        if (r.status === 'pending') return;
        toast('ok', 'reality mined', `${r.blocksMined} block(s) · ${fmt.compact(r.hashes)} hashes · ${fmt.compact(r.hashrateHps)} H/s · ${(r.mined || []).map((m) => `${m.realityCount} fragments`).join(', ')}`);
        renderTab('miners');
      },
      'verify-chain': async () => { const r = await api('/v1/miners/verify', { method: 'POST', body: { sampleReality: 8 } }); modal('chain verification', `<p>${r.valid ? '<span class="chip chip-good">VALID</span>' : '<span class="chip chip-bad">PROBLEMS FOUND</span>'} ${r.blocks} blocks · ${r.realityRechecks} reality re-derivations</p><pre>${esc(JSON.stringify(r.problems, null, 2))}</pre>`); },
      'show-consensus': async () => { const r = await api('/v1/miners/consensus'); modal('consensus parameters', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'show-work': async () => { const r = await api('/v1/miners/work?workerId=hud-01'); modal('mining work (long-poll)', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'derive-fragment': async () => { const r = await api('/v1/miners/fragments/derive', { method: 'POST', body: { index: Math.floor(Math.random() * 999) } }); modal('derived reality fragment', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
      'show-kind': async () => { const r = await api(`/v1/miners/reality?kind=${encodeURIComponent(el.dataset.kind)}&limit=40`); modal(`${el.dataset.kind} fragments`, `<pre>${esc(JSON.stringify(r.fragments, null, 2))}</pre>`); },
      'register-worker': async () => { const r = await api('/v1/miners/workers', { method: 'POST', body: { label: `hud-${Math.floor(Math.random() * 99)}`, pool: true } }); toast('ok', 'worker registered', `${r.workerId} · ${fmt.short(r.address, 12, 6)}`); renderTab('miners'); },

      /* pending */
      'seal-cosign': async () => { const r = await api(`/v1/pending/${encodeURIComponent(el.dataset.id)}/cosign`, { method: 'POST', body: { note: 'HUD co-signature' } }); toast(r.autoUnmasked ? 'ok' : 'pending', r.autoUnmasked ? 'auto-unmasked' : 'co-signed', r.autoUnmasked ? 'threshold reached — effect applied' : `missing ${JSON.stringify(r.missing || {})}`); renderTab('pending'); },
      'seal-unmask': async () => { const r = await api(`/v1/pending/${encodeURIComponent(el.dataset.id)}/unmask`, { method: 'POST', body: { note: 'HUD unmask' } }); toast('ok', 'genesis unmask', `${r.kind} applied by ${r.unmaskedBy}`); renderTab('pending'); refreshVitals(); },
      'seal-void': async () => { await api(`/v1/pending/${encodeURIComponent(el.dataset.id)}/void`, { method: 'POST', body: { reason: 'voided from HUD' } }); toast('ok', 'seal voided', el.dataset.id); renderTab('pending'); },
      'seal-detail': async () => { const r = await api(`/v1/pending/${encodeURIComponent(el.dataset.id)}`); modal('seal detail', `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); },
    };

    const fn = handlers[act];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        if (err instanceof ApiError) {
          const kind = err.status === 202 ? 'pending' : 'err';
          toast(kind, err.code || `http ${err.status}`, `${err.message}${err.detail ? ` · ${typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)}` : ''}`);
        } else {
          toast('err', 'hud error', err.message);
          console.error(err);
        }
      });
  }

  /* ── small action helpers ────────────────────────────────────────────── */

  const sub = () => encodeURIComponent(state.me?.subject || store.subject);
  const profilePath = () => sub();

  async function run(path, opts, okMessage) {
    const r = await api(path, opts);
    if (r?.status === 'pending') return r;
    toast('ok', okMessage, r?.address ? fmt.short(r.address, 16, 8) : '');
    renderTab(state.tab);
    if (state.tab === 'ar') loadAnchors();
    if (state.tab === 'multiplayer') loadRaids();
    return r;
  }

  async function recordMatch(result) {
    const companions = (state.profile?.companions ? [] : []);
    const tactics = ['flank-left', 'overwatch', result === 'win' ? 'focus-fire' : 'revive-first'];
    await run(`/v1/memory/${profilePath()}/matches`, {
      method: 'POST',
      body: { result, mode: 'skirmish', tactics, companions, score: result === 'win' ? 82 : 44, durationSec: 240 },
    }, `${result} recorded`);
  }

  function closeModal() { const dlg = $('#modal'); if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }

  function chatHtml(convo) {
    return `<p class="section-title">${esc(convo.context)} · ${esc(convo.voice || '')}</p><div class="chat">${(convo.lines || []).map((l) => `<div class="chat-line"><span class="who">${esc(l.speaker)}${l.mood ? ` · ${esc(l.mood)}` : ''}</span><span class="what">${esc(l.text)}${l.tactic ? ` <span class="chip chip-mono">${esc(l.tactic)}</span>` : ''}</span></div>`).join('')}</div>`;
  }

  function currentSurface() { return new URLSearchParams(location.search).get('surface') || localStorage.getItem('entropy.surface') || 'bright'; }
  function currentGrade() { return localStorage.getItem('entropy.grade') || state.index?.chromium?.grade || 'Cr-7'; }
  function nextGrade(grade) {
    const grades = ['Cr-2', 'Cr-3', 'Cr-5', 'Cr-6', 'Cr-7', 'Cr-9'];
    const i = grades.indexOf(grade);
    return grades[(i + 1) % grades.length];
  }
  async function setChromium(surface, grade) {
    localStorage.setItem('entropy.surface', surface);
    localStorage.setItem('entropy.grade', grade);
    const res = await fetch(`/v1/chromium/css?surface=${encodeURIComponent(surface)}&grade=${encodeURIComponent(grade)}`);
    const css = await res.text();
    let styleEl = $('#dynamic-chromium');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dynamic-chromium';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
    toast('ok', 'entropy chromium re-plated', `${surface} · ${grade}`);
    renderTab(state.tab);
  }

  const SDK_SNIPPET = `// Entropy SDK — zero-dependency client (Node 18+ / browser)
import { EntropyClient } from './entropy/src/sdk/client.js';   // ESM
// or: const { EntropyClient } = require('./entropy/src/sdk/client.js');

const entropy = new EntropyClient({
  baseUrl: 'http://localhost:8080',
  token: process.env.ENTROPY_TOKEN,          // entk.v1.…
  onPending: (seal) => console.log('parked:', seal.sealId, seal.requiredSmartValue),
});

// 1. identity
await entropy.memory.ensureProfile({ subject: 'player-42', alias: 'Nyx' });

// 2. mine reality (content, not currency)
const mined = await entropy.miners.mine({ seconds: 3, blocks: 2 });
console.log(mined.mined.map((b) => b.realityCount));

// 3. remember + recall
await entropy.memory.remember('player-42', { kind: 'loadout', text: 'tidal build for night raids', tags: ['tidal'] });
const hits = await entropy.memory.recall('player-42', { query: 'night raid' });

// 4. weave
const preview = await entropy.weave.analyze('player-42', ['tidal-step', 'gate-seal']);
const fusion  = await entropy.weave.fuse('player-42', ['tidal-step', 'gate-seal']);

// 5. unmask anything that parked
if (fusion.status === 'pending') await entropy.pending.unmask(fusion.sealId, { note: 'approved' });`;

  document.addEventListener('DOMContentLoaded', () => {
    renderFeed();
    boot();
  });
})();
