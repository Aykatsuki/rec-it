import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as S } from '../time';
import type { Command } from './commands';
import { History } from './history';
import { emptyDocument } from './model';

const lookup = (id: string) =>
  id === 'clip'
    ? { kind: 'video' as const, duration: S(20), hasAudio: true, width: 1920, height: 1080 }
    : undefined;

function setup() {
  const h = new History(emptyDocument());
  const run = (c: Command, group?: string) => h.execute(c, lookup, group);
  run({
    type: 'sequence.create',
    id: 's',
    name: 'S',
    width: 1080,
    height: 1920,
    fps: FRAME_RATES.fps30,
  });
  const tracks = h.doc.sequences[0]!.tracks;
  const [cap, v1, a1] = [tracks[0]!.id, tracks[1]!.id, tracks[2]!.id];
  return { h, run, cap, v1, a1 };
}

describe('Claude edits', () => {
  it('removes ranges from every track and closes the gaps', () => {
    const { h, run, v1, a1 } = setup();
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId: v1,
      assetId: 'clip',
      id: 'v',
      start: 0,
      duration: S(10),
    });
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId: a1,
      assetId: 'clip',
      id: 'm',
      start: S(4),
      duration: S(4),
    });
    run({
      type: 'sequence.removeRanges',
      sequenceId: 's',
      ranges: [
        { start: S(5), end: S(6) },
        { start: S(2), end: S(3) },
        { start: S(2.5), end: S(3.5) }, // overlaps: merged into 2–3.5
      ],
    });
    const [v1Items, a1Items] = [
      h.doc.sequences[0]!.tracks[1]!.items,
      h.doc.sequences[0]!.tracks[2]!.items,
    ];
    // 10 s minus 1.5 s minus 1 s.
    expect(v1Items.map((i) => [i.start / S(1), i.duration / S(1), i.sourceIn / S(1)])).toEqual([
      [0, 2, 0],
      [2, 1.5, 3.5],
      [3.5, 4, 6],
    ]);
    // The music (4–8 s) lost 5–6 s and moved left by the earlier 1.5 s.
    expect(a1Items.map((i) => [i.start / S(1), i.duration / S(1), i.sourceIn / S(1)])).toEqual([
      [2.5, 1, 0],
      [3.5, 2, 2],
    ]);
  });

  it('groups edits into one undo step', () => {
    const { h, run, v1 } = setup();
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId: v1,
      assetId: 'clip',
      id: 'v',
      start: 0,
      duration: S(10),
    });
    run({ type: 'item.split', sequenceId: 's', time: S(2) }, 'claude-1');
    run({ type: 'item.split', sequenceId: 's', time: S(4) }, 'claude-1');
    expect(h.topGroup).toBe('claude-1');
    expect(h.doc.sequences[0]!.tracks[1]!.items).toHaveLength(3);
    h.undo();
    expect(h.doc.sequences[0]!.tracks[1]!.items).toHaveLength(1);
    h.redo();
    expect(h.doc.sequences[0]!.tracks[1]!.items).toHaveLength(3);
    // A different group (or a user edit) starts a new step.
    run({ type: 'item.split', sequenceId: 's', time: S(6) });
    run({ type: 'item.split', sequenceId: 's', time: S(8) }, 'claude-1');
    h.undo();
    expect(h.doc.sequences[0]!.tracks[1]!.items).toHaveLength(4);
  });
});
