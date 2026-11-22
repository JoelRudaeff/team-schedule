/** Random ids. */
import { describe, expect, it } from 'vitest';
import { newId } from '@shared/ids';

describe('newId', () => {
  it('is 10 characters by default', () => {
    for (let i = 0; i < 100; i++) expect(newId()).toHaveLength(10);
  });

  it('honours the requested length', () => {
    for (const length of [1, 2, 5, 16, 64, 300]) expect(newId(length)).toHaveLength(length);
    expect(newId(0)).toBe('');
  });

  it('uses only a-z and 0-9', () => {
    for (let i = 0; i < 1000; i++) expect(newId()).toMatch(/^[a-z0-9]{10}$/);
    expect(newId(500)).toMatch(/^[a-z0-9]{500}$/);
  });

  it('is safe inside the file format and in item keys (no separators, quotes or white space)', () => {
    for (let i = 0; i < 200; i++) expect(newId()).not.toMatch(/[\s:;,."'\\/{}[\]|]/);
  });

  it('gives 10 000 different ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(newId());
    expect(ids.size).toBe(10_000);
  });

  it('uses the whole alphabet, at every position', () => {
    const seen = new Set<string>();
    const perPosition = Array.from({ length: 10 }, () => new Set<string>());
    for (let i = 0; i < 5000; i++) {
      const id = newId();
      for (let p = 0; p < id.length; p++) {
        seen.add(id[p]);
        perPosition[p].add(id[p]);
      }
    }
    expect(seen.size).toBe(36);
    for (const chars of perPosition) expect(chars.size).toBe(36);
  });

  it('is roughly uniform over the alphabet', () => {
    const counts = new Map<string, number>();
    const total = 72_000;
    const text = newId(total);
    for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = total / 36;
    // 256 % 36 = 4, so four characters are ~14 % more likely; anything beyond +-30 % is a bug.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    }
  });
});
