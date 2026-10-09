'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTROPY CHROMIUM  —  the bright material + integrity layer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  "Chromium" here is literal and functional, two jobs in one module:
 *
 *   1. CHROME — the visual alloy. The premium, brighter interface is not
 *      hand-picked CSS; it is *generated from the genesis seed*. Each network
 *      gets its own iridescent hue triad, glass opacity, elevation ramp and
 *      type scale. `toCss()` emits the custom properties the HUD consumes at
 *      GET /ui/chromium.css. Change the seed → the whole product re-tints,
 *      consistently, everywhere, with zero design drift.
 *
 *   2. PLATING — the integrity alloy. `plate()` seals any payload with an
 *      HMAC over its canonical form, producing a `chromePlate` string that
 *      travels with AR overlays, mined reality fragments and handler output.
 *      A client can call `verifyPlate()` to prove the bytes came from this
 *      network and were not edited in transit. That is "entropy chromium added
 *      to entropy based coding": the same entropy that paints the UI also
 *      authenticates it.
 *
 *  Grades: Cr-2 … Cr-9 map to identity tiers, so a Sovereign's HUD literally
 *  carries more iridescence than a Guest's. Purely cosmetic — authority lives
 *  in the keyring smart value, never in the paint.
 */

const {
  deriveAddress,
  createRng,
  hmac,
  hashHex,
  contentAddress,
  clamp,
  round,
  canonicalize,
  PROTOCOL_VERSION,
} = require('./entropy-core');

/* ── grade ladder ────────────────────────────────────────────────────────── */

const GRADES = Object.freeze([
  { grade: 'Cr-2', tier: 'guest', iridescence: 0.18, gloss: 0.25, note: 'matte safety chrome' },
  { grade: 'Cr-3', tier: 'observer', iridescence: 0.3, gloss: 0.4, note: 'brushed chrome' },
  { grade: 'Cr-5', tier: 'operator', iridescence: 0.46, gloss: 0.58, note: 'polished chrome' },
  { grade: 'Cr-6', tier: 'weaver', iridescence: 0.6, gloss: 0.7, note: 'mirror chrome + weave sheen' },
  { grade: 'Cr-7', tier: 'architect', iridescence: 0.74, gloss: 0.8, note: 'iridescent architectural plate' },
  { grade: 'Cr-9', tier: 'sovereign', iridescence: 0.92, gloss: 0.92, note: 'genesis unmask plate' },
]);

/** Semantic surfaces. Bright by default: the HUD is a *daylight* instrument. */
const SURFACES = Object.freeze({
  bright: { label: 'Bright Chromium', base: 'light', note: 'default premium daylight HUD' },
  dusk: { label: 'Dusk Alloy', base: 'dark', note: 'night ops, low-blue emission' },
  scan: { label: 'Scan Glass', base: 'light', note: 'AR passthrough, max legibility' },
});

/* ── colour maths (no dependencies, tiny and exact enough for UI) ────────── */

function hslToHex(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const rgb = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return `#${rgb
    .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** WCAG-ish relative luminance → contrast ratio, used to keep text legible. */
function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return round((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05), 2);
}

/**
 * Nudge lightness until the colour clears a contrast target against a surface.
 * This is what makes the "brighter, cleaner, premium" pass *accessible* rather
 * than merely pretty.
 */
function ensureContrast(h, s, l, background, target = 4.5) {
  let lightness = l;
  const bgLum = luminance(background);
  const direction = bgLum > 0.5 ? -1 : 1; // darken on light bg, brighten on dark
  for (let i = 0; i < 60; i += 1) {
    const hex = hslToHex(h, s, lightness);
    if (contrastRatio(hex, background) >= target) return { hex, lightness };
    lightness = clamp(lightness + direction * 1.5, 0, 100);
  }
  return { hex: hslToHex(h, s, lightness), lightness };
}

/* ───────────────────────────── alloy derivation ─────────────────────────── */

/**
 * Derive a complete chromium alloy from a seed.
 *
 * @param {object} opts
 * @param {string} opts.seed            genesis seed (or per-player seed)
 * @param {string} [opts.surface]       SURFACES key
 * @param {string} [opts.grade]         GRADES grade id, e.g. 'Cr-7'
 * @param {string} [opts.label]         human label for the alloy
 */
function deriveAlloy({ seed, surface = 'bright', grade = 'Cr-5', label = null }) {
  const rng = createRng(`chromium|${PROTOCOL_VERSION}|${seed}|${surface}|${grade}`);
  const surfaceSpec = SURFACES[surface] || SURFACES.bright;
  const gradeSpec = GRADES.find((g) => g.grade === grade) || GRADES[2];

  // Hue triad: a primary anchored anywhere on the wheel, plus a neighbouring
  // iridescence pair. Triads keep generated palettes harmonious by construction.
  const primaryHue = rng.range(0, 359);
  const hueSpread = rng.range(24, 68);
  const hues = {
    primary: primaryHue,
    iridescentA: (primaryHue + hueSpread) % 360,
    iridescentB: (primaryHue - hueSpread + 360) % 360,
    signal: (primaryHue + 150 + rng.range(-18, 18)) % 360,
  };

  const isLight = surfaceSpec.base === 'light';
  const bg = isLight ? hslToHex(hues.primary, rng.range(18, 32), rng.range(96, 99)) : hslToHex(hues.primary, rng.range(20, 34), rng.range(6, 10));
  const panel = isLight ? '#ffffff' : hslToHex(hues.primary, 22, 13);

  const accent = ensureContrast(hues.primary, rng.range(72, 92), isLight ? 46 : 62, panel, 4.5);
  const accent2 = ensureContrast(hues.iridescentA, rng.range(70, 90), isLight ? 44 : 64, panel, 4.5);
  const accent3 = ensureContrast(hues.iridescentB, rng.range(66, 88), isLight ? 42 : 66, panel, 4.5);
  const success = ensureContrast(rng.range(140, 165), 72, isLight ? 34 : 58, panel, 4.5);
  const warning = ensureContrast(rng.range(32, 46), 92, isLight ? 38 : 60, panel, 4.5);
  const danger = ensureContrast(rng.range(350, 362), 82, isLight ? 42 : 62, panel, 4.5);

  const ink = isLight ? hslToHex(hues.primary, 28, 12) : hslToHex(hues.primary, 18, 96);
  const muted = isLight ? hslToHex(hues.primary, 14, 42) : hslToHex(hues.primary, 12, 72);

  const alloy = {
    id: hashHex('alloy', seed, surface, grade).slice(0, 16),
    address: deriveAddress({ domain: 'CHR', seed, label: `${surface}:${grade}`, sublabel: label || 'alloy' }).address,
    evmAddress: deriveAddress({ domain: 'CHR', seed, label: `${surface}:${grade}`, sublabel: label || 'alloy' }).evm,
    label: label || `${surfaceSpec.label} · ${gradeSpec.grade}`,
    seedFingerprint: hashHex('chromium-fingerprint', seed).slice(0, 24),
    surface: { id: surface, ...surfaceSpec },
    grade: { ...gradeSpec },
    hues,
    colors: {
      bg,
      bgAccent: isLight ? hslToHex(hues.iridescentA, 60, 95) : hslToHex(hues.iridescentA, 40, 14),
      panel,
      panelAlt: isLight ? hslToHex(hues.primary, 30, 98) : hslToHex(hues.primary, 20, 16),
      ink,
      muted,
      line: isLight ? `rgba(${hexToRgbTriples(bg)}, 0.16)` : `rgba(255,255,255,0.12)`,
      accent: accent.hex,
      accent2: accent2.hex,
      accent3: accent3.hex,
      signal: ensureContrast(hues.signal, 84, isLight ? 44 : 62, panel, 3.2).hex,
      success: success.hex,
      warning: warning.hex,
      danger: danger.hex,
    },
    material: {
      glassOpacity: round(isLight ? 0.72 + gradeSpec.gloss * 0.18 : 0.5 + gradeSpec.gloss * 0.3, 3),
      blurPx: Math.round(10 + gradeSpec.gloss * 22),
      radius: { sm: 10, md: 16, lg: 24, pill: 999 },
      elevation: [
        '0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.10)',
        '0 4px 10px rgba(16,24,40,0.07), 0 2px 4px rgba(16,24,40,0.06)',
        '0 12px 28px rgba(16,24,40,0.10), 0 4px 10px rgba(16,24,40,0.06)',
        '0 24px 60px rgba(16,24,40,0.14), 0 8px 20px rgba(16,24,40,0.08)',
      ],
      iridescence: gradeSpec.iridescence,
      sheen: `linear-gradient(115deg, ${accent.hex}${alphaHex(gradeSpec.iridescence * 0.5)} 0%, ${accent2.hex}${alphaHex(gradeSpec.iridescence * 0.42)} 42%, ${accent3.hex}${alphaHex(gradeSpec.iridescence * 0.5)} 78%, ${accent.hex}${alphaHex(gradeSpec.iridescence * 0.34)} 100%)`,
      hairline: `linear-gradient(90deg, transparent, ${accent.hex}${alphaHex(0.55)}, ${accent2.hex}${alphaHex(0.4)}, transparent)`,
    },
    type: {
      familyUi: "'Inter', 'SF Pro Display', system-ui, -apple-system, 'Segoe UI', sans-serif",
      familyMono: "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
      scale: { xs: 11, sm: 13, base: 15, md: 17, lg: 21, xl: 28, display: 40 },
      tracking: { hud: '0.14em', body: '0.005em' },
    },
    motion: { fast: 120, base: 220, slow: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    contrast: {
      accentOnPanel: contrastRatio(accent.hex, panel),
      inkOnPanel: contrastRatio(ink, panel),
      mutedOnPanel: contrastRatio(muted, panel),
      aa: contrastRatio(ink, panel) >= 4.5,
      aaa: contrastRatio(ink, panel) >= 7,
    },
    arHud: {
      reticle: {
        stroke: accent.hex,
        strokeWidth: 1.5,
        radius: 46,
        ticks: 12,
        sweepDurationMs: 2400,
        glow: `${accent.hex}${alphaHex(0.35)}`,
      },
      scanline: { color: accent2.hex, opacity: round(0.18 + gradeSpec.iridescence * 0.3, 2), speedMs: 3200 },
      layers: {
        scan: { tint: accent.hex, weight: 1.4 },
        mission: { tint: accent2.hex, weight: 1.8 },
        map: { tint: accent3.hex, weight: 1.1 },
        threat: { tint: danger.hex, weight: 2.0 },
        glyph: { tint: success.hex, weight: 1.2 },
      },
      anchorMarker: 'diamond',
      maxContacts: 24,
    },
  };

  return alloy;
}

function hexToRgbTriples(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)).join(',');
}

function alphaHex(alpha01) {
  const a = clamp(alpha01, 0, 1);
  return Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
}

/* ────────────────────────────── CSS emission ────────────────────────────── */

/**
 * Emit the generated chromium stylesheet (CSS custom properties + a handful of
 * utility classes). Served at GET /ui/chromium.css so the HUD theme is always
 * in lockstep with the network seed — never a stale committed hex value.
 */
function toCss(alloy) {
  const { colors, material, type, motion, arHud } = alloy;
  const lines = [
    `/* ═══ ENTROPY CHROMIUM — generated, do not edit ═══`,
    `   alloy      : ${alloy.label}`,
    `   address    : ${alloy.address}`,
    `   seed fp    : ${alloy.seedFingerprint}`,
    `   grade      : ${alloy.grade.grade} (iridescence ${material.iridescence})`,
    `   contrast   : ink ${alloy.contrast.inkOnPanel}:1 · accent ${alloy.contrast.accentOnPanel}:1 (${alloy.contrast.aaa ? 'AAA' : alloy.contrast.aa ? 'AA' : 'review'})`,
    `   generated  : ${new Date().toISOString()}`,
    `   ═══════════════════════════════════════════════ */`,
    ``,
    `:root {`,
    /* Tells the browser which chrome to draw (scrollbars, inputs, canvas).
       Without this a bright alloy still gets dark native widgets. */
    `  color-scheme: ${alloy.surface.base};`,
    `  --ent-surface: ${alloy.surface.id};`,
    `  --ent-grade: ${alloy.grade.grade};`,
    `  --ent-base: ${alloy.surface.base};`,
    ``,
    `  --bg: ${colors.bg};`,
    `  --bg-accent: ${colors.bgAccent};`,
    `  --panel: ${colors.panel};`,
    `  --panel-alt: ${colors.panelAlt};`,
    `  --ink: ${colors.ink};`,
    `  --muted: ${colors.muted};`,
    `  --line: ${colors.line};`,
    `  --accent: ${colors.accent};`,
    `  --accent-2: ${colors.accent2};`,
    `  --accent-3: ${colors.accent3};`,
    `  --signal: ${colors.signal};`,
    `  --success: ${colors.success};`,
    `  --warning: ${colors.warning};`,
    `  --danger: ${colors.danger};`,
    ``,
    `  --glass: ${material.glassOpacity};`,
    `  --blur: ${material.blurPx}px;`,
    `  --r-sm: ${material.radius.sm}px;`,
    `  --r-md: ${material.radius.md}px;`,
    `  --r-lg: ${material.radius.lg}px;`,
    `  --r-pill: ${material.radius.pill}px;`,
    `  --el-1: ${material.elevation[0]};`,
    `  --el-2: ${material.elevation[1]};`,
    `  --el-3: ${material.elevation[2]};`,
    `  --el-4: ${material.elevation[3]};`,
    `  --sheen: ${material.sheen};`,
    `  --hairline: ${material.hairline};`,
    ``,
    `  --font-ui: ${type.familyUi};`,
    `  --font-mono: ${type.familyMono};`,
    `  --fs-xs: ${type.scale.xs}px;`,
    `  --fs-sm: ${type.scale.sm}px;`,
    `  --fs-base: ${type.scale.base}px;`,
    `  --fs-md: ${type.scale.md}px;`,
    `  --fs-lg: ${type.scale.lg}px;`,
    `  --fs-xl: ${type.scale.xl}px;`,
    `  --fs-display: ${type.scale.display}px;`,
    `  --track-hud: ${type.tracking.hud};`,
    ``,
    `  --t-fast: ${motion.fast}ms;`,
    `  --t-base: ${motion.base}ms;`,
    `  --t-slow: ${motion.slow}ms;`,
    `  --ease: ${motion.easing};`,
    ``,
    `  --ar-reticle: ${arHud.reticle.stroke};`,
    `  --ar-reticle-glow: ${arHud.reticle.glow};`,
    `  --ar-scanline: ${arHud.scanline.color};`,
    `  --ar-layer-scan: ${arHud.layers.scan.tint};`,
    `  --ar-layer-mission: ${arHud.layers.mission.tint};`,
    `  --ar-layer-map: ${arHud.layers.map.tint};`,
    `  --ar-layer-threat: ${arHud.layers.threat.tint};`,
    `  --ar-layer-glyph: ${arHud.layers.glyph.tint};`,
    `}`,
    ``,
    `.ent-sheen { background-image: var(--sheen); }`,
    `.ent-hairline { background-image: var(--hairline); height: 1px; border: 0; }`,
    `.ent-glass {`,
    `  background: color-mix(in srgb, var(--panel) calc(var(--glass) * 100%), transparent);`,
    `  backdrop-filter: blur(var(--blur)) saturate(140%);`,
    `  border: 1px solid var(--line);`,
    `}`,
    `.ent-plate { box-shadow: var(--el-2); border-radius: var(--r-md); }`,
    `.ent-grade::after { content: "${alloy.grade.grade}"; font-family: var(--font-mono); letter-spacing: var(--track-hud); }`,
    ``,
    `@media (prefers-reduced-motion: reduce) {`,
    `  * { animation-duration: 1ms !important; transition-duration: 1ms !important; }`,
    `}`,
  ];
  return lines.join('\n');
}

/* ──────────────────────────── integrity plating ─────────────────────────── */

/**
 * Plate (seal) a payload with entropy chromium.
 *
 * @param {object} payload
 * @param {object} opts
 * @param {string} opts.seed   network genesis seed
 * @param {Buffer|string} opts.masterKey  keyring master key
 * @param {string} [opts.subject]
 * @param {string} [opts.kind]
 * @returns {{plate:string, contentHash:string, address:string, platedAt:string, grade:string, verify:(p:string)=>boolean}}
 */
function plate(payload, { seed, masterKey, subject = 'system', kind = 'payload', grade = 'Cr-5' }) {
  const contentHash = contentAddress(payload);
  const plateBody = hmac(masterKey, 'chrome-plate', PROTOCOL_VERSION, kind, subject, contentHash).toString('hex').slice(0, 16);
  const plateString = `chrp.v1.${grade}.${contentHash.slice(0, 16)}.${plateBody}`;
  return {
    plate: plateString,
    contentHash,
    address: deriveAddress({ domain: 'CHR', seed, label: contentHash, sublabel: kind }).address,
    platedAt: new Date().toISOString(),
    grade,
    subject,
    kind,
  };
}

/** Verify a plate string against a payload. Constant-time on the HMAC half. */
function verifyPlate(plateString, payload, { masterKey, subject = 'system', kind = 'payload' }) {
  if (typeof plateString !== 'string') return { valid: false, reason: 'plate missing' };
  const parts = plateString.split('.');
  if (parts.length !== 5 || parts[0] !== 'chrp' || parts[1] !== 'v1') return { valid: false, reason: 'malformed plate' };
  const contentHash = contentAddress(payload);
  if (parts[3] !== contentHash.slice(0, 16)) return { valid: false, reason: 'payload hash mismatch', expected: contentHash.slice(0, 16) };
  const expected = hmac(masterKey, 'chrome-plate', PROTOCOL_VERSION, kind, subject, contentHash).toString('hex').slice(0, 16);
  const a = Buffer.from(parts[4], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const ok = a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
  return { valid: ok, reason: ok ? null : 'signature mismatch', contentHash, grade: parts[2] };
}

/** Grade lookup for a tier. */
function gradeForTier(tier) {
  return (GRADES.find((g) => g.tier === tier) || GRADES[2]).grade;
}

module.exports = {
  GRADES,
  SURFACES,
  deriveAlloy,
  toCss,
  plate,
  verifyPlate,
  gradeForTier,
  hslToHex,
  contrastRatio,
  ensureContrast,
  alphaHex,
};
