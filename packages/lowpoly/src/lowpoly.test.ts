import { describe, expect, it } from 'vitest';
import {
  beatTimes,
  colour,
  mouthFrames,
  normalisePlan,
  renderSpecSchema,
  shotFrames,
  splitBeats,
  YOU,
} from './index';

describe('beats', () => {
  it('cuts a script into short clauses, one picture each', () => {
    const beats = splitBeats(
      'If you could stop time with the snap of your fingers, you would instantly go blind, deaf and even start to suffocate. Because photons of light physically travel into your retinas. So you instant-',
    );
    expect(beats).toEqual([
      'If you could stop time with the snap of your fingers,',
      'you would instantly go blind, deaf and even start to suffocate.',
      'Because photons of light physically travel into your retinas.',
      'So you instant-',
    ]);
    for (const b of splitBeats(
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.',
    ))
      expect(b.split(' ').length).toBeLessThanOrEqual(12);
  });

  it('times beats from the voice, by letters, edge to edge', () => {
    const spoken = [
      { text: 'In', start: 0, end: 0.2 },
      { text: 'nineteen', start: 0.2, end: 0.6 },
      { text: 'eighty', start: 0.6, end: 0.9 },
      { text: 'he', start: 1.4, end: 1.5 },
      { text: 'ran', start: 1.5, end: 1.8 },
    ];
    const t = beatTimes(['In nineteen eighty.', 'He ran.'], spoken, 2.2);
    expect(t).toEqual([
      { start: 0, end: 1.15 },
      { start: 1.15, end: 2.2 },
    ]);
  });
});

describe('mouth', () => {
  it('opens on vowels, rounds on o/u, shuts on m/b/p and in silence, holding two frames', () => {
    const sounds = [
      { p: 'm', start: 0, end: 0.1 },
      { p: 'ɑ', start: 0.1, end: 0.3 },
      { p: 'u', start: 0.3, end: 0.5 },
      { p: 's', start: 0.5, end: 0.6 },
    ];
    const f = mouthFrames(sounds, 0, 1, 10);
    // The lone "s" frame holds the round shape before the mouth shuts in the silence.
    expect(f).toEqual([0, 2, 2, 3, 3, 3, 0, 0, 0, 0]);
  });
});

describe('plans', () => {
  it('makes any storyboard safe: vocabulary, subjects, one shot per beat, variety', () => {
    const p = normalisePlan(
      {
        cast: [
          { id: 'Dr Bob', name: 'Dr Bob', top: 'lab coat', topColor: 'white', hair: 'bald' },
          { id: 'you', name: 'You', top: 'suit' }, // "you" is kept as given
        ],
        shots: [
          { beat: 1, set: 'Living room', framing: 'close up', subject: 'you', action: 'SHOCK' },
          {
            beat: 2,
            set: 'moon base',
            framing: 'closeUp',
            subject: 'bob',
            props: ['Brain', 'laser gun'],
          },
          { beat: 4, framing: 'closeUp', subject: 'brain', effect: 'glow', bigText: 'IM RICH' },
        ],
      },
      4,
    );
    expect(p.cast.map((c) => [c.id, c.top])).toEqual([
      ['you', 'jacket'],
      ['dr_bob', 'labcoat'],
    ]);
    expect(p.cast[1]!.topColor).toBe('#e8e6e0');
    expect(p.shots).toHaveLength(4);
    expect(p.shots[0]).toMatchObject({ set: 'livingRoom', framing: 'closeUp', action: 'shock' });
    // Unknown set keeps the last one; "bob" is Dr Bob; unknown props are dropped.
    expect(p.shots[1]).toMatchObject({ set: 'livingRoom', subject: 'dr_bob', props: ['brain'] });
    // A skipped beat repeats the previous shot from another distance.
    expect(p.shots[2]!.subject).toBe('dr_bob');
    // Never three close-ups in a row.
    expect(p.shots[2]!.framing).toBe('wide');
    expect(p.shots[3]).toMatchObject({ subject: 'brain', effect: 'glow', bigText: 'IM RICH' });
  });

  it('reads colours by name or hex', () => {
    expect(colour('Navy', '#000000')).toBe('#1f2b4a');
    expect(colour('#ABC', '#000000')).toBe('#aabbcc');
    expect(colour('plaid', '#123456')).toBe('#123456');
  });

  it('frames shots exactly and checks the render spec', () => {
    expect(shotFrames({ start: 1.01, end: 2.49 }, 30)).toEqual([30, 75]);
    const spec = renderSpecSchema.parse({
      width: 1080,
      height: 1920,
      fps: 30,
      pixelHeight: 480,
      cast: [YOU],
      shots: [
        {
          start: 0,
          end: 2,
          set: 'street',
          framing: 'wide',
          subject: 'you',
          others: [],
          action: 'walk',
          props: [],
          effect: 'none',
          camera: 'pushIn',
          seed: 1,
        },
      ],
    });
    expect(spec.brand).toBe('');
    expect(spec.shots[0]!.mouth).toEqual([]);
  });
});
