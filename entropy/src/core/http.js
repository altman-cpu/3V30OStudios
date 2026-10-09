'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HTTP CORE  —  zero-dependency router, middleware chain, SSE bus
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Deliberately tiny and readable: no express, no body-parser, no ws.
 *  Node's `node:http` covers everything the Entropy API needs:
 *
 *      • pattern routing   GET /v1/memory/:profileId/recall
 *      • middleware chain  requestId → cors → body → auth → ratelimit → route
 *      • envelope          { ok, data, meta:{ handler, entropyAddress, … } }
 *      • pending envelope  { ok:true, data:{ status:'pending', seal } }
 *      • SSE               GET /v1/stream  (live HUD: blocks, events, seals)
 *
 *  Every response carries the *entropy address of the content handler* that
 *  produced it. That is the "entropy generated addresses for all content
 *  handlers" requirement made observable in the wire format.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const { nowIso, hashHex, deriveAddress } = require('./entropy-core');

/* ─────────────────────────────── event bus ─────────────────────────────── */

class EventBus {
  constructor({ historyLimit = 200 } = {}) {
    this.subscribers = new Set();
    this.history = [];
    this.historyLimit = historyLimit;
    this.counters = new Map();
    /** In-process listeners: the embedding API for custom integrations. */
    this.listeners = new Map(); // type|'*' → Set<fn>
  }

  /**
   * Listen for an event type in-process (no HTTP, no SSE). Use `'*'` for all.
   * Returns an unsubscribe function, so an integration can never leak a hook.
   * @param {string} type
   * @param {(record:{id:string,type:string,payload:object,at:string})=>void} fn
   */
  on(type, fn) {
    if (typeof fn !== 'function') throw new Error('EventBus.on needs a listener function');
    const set = this.listeners.get(type) || new Set();
    set.add(fn);
    this.listeners.set(type, set);
    return () => this.off(type, fn);
  }

  /** Remove one listener (idempotent). */
  off(type, fn) {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(fn);
      if (!set.size) this.listeners.delete(type);
    }
    return this;
  }

  /** Publish an event to all SSE subscribers + history ring buffer. */
  emit(type, payload = {}, meta = {}) {
    const record = {
      id: hashHex('evt', type, Date.now(), crypto.randomBytes(6).toString('hex')).slice(0, 16),
      type,
      payload,
      meta,
      at: nowIso(),
    };
    this.history.push(record);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    this.counters.set(type, (this.counters.get(type) || 0) + 1);

    // In-process listeners first: a broken integration must never stop SSE.
    for (const key of [type, '*']) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const fn of set) {
        try {
          fn(record);
        } catch {
          /* swallow: listeners are observers, not part of the write path */
        }
      }
    }

    const frame = `event: ${type}\ndata: ${JSON.stringify(record)}\n\n`;
    for (const sub of this.subscribers) {
      try {
        sub.res.write(frame);
      } catch {
        this.subscribers.delete(sub);
      }
    }
    return record;
  }

  /** Subscribe an SSE response. Returns an unsubscribe function. */
  subscribe(res, filter = null) {
    const sub = { res, filter };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  snapshot() {
    return {
      subscribers: this.subscribers.size,
      listeners: [...this.listeners.entries()].reduce((acc, [k, v]) => ({ ...acc, [k]: v.size }), {}),
      history: this.history.length,
      counters: Object.fromEntries(this.counters),
      recent: this.history.slice(-25),
    };
  }
}

/* ──────────────────────────────── router ─────────────────────────────── */

class HttpError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const toBadRequest = (msg, detail = null) => new HttpError(400, 'bad_request', msg, detail);
const toNotFound = (msg, detail = null) => new HttpError(404, 'not_found', msg, detail);
const toUnauthorized = (msg, detail = null) => new HttpError(401, 'unauthorized', msg, detail);
const toForbidden = (msg, detail = null) => new HttpError(403, 'forbidden', msg, detail);
const toConflict = (msg, detail = null) => new HttpError(409, 'conflict', msg, detail);

class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * Register a route.
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {string} pattern             '/v1/memory/:profileId/recall'
   * @param {object} meta
   * @param {string} meta.handler        stable handler id, e.g. 'memory.recall'
   * @param {string} [meta.title]
   * @param {string} [meta.summary]
   * @param {string[]} [meta.scopes]     required scopes
   * @param {string} [meta.risk]         RISK key; writes become pending-gated
   * @param {boolean} [meta.auth]        default true; false = public
   * @param {Function} fn                async (ctx) => data
   */
  add(method, pattern, meta, fn) {
    const handlerId = meta.handler || `${method.toLowerCase()}:${pattern}`;
    const keys = [];
    const regex = new RegExp(
      `^${pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          if (seg === '*') return '.*';
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/')}$`,
    );
    // Specificity: literal segments outrank :params, so /v1/memory/stats always
    // wins over /v1/memory/:profileId regardless of registration order.
    const segments = pattern.split('/').filter(Boolean);
    const literals = segments.filter((seg) => !seg.startsWith(':') && seg !== '*').length;
    const specificity = literals * 100 - segments.length;

    this.routes.push({
      method,
      pattern,
      regex,
      keys,
      fn,
      handlerId,
      specificity,
      meta: { auth: true, scopes: [], risk: null, ...meta, handler: handlerId },
    });
    return this;
  }

  get(p, meta, fn) { return this.add('GET', p, meta, fn); }
  post(p, meta, fn) { return this.add('POST', p, meta, fn); }
  patch(p, meta, fn) { return this.add('PATCH', p, meta, fn); }
  delete(p, meta, fn) { return this.add('DELETE', p, meta, fn); }

  match(method, pathname) {
    let pathExists = false;
    let best = null;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;
      if (best && best.route.specificity >= route.specificity) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      best = { route, params };
    }
    return best || { route: null, params: {}, pathExists };
  }

  /** Route table → OpenAPI document (single source of truth, generated). */
  openapi({ genesisSeed, title, version, serverUrl }) {
    const paths = {};
    for (const route of this.routes) {
      const openApiPath = route.pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      paths[openApiPath] = paths[openApiPath] || {};
      const addr = deriveAddress({ domain: 'HND', seed: genesisSeed, label: route.meta.handler, sublabel: `${route.method} ${route.pattern}` });
      paths[openApiPath][route.method.toLowerCase()] = {
        operationId: route.meta.handler,
        summary: route.meta.title || route.meta.handler,
        description: route.meta.summary || '',
        tags: [route.meta.domain || route.meta.handler.split('.')[0]],
        'x-entropy-handler': route.meta.handler,
        'x-entropy-address': addr.address,
        'x-entropy-evm-address': addr.evm,
        'x-entropy-risk': route.meta.risk || null,
        'x-entropy-auth': route.meta.auth !== false,
        security: route.meta.auth === false ? [] : [{ entropyKey: route.meta.scopes || [] }],
        parameters: [
          ...route.keys.map((k) => ({ name: k, in: 'path', required: true, schema: { type: 'string' } })),
          ...(route.meta.query || []).map((q) => ({ name: q.name, in: 'query', required: Boolean(q.required), schema: { type: q.type || 'string' }, description: q.note || '' })),
        ],
        requestBody: route.meta.body
          ? { required: true, content: { 'application/json': { schema: route.meta.body, example: route.meta.example || {} } } }
          : undefined,
        responses: {
          200: {
            description: 'Envelope: { ok, data, meta }',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EntropyEnvelope' },
              },
            },
          },
          ...(route.meta.risk
            ? {
                202: {
                  description: 'Smart value below the operation requirement — effect parked in the Unmask Pool as a pending seal.',
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/PendingEnvelope' } } },
                },
              }
            : {}),
          401: { description: 'Missing / invalid / expired key auth token' },
          403: { description: 'Scope or smart-value authority denied' },
        },
      };
    }
    return {
      openapi: '3.1.0',
      info: {
        title,
        version,
        description:
          'Entropy API — Entropy Memory, Power Weaving, AR overlay, AI squad companions, missions/seasons, safe multiplayer and the Reality Mining stack. Every content handler has an entropy-generated address; every gated write carries a key auth token smart value.',
      },
      servers: [{ url: serverUrl }],
      security: [{ entropyKey: [] }],
      paths,
      components: {
        securitySchemes: {
          entropyKey: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'entk.v1.<payload>.<signature>',
            description: 'Entropy key auth token. Carries tier, scopes, entropyCredits, pendingBudget and a decaying smart value.',
          },
        },
        schemas: {
          EntropyEnvelope: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              data: { type: 'object' },
              meta: {
                type: 'object',
                properties: {
                  requestId: { type: 'string' },
                  handler: { type: 'string' },
                  entropyAddress: { type: 'string', description: 'EX-HND-… address of the content handler' },
                  handlerEvmAddress: { type: 'string' },
                  sealed: { type: 'boolean' },
                  tookMs: { type: 'number' },
                  smartValue: { type: 'number' },
                  at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          PendingEnvelope: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['pending'] },
                  sealId: { type: 'string' },
                  sealAddress: { type: 'string' },
                  requiredSmartValue: { type: 'number' },
                  offeredSmartValue: { type: 'number' },
                  expiresAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    };
  }
}

/* ───────────────────────────── rate limiter ───────────────────────────── */

/** Token bucket per subject (or IP for anonymous traffic). */
class RateLimiter {
  constructor({ capacity = 240, refillPerSec = 40 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }

  take(key, cost = 1) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.updated) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSec);
    bucket.updated = now;
    if (bucket.tokens < cost) {
      return { allowed: false, retryInMs: Math.ceil(((cost - bucket.tokens) / this.refillPerSec) * 1000), tokens: bucket.tokens };
    }
    bucket.tokens -= cost;
    return { allowed: true, tokens: bucket.tokens, retryInMs: 0 };
  }

  /** Periodic cleanup so a long-lived process does not leak buckets. */
  prune(maxAgeMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, bucket] of this.buckets) if (bucket.updated < cutoff) this.buckets.delete(key);
  }
}

/* ─────────────────────────── body / query parsing ─────────────────────── */

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — the API is JSON, not a file drop

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(toBadRequest(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : ''));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('body must be a JSON object or array');
    return parsed;
  } catch (err) {
    throw toBadRequest(`invalid JSON body: ${err.message}`);
  }
}

/* ─────────────────────────── static file serving ──────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Serve a directory safely (no path traversal) with ETag caching.
 * @returns {(req:object,res:object,pathname:string)=>boolean} true when handled
 */
function createStaticServer(rootDir, { index = 'index.html' } = {}) {
  const root = path.resolve(rootDir);
  return function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += index;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return true;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
    const stat = fs.statSync(target);
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const ext = path.extname(target).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      etag,
      'cache-control': 'no-cache',
      'last-modified': stat.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(target).pipe(res);
    return true;
  };
}

/* ──────────────────────────────── server ──────────────────────────────── */

/**
 * Build the Entropy HTTP server.
 *
 * @param {object} opts
 * @param {Router} opts.router
 * @param {import('./keyring').Keyring} opts.keyring
 * @param {EventBus} opts.bus
 * @param {RateLimiter} [opts.limiter]
 * @param {string} [opts.staticDir]       UI directory
 * @param {string[]} [opts.staticPrefixes] URL prefixes that map onto staticDir (default ['/ui'])
 * @param {(req,res)=>boolean} [opts.hooks.beforeStatic]  dynamic assets (chromium.css)
 * @param {(ctx:object)=>Promise<void>} [opts.hooks.beforeRoute]
 * @param {object} [opts.genesis]         genesis document (for OpenAPI meta)
 */
function createServer(opts) {
  const {
    router,
    keyring,
    bus,
    limiter = new RateLimiter(),
    staticDir = null,
    staticPrefixes = ['/ui'],
    hooks = {},
    genesis = {},
    corsOrigins = '*',
  } = opts;

  const serveStatic = staticDir ? createStaticServer(staticDir) : null;
  /**
   * The HUD links its own assets as `/ui/hud.css` and `/ui/hud.js`, so the
   * static root is reachable both bare (`/hud.css`) and under each prefix.
   */
  const serveUi = (req, res, pathname) => {
    if (!serveStatic) return false;
    const candidates = [];
    for (const prefix of staticPrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        candidates.push(pathname.slice(prefix.length) || '/index.html');
      }
    }
    candidates.push(pathname === '/' ? '/index.html' : pathname);
    for (const candidate of candidates) {
      if (serveStatic(req, res, candidate)) return true;
    }
    return false;
  };
  setInterval(() => limiter.prune(), 5 * 60 * 1000).unref?.();
  setInterval(() => keyring.sweepExpired(), 60 * 1000).unref?.();

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const requestId = crypto.randomBytes(8).toString('hex');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    res.setHeader('x-request-id', requestId);
    res.setHeader('x-entropy-protocol', 'ENTROPY/1.0.0');
    res.setHeader('access-control-allow-origin', corsOrigins);
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-entropy-token,x-entropy-pending');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-max-age', '600');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const send = (status, body, extraMeta = {}) => {
      const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
      const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      res.writeHead(status, {
        'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        ...extraMeta.headers,
      });
      res.end(payload);
      bus.emit('http.response', {
        requestId,
        method: req.method,
        path: pathname,
        status,
        tookMs: Math.round(tookMs * 100) / 100,
        handler: extraMeta.meta?.handler || null,
      });
    };

    try {
      /* ── dynamic asset hook (e.g. generated chromium.css, openapi.json) ── */
      if (hooks.beforeStatic && (await hooks.beforeStatic(req, res, pathname))) return;

      /* ── SSE stream ─────────────────────────────────────────────────── */
      if (pathname === '/v1/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, requestId, at: nowIso(), protocol: 'ENTROPY/1.0.0' })}\n\n`);
        const unsubscribe = bus.subscribe(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(ping);
          }
        }, 20_000);
        req.on('close', () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }

      /* ── static UI ──────────────────────────────────────────────────── */
      if (serveUi(req, res, pathname)) return;

      /* ── routing ────────────────────────────────────────────────────── */
      const { route, params, pathExists } = router.match(req.method, pathname);
      if (!route) {
        if (pathExists) return send(405, { ok: false, error: { code: 'method_not_allowed', message: `${req.method} not allowed on ${pathname}` }, meta: { requestId } });
        return send(404, {
          ok: false,
          error: { code: 'route_not_found', message: `no handler for ${req.method} ${pathname}`, hint: 'GET /v1 for the index, GET /v1/handlers for every content handler address' },
          meta: { requestId },
        });
      }

      const meta = route.meta;
      const handlerAddress = deriveAddress({
        domain: 'HND',
        seed: keyring.genesisSeed,
        label: meta.handler,
        sublabel: `${req.method} ${meta.pattern || route.pattern}`,
      });

      /* ── body + query ───────────────────────────────────────────────── */
      const rawBody = await readBody(req);
      const body = parseJson(rawBody);
      const query = Object.fromEntries(url.searchParams.entries());

      /* ── auth ───────────────────────────────────────────────────────── */
      const rawToken =
        query.token ||
        req.headers['x-entropy-token'] ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        null;

      let auth = { valid: false, code: 'token_missing', reason: 'anonymous' };
      if (rawToken) auth = keyring.verifyToken(rawToken, meta.scopes || []);
      const isRead = req.method === 'GET' || req.method === 'HEAD';

      if (meta.auth !== false) {
        if (!rawToken) {
          return send(401, {
            ok: false,
            error: { code: 'token_missing', message: 'this content handler requires a key auth token', hint: 'POST /v1/auth/token (dev bootstrap) or pass Authorization: Bearer entk.v1.…' },
            meta: { requestId, handler: meta.handler, entropyAddress: handlerAddress.address },
          });
        }
        if (!auth.valid) {
          return send(auth.code === 'token_scope' ? 403 : 401, {
            ok: false,
            error: { code: auth.code, message: auth.reason, detail: auth.claims ? { subject: auth.claims.sub, tier: auth.claims.tier, scopes: auth.claims.scopes } : null },
            meta: { requestId, handler: meta.handler, entropyAddress: handlerAddress.address },
          });
        }
      }

      /* ── rate limit ─────────────────────────────────────────────────── */
      const bucketKey = auth.valid ? `sub:${auth.claims.sub}` : `ip:${req.socket.remoteAddress || 'unknown'}`;
      const rate = limiter.take(bucketKey, isRead ? 1 : 2);
      if (!rate.allowed) {
        return send(429, { ok: false, error: { code: 'rate_limited', message: 'entropy flow throttled', detail: { retryInMs: rate.retryInMs } }, meta: { requestId, handler: meta.handler } }, { headers: { 'retry-after': String(Math.ceil(rate.retryInMs / 1000)) } });
      }

      /* ── context ────────────────────────────────────────────────────── */
      const ctx = {
        req,
        res,
        send,
        params,
        query,
        body,
        rawBody,
        requestId,
        route,
        meta,
        bus,
        keyring,
        vault: keyring.vault,
        genesis,
        handlerAddress,
        auth: auth.valid ? auth : null,
        claims: auth.valid ? auth.claims : null,
        smartValue: auth.valid ? auth.smartValue : 0,
        subject: auth.valid ? auth.claims.sub : 'anonymous',
        method: req.method,
        path: pathname,
        at: nowIso(),
        /**
         * Gate a mutation by smart value. Returns either
         *   { sealed:true,  data }        — effect applied now
         *   { sealed:false, seal, data }  — parked in the Unmask Pool
         * `apply` is only invoked when the gate opens.
         */
        async gate({ risk, kind, payload, reason = null, apply, auto = null }) {
          const required = keyring.requiredFor(risk);
          const offered = auth.valid ? auth.smartValue : 0;
          const pendingHeader = (req.headers['x-entropy-pending'] || query.pending || '').toLowerCase();
          const forcePending = pendingHeader === 'force' || pendingHeader === 'always';
          const forbidPending = pendingHeader === 'never' || auto === 'seal';

          const scopeOk = !meta.scopes?.length || (auth.valid && meta.scopes.every((s) => auth.claims.scopes.includes(s)));
          const enough = auth.valid && offered >= required;

          if (!scopeOk) {
            throw toForbidden('token lacks the scope for this handler', { required: meta.scopes, held: auth.valid ? auth.claims.scopes : [] });
          }

          if (forcePending || (!enough && !forbidPending)) {
            const seal = keyring.parkPending({
              kind,
              payload,
              claims: auth.valid ? auth.claims : null,
              requiredSmartValue: required,
              handler: handlerAddress.address,
              reason: reason || `smart value ${offered} below required ${required} for risk ${risk}`,
            });
            return { sealed: false, seal, required, offered };
          }
          if (!enough && forbidPending) {
            throw toForbidden('smart value below requirement and pending is disabled for this call', { offered, required, risk });
          }

          const data = await apply({ ctx, claims: auth.claims, smartValue: offered, required });
          return { sealed: true, data, required, offered };
        },
      };

      if (hooks.beforeRoute) await hooks.beforeRoute(ctx);

      const data = await route.fn(ctx);

      /* handlers may return a raw { __raw:true } to control the envelope */
      if (data && data.__raw) return send(data.status || 200, data.body, data.extra || {});

      const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
      const envelopeMeta = {
        requestId,
        handler: meta.handler,
        title: meta.title || null,
        entropyAddress: handlerAddress.address,
        handlerEvmAddress: handlerAddress.evm,
        domain: meta.domain || null,
        risk: meta.risk || null,
        sealed: data?.status === 'pending' ? false : true,
        tookMs: Math.round(tookMs * 100) / 100,
        smartValue: auth.valid ? auth.smartValue : null,
        subject: auth.valid ? auth.claims.sub : 'anonymous',
        tier: auth.valid ? auth.claims.tier : null,
        at: nowIso(),
      };
      const status = data?.status === 'pending' ? 202 : req.method === 'POST' && meta.created ? 201 : 200;
      send(status, { ok: true, data: data ?? null, meta: envelopeMeta });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[entropy] ${requestId} ${req.method} ${pathname} →`, err);
      send(status, {
        ok: false,
        error: {
          code: err.code || 'internal_error',
          message: err.message || 'unexpected failure',
          detail: err.detail || null,
        },
        meta: { requestId, at: nowIso() },
      });
    }
  });

  return server;
}

module.exports = {
  EventBus,
  Router,
  HttpError,
  RateLimiter,
  createServer,
  createStaticServer,
  toBadRequest,
  toNotFound,
  toUnauthorized,
  toForbidden,
  toConflict,
  MIME,
};
