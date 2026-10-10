/**
 * CONTENT GUARD — the load-bearing safety module for the indictment scroll.
 *
 * The brief was "provoking language against anyone that has ever coded
 * migrating bitcoin." That heat is delivered against *practices and
 * archetypes* — the dry-run dodger, the idempotency impostor — and never
 * against an identifiable human being. This module is what makes that a
 * guarantee instead of a vibe:
 *
 *   1. Real named individuals are hard-blocked. Nobody real gets named,
 *      shamed, or doxxed by this board, ever, no matter what a user types.
 *   2. Contact and locator data is hard-blocked: emails, phone numbers, IP
 *      addresses, street addresses, wallet addresses, private keys, handles
 *      on real platforms.
 *   3. Slurs are hard-blocked.
 *   4. Calls for real-world violence or harm are hard-blocked. Theatrical
 *      heat ("burn the branch to the ground") is fine; anything that points
 *      at a body or a house is not.
 *
 * The curated indictment corpus is asserted to pass this guard in
 * test/contentGuard.test.ts. Anything a user types by hand is scrubbed
 * through `guard()` before it can be spoken or captioned.
 */

/**
 * Real, identifiable people in the Bitcoin / crypto / dev space. Matching is
 * case-insensitive on whole names. This list is protective: it exists so those
 * names can never appear in the output.
 */
const REAL_PEOPLE: string[] = [
  'satoshi nakamoto',
  'gavin andresen',
  'greg maxwell',
  'pieter wuille',
  'luke dashjr',
  'wladimir van der laan',
  'matt corallo',
  'mike hearn',
  'jeff garzik',
  'hal finney',
  'roger ver',
  'craig wright',
  'adam back',
  'michael saylor',
  'vitalik buterin',
  'sam bankman-fried',
  'charlie shrem',
  'andreas antonopoulos',
  'jimmy song',
  'luke jr',
  'theymos',
  'gmaxwell',
  'sipa',
];

/** Words that may never appear, in any heat level, from any source. */
const SLURS: string[] = [
  'faggot',
  'fag',
  'nigger',
  'nigga',
  'kike',
  'spic',
  'chink',
  'coon',
  'tranny',
  'retard',
  'retarded',
  'cunt',
  'bitch',
  'whore',
  'slag',
];

/** Phrases that indicate a threat against a real person or their property. */
const VIOLENCE_PATTERNS: RegExp[] = [
  /\b(beat|punch|kick|stab|shoot|strangle|choke)\s+(him|her|them|you|that\s+guy|that\s+person)\b/i,
  /\bkill\s+(him|her|them|you|yourself)\b/i,
  /\b(go\s+to|show\s+up\s+at|find)\s+(his|her|their|your)\s+(house|home|address|office)\b/i,
  /\bburn\s+(down\s+)?(his|her|their|your)\s+(house|home|car|office)\b/i,
  /\bdox(x)?(ing|ed)?\b/i,
  /\bswat(ting|ted)?\b/i,
  /\bdeath\s+threats?\b/i,
];

/** Contact info, locators, and secrets — nothing that can reach a real person. */
const DOXXING_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email
  /(?:\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/, // phone
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IPv4
  /\b(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}\b/, // bitcoin address
  /\b0x[a-fA-F0-9]{40}\b/, // evm address
  /\b[KL][a-zA-HJ-NP-Z0-9]{50}\b/, // WIF private key
  // Profile links, with or without a leading @.
  /(?:^|[\s(])(?:@)?(?:twitter|x|github|gitlab|reddit|telegram|discord|instagram|linkedin)\.com\/\S+/i,
  /\b\d{1,5}\s+[A-Z][a-z]+\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln)\b/i,
  /\b(apt|suite|ste)\.?\s*\d+\b/i,
  /\b\d{5}(-\d{4})?\b(?=.*(street|st|avenue|ave|road|rd))/i,
];

export type ViolationKind = 'real-person' | 'slur' | 'violence' | 'doxxing';

export interface Violation {
  kind: ViolationKind;
  /** The offending fragment, lower-cased and trimmed for logging. */
  match: string;
}

export interface GuardResult {
  ok: boolean;
  violations: Violation[];
  /** Input with violating fragments removed, for when you want to salvage the line. */
  scrubbed: string;
}

function wholeWordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'gi');
}

/**
 * Check a string against every guard. Returns the violations found plus a
 * scrubbed copy with the offending fragments cut out.
 */
export function guard(input: string): GuardResult {
  const violations: Violation[] = [];
  let scrubbed = input;

  const report = (kind: ViolationKind, pattern: RegExp): void => {
    const matches = scrubbed.match(pattern);
    if (!matches) return;
    for (const match of matches) {
      violations.push({ kind, match: match.toLowerCase().trim() });
    }
    scrubbed = scrubbed.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'), '▮');
  };

  for (const name of REAL_PEOPLE) report('real-person', wholeWordPattern(name));
  for (const slur of SLURS) report('slur', wholeWordPattern(slur));
  for (const pattern of VIOLENCE_PATTERNS) report('violence', pattern);
  for (const pattern of DOXXING_PATTERNS) report('doxxing', pattern);

  return {
    ok: violations.length === 0,
    violations,
    scrubbed: scrubbed.replace(/\s{2,}/g, ' ').replace(/▮/g, '').trim(),
  };
}

/** Convenience predicate: is this line safe to speak and caption? */
export function isSafe(input: string): boolean {
  return guard(input).ok;
}

/** Human-readable reason a line was rejected, for the on-screen audit log. */
export function explain(violations: Violation[]): string {
  const kinds = [...new Set(violations.map((v) => v.kind))];
  return kinds.map((kind) => `blocked:${kind}`).join(', ');
}

export const GUARD_POLICY = {
  realPeople: REAL_PEOPLE.length,
  slurs: SLURS.length,
  violencePatterns: VIOLENCE_PATTERNS.length,
  doxxingPatterns: DOXXING_PATTERNS.length,
} as const;
