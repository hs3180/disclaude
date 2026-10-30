import { describe, expect, it } from 'vitest';
import * as coordination from './coordination/index.js';
import * as goals from './goals/index.js';
import * as root from './index.js';

/**
 * The root index re-exports the goals/coordination domain barrels wholesale.
 * `export *` silently drops names that collide across star-exports, so every
 * domain value must be asserted to still resolve at the root — otherwise a
 * future barrel could shadow a name without any build error.
 */
describe('core root barrel domain re-exports', () => {
  const barrels = { goals, coordination };
  for (const [domain, barrel] of Object.entries(barrels)) {
    it(`exposes every ${domain} barrel value export at the root`, () => {
      expect(Object.keys(barrel).length).toBeGreaterThan(0);
      for (const name of Object.keys(barrel)) {
        expect((root as Record<string, unknown>)[name], `${domain}.${name}`).toBeDefined();
      }
    });
  }
  it('keeps the domain barrels pairwise disjoint', () => {
    const names = Object.values(barrels).map(barrel => new Set(Object.keys(barrel)));
    for (const name of names[0]) { expect(names[1].has(name), name).toBe(false); }
  });
});
