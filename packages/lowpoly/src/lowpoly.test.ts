import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beatTimes,
  normaliseModel,
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

const ONODA = `In 1944, a Japanese soldier was sent to a tiny island in the Philippines with one order: never surrender. So he hid in the jungle and kept fighting. A year later, the war ended. Nobody told him. People dropped leaflets from planes saying the war was over. He decided they were fake. He lived on bananas and coconuts, patched his own uniform, and kept his rifle clean for decades. It took his old commander flying to the island in 1974 to finally give him the order to stop.`;

describe('plans', () => {
  it('makes a what-if storyboard safe: vocabulary, "you", one shot per beat, film rules', () => {
    const beats = [
      'If you stop time, you go blind.',
      'Your doctor would be amazed.',
      'You reach for a cup.',
      'So you would be rich.',
    ];
    const p = normalisePlan(
      {
        cast: [{ id: 'Dr Bob', name: 'Dr Bob', top: 'lab coat', topColor: 'white', hair: 'bald' }],
        shots: [
          { beat: 1, set: 'Living room', framing: 'close up', subject: 'you', action: 'SHOCK' },
          { beat: 2, set: 'moon base', framing: 'closeUp', subject: 'bob', props: ['Brain'] },
          {
            beat: 4,
            framing: 'extremeCloseUp',
            subject: 'you',
            effect: 'glow',
            bigText: 'IM RICH',
          },
        ],
      },
      beats,
    );
    expect(p.cast.map((c) => [c.id, c.top])).toEqual([
      ['you', 'jacket'],
      ['dr_bob', 'labcoat'],
    ]);
    expect(p.cast[1]!.topColor).toBe('#e8e6e0');
    expect(p.shots).toHaveLength(4);
    expect(p.shots[0]).toMatchObject({
      set: 'livingRoom',
      framing: 'closeUp',
      action: 'shock',
      effect: 'darkness',
      props: [],
    });
    // "moon base" is space; a new place opens wide; "bob" is Dr Bob.
    expect(p.shots[1]).toMatchObject({
      set: 'space',
      subject: 'dr_bob',
      // The AI's brain is not in the script, so it is left out.
      props: [],
      framing: 'wide',
    });
    // A beat the AI skipped is read from its narration: you, reaching, a cup.
    expect(p.shots[2]).toMatchObject({ subject: 'you', action: 'point', props: ['cup'] });
    expect(p.shots[3]).toMatchObject({
      subject: 'you',
      // The AI's glow is dropped: the line asks for no effect (it glowed every shot).
      effect: 'none',
      bigText: 'IM RICH',
      framing: 'extremeCloseUp',
    });
  });

  it('follows a true story told in its own words: the hero, places, objects, new models', () => {
    const beats = splitBeats(ONODA);
    // What a small local model tends to answer: free words, missing fields, skipped beats.
    const answer = {
      cast: [
        { name: 'Hiroo Onoda', description: 'young Japanese soldier, olive uniform and cap' },
        { name: 'Major Taniguchi', look: 'old officer in a khaki uniform with glasses' },
      ],
      shots: [
        {
          beat: 1,
          place: 'a tropical island',
          who: ['Hiroo Onoda'],
          doing: 'salutes',
          camera: 'wide',
        },
        { beat: 2, place: 'dense jungle', who: 'he', doing: 'hiding behind trees' },
        {
          beat: 5,
          place: 'jungle',
          who: 'nobody',
          objects: ['leaflets', 'plane'],
          camera: 'wide shot',
        },
        {
          beat: 8,
          who: ['Onoda'],
          objects: ['bananas', 'coconuts', 'bamboo hut'],
          doing: 'eating',
        },
      ],
    };
    const p = normalisePlan(answer, beats, { script: ONODA });
    const onoda = p.cast.find((c) => c.id === 'hiroo_onoda')!;
    expect(onoda).toMatchObject({
      top: 'uniform',
      topColor: '#6b6b3a',
      extra: 'cap',
      skin: 'tan',
      age: 'young',
    });
    expect(p.cast.find((c) => c.id === 'major_taniguchi')).toMatchObject({
      age: 'old',
      extra: 'glasses',
      top: 'uniform',
      topColor: '#a8925a',
    });
    // Never the red-jacket "you": this story is about him.
    expect(p.cast.some((c) => c.id === 'you')).toBe(false);
    expect(p.shots[0]).toMatchObject({
      set: 'island',
      subject: 'hiroo_onoda',
      action: 'salute',
      framing: 'wide',
    });
    expect(p.shots[1]).toMatchObject({ set: 'jungle', subject: 'hiroo_onoda', action: 'crouch' });
    const leaflets = p.shots.find((s) => s.props.includes('plane'))!;
    // Leaflets from planes: the hero looks up at the plane as the leaflets fall.
    expect(leaflets).toMatchObject({
      set: 'jungle',
      subject: 'hiroo_onoda',
      props: ['paper', 'plane', 'rifle'],
      action: 'lookUp',
    });
    // Feelings from the lines; no crowd for "a soldier"; no years written on screen.
    expect(p.shots[0]).toMatchObject({ bigText: '', crowd: 0 });
    expect(p.shots.find((s, i) => beats[i] === 'A year later, the war ended.')).toMatchObject({
      bigText: '',
      mood: 'sad',
    });
    expect(p.shots.find((s, i) => beats[i] === 'Nobody told him.')).toMatchObject({
      subject: 'hiroo_onoda',
      mood: 'lonely',
    });
    const food = p.shots.find((s) => s.action === 'eat')!;
    // A "bamboo hut" the script never mentions is not built; what it names is shown.
    expect(food.props).toEqual(expect.arrayContaining(['banana', 'coconut']));
    expect(p.models).toEqual([]);
    // The rifle and uniform beat shows the rifle even though the AI skipped that beat.
    expect(p.shots.some((s) => s.props.includes('rifle'))).toBe(true);
    // "His old commander flying to the island": read from the narration alone, found by his role.
    // He flies in: Onoda, on the ground, watches the plane; the next line has the major in it.
    expect(p.shots[9]).toMatchObject({ set: 'island', subject: 'hiroo_onoda', action: 'lookUp' });
    expect(p.shots[9]!.props).toContain('plane');
    expect(p.shots[10]!.others).toContain('major_taniguchi');
    // Close-ups never pile up.
    for (let i = 1; i < p.shots.length; i++)
      expect(
        ['closeUp', 'extremeCloseUp'].includes(p.shots[i]!.framing) &&
          ['closeUp', 'extremeCloseUp'].includes(p.shots[i - 1]!.framing),
      ).toBe(false);
  });

  it('makes AI-designed models safe and stands them on the ground', () => {
    const m = normaliseModel(
      {
        parts: [
          { shape: 'cube', size: [2, 1, 2], position: [0, -1, 0], color: 'brown' },
          { type: 'pyramid', scale: 1.5, pos: { x: 0, y: 0.2, z: 0 }, colour: 'green' },
          'junk',
        ],
      },
      'bamboo hut',
    )!;
    expect(m.parts.map((x) => x.shape)).toEqual(['box', 'cone']);
    expect(m.parts[0]!.at[1]).toBeCloseTo(0.5);
    expect(m.parts[1]!.color).toBe('#3f7a3a');
    expect(normaliseModel({ parts: [] }, 'x')).toBeNull();
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

describe('a real local-model storyboard (qwen3:8b, the Onoda script)', () => {
  // The AI's answer as it came back on the reference PC: no cast, "Japanese soldier" as who,
  // objects the script has not mentioned yet, a sleeping shot for "Nobody told him".
  const d = JSON.parse(
    readFileSync(new URL('./fixtures/onoda-qwen.json', import.meta.url), 'utf8'),
  ) as {
    board: { cast?: unknown; shots?: unknown };
    beats: string[];
  };
  const p = normalisePlan(d.board, d.beats, { script: d.beats.join(' ') });
  const at = (start: string) => p.shots[d.beats.findIndex((b) => b.startsWith(start))]!;

  it("keeps the story's hero, named from the script, in uniform", () => {
    expect(p.cast[0]).toMatchObject({
      id: 'hiroo_onoda',
      name: 'Hiroo Onoda',
      top: 'uniform',
      topColor: '#6b6b3a',
      extra: 'cap',
    });
    expect(
      p.shots.every(
        (s) =>
          s.subject === 'hiroo_onoda' ||
          s.others.includes('hiroo_onoda') ||
          s.subject === 'old_commander',
      ),
    ).toBe(true);
    expect(p.models).toEqual([]);
  });

  it('shows only what the story has mentioned, when it is mentioned', () => {
    const before = p.shots.slice(
      0,
      d.beats.findIndex((b) => b.startsWith('People dropped')),
    );
    expect(before.some((s) => s.props.includes('paper') || s.props.includes('plane'))).toBe(false);
    expect(at('People dropped')).toMatchObject({ subject: 'hiroo_onoda', action: 'lookUp' });
    expect(at('People dropped').props).toEqual(expect.arrayContaining(['paper', 'plane']));
    expect(at('He lived on').props).toEqual(expect.arrayContaining(['banana', 'coconut']));
    expect(at('He lived on').action).toBe('eat');
    expect(at('and kept his rifle').action).toBe('work');
    expect(p.shots.at(-1)!.props).not.toContain('paper');
  });

  it('uses common sense for what people do and feel', () => {
    expect(p.shots.some((s) => s.action === 'sleep')).toBe(false);
    expect(at('Nobody told him')).toMatchObject({ mood: 'lonely', action: 'patrol' });
    expect(at('So he hid')).toMatchObject({ set: 'jungle', action: 'crouch' });
    expect(at('He decided they were fake').action).toBe('shakeHead');
    expect(at('Search parties')).toMatchObject({ crowd: 3, action: 'crouch' });
    // The commander flies in: the hero watches the plane, then the commander gives the order.
    expect(at('It took his old commander')).toMatchObject({
      subject: 'hiroo_onoda',
      action: 'lookUp',
    });
    expect(at('It took his old commander').props).toContain('plane');
    expect(at('in 1974').others).toContain('old_commander');
    expect(p.cast.find((c) => c.id === 'old_commander')).toMatchObject({
      age: 'old',
      top: 'uniform',
    });
  });

  it('never writes cut-off or year text on screen', () => {
    for (const s of p.shots) expect(s.bigText === '' || s.bigText.length <= 18).toBe(true);
    expect(p.shots.some((s) => /messag$/.test(s.bigText))).toBe(false);
  });
});

describe('a real blocky storyboard (qwen3:8b, the Leo script, ADR-055)', () => {
  // The plan file of the Short that went wrong: the AI's answer and the beats.
  const real = JSON.parse(
    readFileSync(new URL('./fixtures/leo-qwen.json', import.meta.url), 'utf8'),
  ) as { beats: string[]; board: { cast?: unknown; shots?: unknown } };
  const script = real.beats.join(' ');
  const p = normalisePlan(real.board, real.beats, { script });
  const at = (start: string) => p.shots[real.beats.findIndex((b) => b.startsWith(start))]!;

  it('keeps the story: the named hero, no made-up models, no effects nobody asked for', () => {
    expect(p.cast.map((c) => c.id)).toContain('leo');
    expect(p.cast.find((c) => c.id === 'leo')!.name).toBe('Leo');
    // People, ceilings, floors and windows are not objects to design.
    expect(p.models).toEqual([]);
    expect(p.shots.every((s) => s.effect === 'none')).toBe(true);
    expect(p.shots.every((s) => s.props.every((x) => !x.startsWith('m:')))).toBe(true);
  });

  it('acts each line out with common sense', () => {
    expect(at('Most people only scroll')).toMatchObject({
      subject: 'none',
      crowdAction: 'usePhone',
    });
    expect(at('Most people only scroll').crowd).toBeGreaterThan(0);
    expect(at('But Leo never')).toMatchObject({ subject: 'leo', action: 'usePhone' });
    expect(at('But Leo never').props).toContain('phone');
    expect(at('He scrolled in bed')).toMatchObject({
      set: 'bedroom',
      action: 'lie',
      time: 'night',
    });
    expect(at('He scrolled in bed').props).toEqual(expect.arrayContaining(['bed', 'phone']));
    expect(at('He scrolled at breakfast')).toMatchObject({ set: 'kitchen', action: 'sit' });
    expect(at('He scrolled at breakfast').props).toEqual(
      expect.arrayContaining(['table', 'bowl', 'phone']),
    );
    expect(at('By Monday')).toMatchObject({ set: 'kitchen', framing: 'wide' });
    expect(at('At school')).toMatchObject({ set: 'classroom', action: 'sitFloor' });
    expect(at('His teacher').subject).toBe('teacher');
    expect(at('His teacher').others).toContain('leo');
    expect(at('Birds started').props).toContain('bird');
    expect(at('Birds started').action).not.toBe('lookUp');
    expect(at('His friends shouted')).toMatchObject({ crowdAction: 'lookUp', framing: 'lowAngle' });
    expect(at('His friends shouted').crowd).toBeGreaterThanOrEqual(3);
    expect(at('Then one night')).toMatchObject({ action: 'shock', time: 'night' });
    expect(at('For the first time')).toMatchObject({ action: 'lookDown' });
    expect(at('The whole town')).toMatchObject({ crowd: 7, crowdAction: 'wave' });
    expect(at('He sat down on the street')).toMatchObject({ set: 'street', action: 'sitFloor' });
  });

  it('remembers how tall Leo has grown, shot after shot', () => {
    const heights = p.shots
      .map((s) => s.sizes.leo?.height)
      .filter((h): h is number => h !== undefined);
    // Never shrinks; reaches the ceiling, then towers over the houses.
    for (let i = 1; i < heights.length; i++)
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]!);
    expect(at('By Monday').sizes.leo!.height).toBeGreaterThanOrEqual(3);
    expect(at('By Friday').sizes.leo).toMatchObject({ height: 8.5, legs: true });
    expect(at('By Friday').sizes.leo!.from).toBeLessThan(8.5);
    // The story's rule ("the longer your legs get") is shown on "you" first.
    expect(at('In this town').sizes.you!.height).toBeGreaterThan(
      at('In this town').sizes.you!.from,
    );
  });
});
