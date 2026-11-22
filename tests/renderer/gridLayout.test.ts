/** Layout maths of the week grid. */
import { describe, expect, it } from 'vitest';
import type { SlotMinutes } from '@shared/types';
import { SLOT_HEIGHT, hasTimeLabel, layoutDay, pixelsPerMinute, slotStarts, type Placement, type Span } from '@renderer/components/grid/layout';

function span(id: string, start: number, end: number): Span {
  return { id, start, end };
}

function plain(result: Map<string, Placement>): Record<string, Placement> {
  return Object.fromEntries([...result.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Small seeded PRNG (mulberry32) so failures can be reproduced. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Groups of transitively overlapping spans, computed the slow, obvious way. */
function groupsOf(spans: readonly Span[]): Span[][] {
  const parent = new Map<string, string>(spans.map((s) => [s.id, s.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  for (const a of spans) for (const b of spans) if (a.id < b.id && overlaps(a, b)) parent.set(find(a.id), find(b.id));
  const groups = new Map<string, Span[]>();
  for (const s of spans) {
    const root = find(s.id);
    groups.set(root, [...(groups.get(root) ?? []), s]);
  }
  return [...groups.values()];
}

/** The largest number of spans running at the same moment. */
function maxConcurrent(spans: readonly Span[]): number {
  let best = 0;
  for (const at of spans) best = Math.max(best, spans.filter((s) => s.start <= at.start && at.start < s.end).length);
  return best;
}

function checkInvariants(spans: readonly Span[], label: string): void {
  const result = layoutDay(spans);
  expect(result.size, label).toBe(spans.length);
  for (const s of spans) {
    const p = result.get(s.id);
    expect(p, `${label}: placement of ${s.id}`).toBeDefined();
    if (!p) continue;
    expect(Number.isInteger(p.column), label).toBe(true);
    expect(p.column, label).toBeGreaterThanOrEqual(0);
    expect(p.columns, label).toBeGreaterThanOrEqual(1);
    expect(p.column, `${label}: column < columns for ${s.id}`).toBeLessThan(p.columns);
  }
  for (const a of spans) {
    for (const b of spans) {
      if (a.id >= b.id || !overlaps(a, b)) continue;
      const pa = result.get(a.id) as Placement;
      const pb = result.get(b.id) as Placement;
      expect(pa.column, `${label}: ${a.id} and ${b.id} overlap but share a column`).not.toBe(pb.column);
      expect(pa.columns, `${label}: ${a.id} and ${b.id} overlap but differ in width`).toBe(pb.columns);
    }
  }
  for (const group of groupsOf(spans)) {
    const widths = new Set(group.map((s) => (result.get(s.id) as Placement).columns));
    expect(widths.size, `${label}: one width per group`).toBe(1);
    // no wasted space: the group is exactly as wide as its busiest moment
    expect([...widths][0], `${label}: group width`).toBe(maxConcurrent(group));
    // every column of the group is used
    const used = new Set(group.map((s) => (result.get(s.id) as Placement).column));
    expect(used.size, `${label}: all columns used`).toBe([...widths][0]);
  }
}

describe('layoutDay', () => {
  it('returns an empty map for an empty day', () => {
    expect(layoutDay([]).size).toBe(0);
  });

  it('gives a single event the full width', () => {
    expect(plain(layoutDay([span('a', 540, 600)]))).toEqual({ a: { column: 0, columns: 1 } });
  });

  it('gives events that do not overlap the full width each', () => {
    const result = layoutDay([span('a', 480, 540), span('b', 600, 660), span('c', 720, 780)]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 1 },
      b: { column: 0, columns: 1 },
      c: { column: 0, columns: 1 },
    });
  });

  it('puts two overlapping events side by side, the earlier one first', () => {
    const result = layoutDay([span('late', 570, 660), span('early', 540, 600)]);
    expect(plain(result)).toEqual({
      early: { column: 0, columns: 2 },
      late: { column: 1, columns: 2 },
    });
  });

  it('puts the longer of two events with the same start first', () => {
    const result = layoutDay([span('short', 540, 570), span('long', 540, 660)]);
    expect(plain(result)).toEqual({
      long: { column: 0, columns: 2 },
      short: { column: 1, columns: 2 },
    });
  });

  it('chain A-B, B-C without A-C: two columns, C reuses the column of A', () => {
    const result = layoutDay([span('a', 480, 540), span('b', 510, 570), span('c', 540, 600)]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 2 },
      b: { column: 1, columns: 2 },
      c: { column: 0, columns: 2 },
    });
  });

  it('identical times: side by side, ordered by id', () => {
    const result = layoutDay([span('b', 540, 600), span('c', 540, 600), span('a', 540, 600)]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 3 },
      b: { column: 1, columns: 3 },
      c: { column: 2, columns: 3 },
    });
  });

  it('an event that starts exactly when another ends does not overlap it', () => {
    const result = layoutDay([span('a', 480, 540), span('b', 540, 600)]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 1 },
      b: { column: 0, columns: 1 },
    });
  });

  it('a group followed by a separate group: each group has its own width', () => {
    const result = layoutDay([span('a', 480, 540), span('b', 510, 570), span('c', 600, 660)]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 2 },
      b: { column: 1, columns: 2 },
      c: { column: 0, columns: 1 },
    });
  });

  it('a group that ends exactly where the next begins is closed', () => {
    const result = layoutDay([
      span('a', 480, 570),
      span('b', 510, 570),
      span('c', 540, 570),
      span('d', 570, 630),
      span('e', 600, 660),
    ]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 3 },
      b: { column: 1, columns: 3 },
      c: { column: 2, columns: 3 },
      d: { column: 0, columns: 2 },
      e: { column: 1, columns: 2 },
    });
  });

  it('a long event next to three short ones in a row', () => {
    const result = layoutDay([span('long', 480, 660), span('s1', 480, 540), span('s2', 540, 600), span('s3', 600, 660)]);
    expect(plain(result)).toEqual({
      long: { column: 0, columns: 2 },
      s1: { column: 1, columns: 2 },
      s2: { column: 1, columns: 2 },
      s3: { column: 1, columns: 2 },
    });
  });

  it('reuses a column as soon as it is free', () => {
    // a (column 2) ends at 510, so d takes its column while b and c are still running
    const result = layoutDay([span('a', 480, 510), span('b', 480, 600), span('c', 480, 600), span('d', 510, 540)]);
    expect(result.get('d')).toEqual({ column: 2, columns: 3 });
    expect(result.get('a')).toEqual({ column: 2, columns: 3 });
    expect(result.get('b')).toEqual({ column: 0, columns: 3 });
    expect(result.get('c')).toEqual({ column: 1, columns: 3 });
  });

  it('does not depend on the order of the input and does not change it', () => {
    const spans = [span('a', 480, 540), span('b', 510, 570), span('c', 540, 600), span('d', 700, 760), span('e', 700, 760)];
    const expected = plain(layoutDay(spans));
    const copy = spans.map((s) => ({ ...s }));
    const random = prng(7);
    for (let round = 0; round < 30; round++) {
      const shuffled = [...spans].sort(() => random() - 0.5);
      expect(plain(layoutDay(shuffled))).toEqual(expected);
    }
    layoutDay(spans);
    expect(spans).toEqual(copy);
  });

  it('handles minutes that are not on the 15-minute raster (hand-edited files)', () => {
    const result = layoutDay([span('a', 481, 533), span('b', 532, 540), span('c', 533, 534)]);
    expect(plain(result)).toEqual({
      a: { column: 0, columns: 2 },
      b: { column: 1, columns: 2 },
      c: { column: 0, columns: 2 },
    });
  });

  it('handles a full day of back-to-back events and one all-day event', () => {
    const spans = [span('all', 0, 1440)];
    for (let m = 0; m < 1440; m += 15) spans.push(span(`q${String(m).padStart(4, '0')}`, m, m + 15));
    const result = layoutDay(spans);
    expect(result.get('all')).toEqual({ column: 0, columns: 2 });
    for (const s of spans.slice(1)) expect(result.get(s.id)).toEqual({ column: 1, columns: 2 });
  });

  it('keeps the invariants for the hand-written cases', () => {
    checkInvariants([span('a', 480, 540), span('b', 510, 570), span('c', 540, 600)], 'chain');
    checkInvariants([span('a', 540, 600), span('b', 540, 600), span('c', 540, 600)], 'identical');
    checkInvariants([span('a', 480, 540), span('b', 540, 600)], 'touching');
    checkInvariants([span('a', 480, 540), span('b', 510, 570), span('c', 600, 660)], 'two groups');
    checkInvariants(
      [span('a', 0, 1440), span('b', 60, 120), span('c', 90, 150), span('d', 100, 110), span('e', 150, 151), span('f', 1439, 1440)],
      'nested',
    );
  });

  it('property: placements are valid, overlapping events never share a column, groups are as narrow as possible', () => {
    const random = prng(20261122);
    const int = (max: number): number => Math.floor(random() * max);
    for (let round = 0; round < 400; round++) {
      const count = int(14);
      const density = 1 + int(4);
      const spans: Span[] = [];
      for (let i = 0; i < count; i++) {
        // mostly on the 15-minute raster, sometimes arbitrary minutes
        const step = random() < 0.8 ? 15 : 1;
        const slots = 1440 / step;
        const start = int(Math.floor(slots / density)) * step;
        const length = (1 + int(Math.max(1, Math.floor(slots / (4 * density))))) * step;
        spans.push(span(`e${String(i).padStart(2, '0')}`, start, Math.min(1440, start + length)));
      }
      checkInvariants(spans, `seed 20261122, round ${round}: ${JSON.stringify(spans)}`);
    }
  });

  it('property: many events with identical or touching times', () => {
    const random = prng(99);
    const int = (max: number): number => Math.floor(random() * max);
    for (let round = 0; round < 200; round++) {
      const spans: Span[] = [];
      const count = 2 + int(10);
      for (let i = 0; i < count; i++) {
        const start = 480 + int(4) * 30;
        spans.push(span(`e${String(i).padStart(2, '0')}`, start, start + (1 + int(3)) * 30));
      }
      checkInvariants(spans, `seed 99, round ${round}: ${JSON.stringify(spans)}`);
    }
  });
});

describe('slotStarts', () => {
  it('lists the row starts from start up to, not including, end', () => {
    expect(slotStarts(480, 540, 15)).toEqual([480, 495, 510, 525]);
    expect(slotStarts(480, 600, 30)).toEqual([480, 510, 540, 570]);
    expect(slotStarts(480, 660, 45)).toEqual([480, 525, 570, 615]);
    expect(slotStarts(480, 660, 60)).toEqual([480, 540, 600]);
  });

  it('keeps a last, partial row when the day is not a multiple of the slot', () => {
    expect(slotStarts(480, 550, 30)).toEqual([480, 510, 540]);
    expect(slotStarts(480, 615, 60)).toEqual([480, 540, 600]);
    expect(slotStarts(0, 100, 45)).toEqual([0, 45, 90]);
  });

  it('covers the whole day', () => {
    expect(slotStarts(0, 1440, 15)).toHaveLength(96);
    expect(slotStarts(0, 1440, 30)).toHaveLength(48);
    expect(slotStarts(0, 1440, 45)).toHaveLength(32);
    expect(slotStarts(0, 1440, 60)).toHaveLength(24);
    expect(slotStarts(0, 1440, 60).at(-1)).toBe(1380);
  });

  it('is empty when start is not before end', () => {
    expect(slotStarts(600, 600, 15)).toEqual([]);
    expect(slotStarts(660, 600, 30)).toEqual([]);
  });

  it('never returns a mark at or after end, and the rows cover the day', () => {
    const slots: SlotMinutes[] = [15, 30, 45, 60];
    for (const slot of slots) {
      for (let start = 0; start < 1440; start += 135) {
        for (let end = start + 15; end <= 1440; end += 105) {
          const marks = slotStarts(start, end, slot);
          expect(marks[0]).toBe(start);
          expect(marks.length).toBe(Math.ceil((end - start) / slot));
          for (const mark of marks) expect(mark).toBeLessThan(end);
          expect((marks.at(-1) as number) + slot).toBeGreaterThanOrEqual(end);
        }
      }
    }
  });
});

describe('hasTimeLabel', () => {
  it('labels only :00 and :30 on a 15-minute grid', () => {
    expect(hasTimeLabel(480, 15)).toBe(true);
    expect(hasTimeLabel(495, 15)).toBe(false);
    expect(hasTimeLabel(510, 15)).toBe(true);
    expect(hasTimeLabel(525, 15)).toBe(false);
    expect(hasTimeLabel(0, 15)).toBe(true);
    expect(hasTimeLabel(1425, 15)).toBe(false);
  });

  it('labels every row on the wider grids', () => {
    const slots: SlotMinutes[] = [30, 45, 60];
    for (const slot of slots) {
      for (const minute of slotStarts(0, 1440, slot)) expect(hasTimeLabel(minute, slot)).toBe(true);
      for (const minute of slotStarts(15, 1440, slot)) expect(hasTimeLabel(minute, slot)).toBe(true);
    }
    expect(hasTimeLabel(525, 45)).toBe(true);
  });

  it('labels exactly every second row of a 15-minute grid that starts on a half hour', () => {
    const labelled = slotStarts(450, 600, 15).filter((minute) => hasTimeLabel(minute, 15));
    expect(labelled).toEqual([450, 480, 510, 540, 570]);
  });
});

describe('pixelsPerMinute', () => {
  it('is the row height divided by the row length', () => {
    expect(pixelsPerMinute(15)).toBeCloseTo(20 / 15, 10);
    expect(pixelsPerMinute(30)).toBeCloseTo(28 / 30, 10);
    expect(pixelsPerMinute(45)).toBeCloseTo(0.8, 10);
    expect(pixelsPerMinute(60)).toBeCloseTo(0.8, 10);
  });

  it('one row is SLOT_HEIGHT pixels high, for every slot size', () => {
    const slots: SlotMinutes[] = [15, 30, 45, 60];
    for (const slot of slots) {
      expect(SLOT_HEIGHT[slot]).toBeGreaterThan(0);
      expect(pixelsPerMinute(slot) * slot).toBeCloseTo(SLOT_HEIGHT[slot], 10);
    }
  });

  it('a finer grid is never more compact than a coarser one', () => {
    expect(pixelsPerMinute(15)).toBeGreaterThanOrEqual(pixelsPerMinute(30));
    expect(pixelsPerMinute(30)).toBeGreaterThanOrEqual(pixelsPerMinute(45));
    expect(pixelsPerMinute(45)).toBeGreaterThanOrEqual(pixelsPerMinute(60));
  });
});
