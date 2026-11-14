import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as S } from '../time';
import type { Command } from './commands';
import { History } from './history';
import { emptyDocument, eqCodes, fadeAt, pictureAt, type ColorEffect } from './model';

const lookup = (id: string) =>
  id === 'clip'
    ? { kind: 'video' as const, duration: S(10), hasAudio: true, width: 1920, height: 1080 }
    : undefined;

function setup() {
  const h = new History(emptyDocument());
  const run = (c: Command) => h.execute(c, lookup);
  run({
    type: 'sequence.create',
    id: 's',
    name: 'S',
    width: 1080,
    height: 1920,
    fps: FRAME_RATES.fps30,
  });
  const v1 = h.doc.sequences[0]!.tracks[1]!.id;
  run({
    type: 'item.add',
    sequenceId: 's',
    trackId: v1,
    assetId: 'clip',
    start: S(1),
    duration: S(4),
    id: 'c',
  });
  const items = () => h.doc.sequences[0]!.tracks[1]!.items;
  return { h, run, items };
}

describe('fades and effects', () => {
  it('fades picture and sound in and out linearly at the clip ends', () => {
    const { run, items } = setup();
    run({ type: 'item.update', sequenceId: 's', itemId: 'c', fade: { in: S(1), out: S(0.5) } });
    const c = items()[0]!;
    expect(fadeAt(c, S(1))).toBe(0);
    expect(fadeAt(c, S(1.5))).toBeCloseTo(0.5, 6);
    expect(fadeAt(c, S(3))).toBe(1);
    expect(fadeAt(c, S(4.75))).toBeCloseTo(0.5, 6);
    run({ type: 'item.update', sequenceId: 's', itemId: 'c', opacity: 0.5 });
    expect(pictureAt(items()[0]!, S(1.5)).alpha).toBeCloseTo(0.25, 6);
  });

  it('keeps fades inside the clip when it gets shorter, and only at the outer edges of splits', () => {
    const { run, items } = setup();
    run({ type: 'item.update', sequenceId: 's', itemId: 'c', fade: { in: S(3), out: S(3) } });
    // 4 s long: the fade-out keeps its 3 s, the fade-in gets what is left.
    expect(items()[0]!.fade).toEqual({ in: S(1), out: S(3) });
    run({ type: 'item.trim', sequenceId: 's', itemId: 'c', edge: 'end', time: S(3) });
    expect(items()[0]!.fade).toEqual({ in: 0, out: S(2) });
    run({ type: 'item.update', sequenceId: 's', itemId: 'c', fade: { in: S(0.5), out: S(0.5) } });
    run({ type: 'item.split', sequenceId: 's', time: S(2) });
    const [left, right] = items();
    expect(left!.fade).toEqual({ in: S(0.5), out: 0 });
    expect(right!.fade).toEqual({ in: 0, out: S(0.5) });
  });

  it('stacks colour effects like chained eq filters, and can disable, reorder and remove them', () => {
    const { run, items, h } = setup();
    run({ type: 'effect.add', sequenceId: 's', itemId: 'c', kind: 'color', id: 'a' });
    run({ type: 'effect.add', sequenceId: 's', itemId: 'c', kind: 'color', id: 'b' });
    run({
      type: 'effect.update',
      sequenceId: 's',
      itemId: 'c',
      effectId: 'a',
      params: { brightness: 0.1, contrast: 2, saturation: 9 },
    });
    run({
      type: 'effect.update',
      sequenceId: 's',
      itemId: 'c',
      effectId: 'b',
      params: { brightness: -0.05, contrast: 0.5 },
    });
    expect((items()[0]!.effects![0] as ColorEffect).saturation).toBe(3); // limited
    // b after a: 0.5·(2x + 0.1) − 0.05 = x + 0
    const p = pictureAt(items()[0]!, S(2));
    expect([p.contrast, p.saturation]).toEqual([1, 3]);
    expect(p.brightness).toBeCloseTo(0, 9);
    run({ type: 'effect.move', sequenceId: 's', itemId: 'c', effectId: 'b', index: 0 });
    // a after b: 2·(0.5x − 0.05) + 0.1 = x + 0 as well; contrast order does not matter here
    expect(items()[0]!.effects!.map((e) => e.id)).toEqual(['b', 'a']);
    run({ type: 'effect.update', sequenceId: 's', itemId: 'c', effectId: 'a', enabled: false });
    expect(pictureAt(items()[0]!, S(2)).contrast).toBe(0.5);
    run({ type: 'effect.remove', sequenceId: 's', itemId: 'c', effectId: 'a' });
    run({ type: 'effect.remove', sequenceId: 's', itemId: 'c', effectId: 'b' });
    expect(items()[0]!.effects).toBeUndefined();
    h.undo();
    expect(items()[0]!.effects).toHaveLength(1);
  });

  it('eqCodes mirrors FFmpeg eq integer maths', () => {
    // Measured with FFmpeg 8.1 on luma code 100.
    const at = (b: number, c = 1) => {
      const { luma } = eqCodes({ brightness: b, contrast: c, saturation: 1 });
      return Math.max(0, Math.min(255, Math.floor(100 * luma.gain) + luma.offset));
    };
    expect(at(0.12)).toBe(127);
    expect(at(0.1)).toBe(125);
    expect(at(0.2)).toBe(150);
    expect(at(0, 1.3)).toBe(90);
    expect(at(0, 1.0001)).toBe(99);
    expect(eqCodes({ brightness: 0, contrast: 1, saturation: 1 }).luma).toEqual({
      gain: 1,
      offset: 0,
    });
    expect(eqCodes({ brightness: 0, contrast: 1, saturation: 1 }).chroma).toEqual({
      gain: 1,
      offset: 0,
    });
  });

  it('blur effects add up like Gaussians and are limited', () => {
    const { run, items } = setup();
    run({ type: 'effect.add', sequenceId: 's', itemId: 'c', kind: 'blur', id: 'b1' });
    expect(items()[0]!.effects![0]).toEqual({ id: 'b1', kind: 'blur', enabled: true, size: 0.02 });
    run({ type: 'effect.add', sequenceId: 's', itemId: 'c', kind: 'blur', id: 'b2' });
    run({
      type: 'effect.update',
      sequenceId: 's',
      itemId: 'c',
      effectId: 'b1',
      params: { size: 0.03 },
    });
    run({
      type: 'effect.update',
      sequenceId: 's',
      itemId: 'c',
      effectId: 'b2',
      params: { size: 0.04 },
    });
    expect(pictureAt(items()[0]!, S(2)).blur).toBeCloseTo(0.05, 9);
    run({
      type: 'effect.update',
      sequenceId: 's',
      itemId: 'c',
      effectId: 'b2',
      params: { size: 9 },
    });
    expect(items()[0]!.effects![1]).toMatchObject({ size: 0.2 });
    run({ type: 'effect.update', sequenceId: 's', itemId: 'c', effectId: 'b2', enabled: false });
    expect(pictureAt(items()[0]!, S(2)).blur).toBeCloseTo(0.03, 9);
    // Colour effects ignore blurs.
    expect(pictureAt(items()[0]!, S(2)).contrast).toBe(1);
  });
});
