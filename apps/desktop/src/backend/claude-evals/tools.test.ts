// Edge cases of the effect, animation, ducking and freeze tools (ADR-045).
import { describe, expect, it } from 'vitest';
import { textOf } from './scenarios';
import { World, shortWith, speech } from './world';

function world(luts: { id: string; name: string }[] = []) {
  return new World({
    media: [
      { id: 'talk', name: 'talk.mp4', kind: 'video', length: 20, words: speech('hello [2] world') },
      { id: 'music', name: 'music.mp3', kind: 'audio', length: 20, music: true },
      { id: 'pic', name: 'pic.png', kind: 'image', length: 0 },
    ],
    luts,
    setup: (w) =>
      shortWith(w, [
        { id: 'c1', assetId: 'talk', sourceIn: 2, duration: 10 },
        { id: 'm1', assetId: 'music', start: 0, duration: 10 },
      ]),
  });
}

describe('set_effect', () => {
  it('adds once, then adjusts the same effect', async () => {
    const w = world();
    await w.call('set_effect', { itemId: 'c1', kind: 'color', brightness: 0.1 });
    const r = await w.call('set_effect', { itemId: 'c1', kind: 'color', saturation: 0.5 });
    expect(textOf(r)).toContain('"brightness":0.1');
    expect(textOf(r)).toContain('"saturation":0.5');
    expect(w.seq!.tracks.flatMap((t) => t.items).find((i) => i.id === 'c1')!.effects).toHaveLength(
      1,
    );
    expect(w.service.state().changes[0]!.edits).toEqual(['Added colour', 'Adjusted colour']);
  });

  it('rejects settings of another kind, unknown LUTs and picture effects on sound', async () => {
    const w = world([{ id: 'l1', name: 'Warm' }]);
    const stray = await w.call('set_effect', { itemId: 'c1', kind: 'blur', saturation: 0 });
    expect(textOf(stray)).toContain('saturation do not apply to blur. It takes: size.');
    const lut = await w.call('set_effect', { itemId: 'c1', kind: 'lut', lutId: 'nope' });
    expect(textOf(lut)).toContain('LUTs: l1 (Warm)');
    const noLut = await w.call('set_effect', { itemId: 'c1', kind: 'lut' });
    expect(textOf(noLut)).toContain('Give lutId');
    const onSound = await w.call('set_effect', { itemId: 'm1', kind: 'blur' });
    expect(onSound.isError).toBe(true);
    expect(w.service.state().changes).toEqual([]);
  });

  it('shows effect settings and animation in get_sequence (timeline seconds)', async () => {
    const w = world();
    await w.call('set_effect', { itemId: 'm1', kind: 'eq', lowCut: true });
    await w.call('set_keyframes', {
      itemId: 'c1',
      property: 'scale',
      keyframes: [
        { time: 1, value: 1 },
        { time: 9, value: 1.2, easing: 'ease' },
      ],
    });
    const seq = JSON.parse(textOf(await w.call('get_sequence', {}))) as {
      clips: { id: string; effects?: unknown[]; keyframes?: Record<string, unknown> }[];
    };
    const c1 = seq.clips.find((c) => c.id === 'c1')!;
    const m1 = seq.clips.find((c) => c.id === 'm1')!;
    // Stored in source time (the clip starts 2 s into its media), shown in timeline time.
    expect(c1.keyframes).toEqual({
      scale: [
        [1, 1, 'linear'],
        [9, 1.2, 'ease'],
      ],
    });
    expect(m1.effects).toEqual([
      { kind: 'eq', lowCut: true, low: 0, mid: 0, midFreq: 2500, high: 0 },
    ]);
  });

  it('removes an effect by kind', async () => {
    const w = world();
    await w.call('set_effect', { itemId: 'c1', kind: 'blur' });
    expect((await w.call('remove_effect', { itemId: 'c1', kind: 'blur' })).isError).toBeUndefined();
    expect((await w.call('remove_effect', { itemId: 'c1', kind: 'blur' })).isError).toBe(true);
  });
});

describe('set_keyframes', () => {
  it('replaces an animation, refuses times outside the clip, and clears with an empty list', async () => {
    const w = world();
    const clip = () => w.seq!.tracks.flatMap((t) => t.items).find((i) => i.id === 'm1')!;
    await w.call('set_keyframes', {
      itemId: 'm1',
      property: 'volume',
      keyframes: [
        { time: 0, value: 0 },
        { time: 2, value: 1 },
      ],
    });
    await w.call('set_keyframes', {
      itemId: 'm1',
      property: 'volume',
      keyframes: [
        { time: 0, value: 0.5 },
        { time: 5, value: 1 },
        { time: 8, value: 0.2 },
      ],
    });
    expect(clip().keyframes?.volume?.map((k) => k.v)).toEqual([0.5, 1, 0.2]);
    const outside = await w.call('set_keyframes', {
      itemId: 'm1',
      property: 'volume',
      keyframes: [{ time: 12, value: 1 }],
    });
    expect(textOf(outside)).toContain('outside the clip (0–10 s)');
    await w.call('set_keyframes', { itemId: 'm1', property: 'volume', keyframes: [] });
    expect(clip().keyframes?.volume ?? []).toEqual([]);
    expect(clip().volume).toBe(0.5);
  });
});

describe('duck_music and freeze_frame', () => {
  it('ducks only under the speech the timeline plays (the clip starts after "hello")', async () => {
    const w = world();
    const r = await w.call('duck_music', { itemId: 'm1', level: 0.2 });
    expect(textOf(r)).toMatch(/Ducked to 20% under 1 stretch\(es\)/);
    const vs = w.seq!.tracks.flatMap((t) => t.items).find((i) => i.id === 'm1')!.keyframes!.volume!;
    expect(Math.min(...vs.map((k) => k.v))).toBe(0.2);
  });

  it('says when there is nothing to duck under', async () => {
    const w = world();
    w.userEdit({ type: 'item.update', sequenceId: 'seq1', itemId: 'c1', muted: true });
    expect(textOf(await w.call('duck_music', { itemId: 'm1' }))).toContain('no other sound');
  });

  it('refuses freezes outside the clip and on stills', async () => {
    const w = world();
    expect(textOf(await w.call('freeze_frame', { itemId: 'c1', time: 15, duration: 1 }))).toContain(
      'outside the clip',
    );
    expect((await w.call('freeze_frame', { itemId: 'm1', time: 1, duration: 1 })).isError).toBe(
      true,
    );
  });
});
