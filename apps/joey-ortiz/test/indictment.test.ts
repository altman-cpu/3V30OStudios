import { describe, expect, it } from 'vitest';
import { explain, guard, GUARD_POLICY, isSafe } from '../src/lib/contentGuard';
import { ALL_IDS, buildProclamation, HEAT_LEVELS, INDICTED } from '../src/lib/indictment';

/**
 * These tests are the safety contract for the indictment scroll. The corpus is
 * allowed to be loud; it is not allowed to name, contact, or threaten a real
 * person, at any heat level.
 */

describe('contentGuard blocks real people', () => {
  it('rejects a real name in an otherwise clean line', () => {
    const result = guard('Blame Satoshi Nakamoto for the migration script.');
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain('real-person');
  });

  it('is case-insensitive', () => {
    expect(isSafe('GAVIN ANDRESEN shipped it')).toBe(false);
  });

  it('does not false-positive on ordinary words', () => {
    expect(isSafe('The dry-run dodger shipped a migration on a Friday.')).toBe(true);
    expect(isSafe('Satoshis in, dollars out.')).toBe(true);
  });
});

describe('contentGuard blocks contact data and secrets', () => {
  it.each([
    ['an email', 'reach them at dev@example.com'],
    ['a phone number', 'call 555-867-5309'],
    ['an ipv4 address', 'host is 192.168.10.42'],
    ['a bitcoin address', 'sent to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'],
    ['an evm address', 'wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],
    ['a profile link', 'see github.com/someone/repo'],
    ['a street address', 'they live at 742 Evergreen Street'],
  ])('rejects %s', (_label, text) => {
    expect(isSafe(text)).toBe(false);
  });
});

describe('contentGuard blocks slurs and real-world threats', () => {
  it('rejects a slur', () => {
    expect(isSafe('what a retard')).toBe(false);
  });

  it('rejects a threat against a person', () => {
    expect(isSafe('go to their house tonight')).toBe(false);
    expect(isSafe('kill him')).toBe(false);
  });

  it('allows theatrical heat aimed at code', () => {
    expect(isSafe('Burn the branch to the ground.')).toBe(true);
    expect(isSafe('Scorched earth for that migration.')).toBe(true);
  });
});

describe('guard() scrubs rather than only rejecting', () => {
  it('removes the offending fragment and keeps the rest', () => {
    const result = guard('The script was fine until dev@example.com touched it');
    expect(result.ok).toBe(false);
    expect(result.scrubbed).toContain('The script was fine until');
    expect(result.scrubbed).not.toContain('dev@example.com');
  });

  it('explains violations in a stable format', () => {
    const result = guard('dev@example.com says hi');
    expect(explain(result.violations)).toBe('blocked:doxxing');
  });
});

describe('the indictment corpus is safe at every heat level', () => {
  it('has twelve archetypes with a verdict for each of five heat levels', () => {
    expect(INDICTED).toHaveLength(12);
    for (const entry of INDICTED) {
      expect(HEAT_LEVELS).toHaveLength(5);
      for (const level of HEAT_LEVELS) {
        expect(entry.verdicts[level.level], `${entry.id} @ heat ${level.level}`).toBeTruthy();
      }
      expect(entry.charges.length).toBeGreaterThan(0);
      expect(entry.who).toBeTruthy();
      expect(entry.why).toBeTruthy();
    }
  });

  it('every WHO, WHY, charge and verdict passes the guard', () => {
    const failures: string[] = [];
    for (const entry of INDICTED) {
      const candidates = [
        entry.who,
        entry.why,
        ...entry.charges,
        ...HEAT_LEVELS.map((level) => entry.verdicts[level.level]),
      ];
      for (const text of candidates) {
        if (!isSafe(text)) failures.push(`${entry.id}: ${text}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('builds a clean, non-empty proclamation at every heat level', () => {
    for (const level of HEAT_LEVELS) {
      const proclamation = buildProclamation([...ALL_IDS], level.level);
      expect(proclamation.violations, `heat ${level.level}`).toEqual([]);
      expect(proclamation.lines.length).toBeGreaterThan(0);
      expect(proclamation.heatName).toBe(level.name);
    }
  });

  it('only includes the archetypes that were selected', () => {
    const one = buildProclamation(['dryrun-dodger'], 3);
    const text = one.lines.join(' ');
    expect(text).toContain('THE DRY-RUN DODGER');
    expect(text).not.toContain('THE UTXO BUTCHER');
  });

  it('states the scope disclaimer at the two hottest levels', () => {
    expect(buildProclamation([...ALL_IDS], 4).lines.join(' ')).toContain('Never at a named human being');
    expect(buildProclamation([...ALL_IDS], 5).lines.join(' ')).toContain('Never at a named human being');
    expect(buildProclamation([...ALL_IDS], 2).lines.join(' ')).not.toContain('Never at a named human being');
  });
});

describe('the guard is not decorative', () => {
  it('is configured with real blocklists', () => {
    expect(GUARD_POLICY.realPeople).toBeGreaterThan(10);
    expect(GUARD_POLICY.slurs).toBeGreaterThan(0);
    expect(GUARD_POLICY.violencePatterns).toBeGreaterThan(0);
    expect(GUARD_POLICY.doxxingPatterns).toBeGreaterThan(0);
  });

  it('would catch a name smuggled into a tampered corpus', () => {
    // Simulates someone editing the corpus to name a real engineer: the
    // proclamation builder must drop the line rather than speak it.
    const poisoned = 'The blame belongs to Satoshi Nakamoto and nobody else.';
    expect(isSafe(poisoned)).toBe(false);
  });
});
