// One shot of a low-poly Short (ADR-054): the set, the people and props placed in it, the effect,
// and a camera that frames the subject and moves over the shot. `update(t)` is a pure function of
// the time into the shot, so any frame can be drawn on its own.
import * as THREE from 'three';
import type { Action, CastMember, Model, ShotSpec } from '@rec-it/lowpoly';
import { YOU } from '@rec-it/lowpoly';
import { Person } from './people';
import { anyProp, makeProp, sign, type Prop } from './props';
import { mat } from './ps1';
import { flat } from './ps1';
import { buildSet } from './sets';
import { blocky } from './style';
import { rng, texture } from './textures';

/** Props that fly across the sky. */
const FLYERS = new Set(['plane', 'helicopter', 'rocket', 'bird']);

export interface BuiltShot {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update: (t: number, frame: number) => void;
  /** Post-process settings for this moment. */
  look: (t: number) => { tint: string; tintAmount: number; flash: number };
  /** Big words drawn over the picture (unless they are on a sign in the scene). */
  overlay: string;
  /** How far the camera's focus is (for depth of field), as of the last update. */
  focusDistance: () => number;
}

/** The closer angle a long shot cuts to halfway (blocky look). */
const RECUT: Partial<Record<ShotSpec['framing'], ShotSpec['framing']>> = {
  wide: 'medium',
  medium: 'closeUp',
  lowAngle: 'medium',
  closeUp: 'medium',
  overhead: 'medium',
};

const smooth = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

function glowTexture(colour: string): THREE.Texture {
  return texture(`glow:${colour}`, [64, 64], (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    grad.addColorStop(0, colour);
    grad.addColorStop(0.5, `${colour}88`);
    grad.addColorStop(1, `${colour}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
}

function sprite(colour: string, size: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(colour),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  s.scale.setScalar(size);
  return s;
}

/** The viewer's own arm, for first-person shots: a sleeve and a pointing hand. */
function povArm(c: CastMember): THREE.Group {
  const g = new THREE.Group();
  const sleeve = new THREE.Mesh(
    new THREE.BoxGeometry(0.075, 0.075, 0.5),
    new THREE.MeshLambertMaterial({ color: c.topColor }),
  );
  sleeve.position.z = -0.3;
  const skin = new THREE.MeshLambertMaterial({
    color: { pale: '#f0d2bd', light: '#e2b48c', tan: '#d6a27a', brown: '#8d5a3b', dark: '#5a3826' }[
      c.skin
    ],
  });
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.09), skin);
  hand.position.z = -0.59;
  const finger = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.08), skin);
  finger.position.set(0.018, 0.008, -0.67);
  g.add(sleeve, hand, finger);
  g.position.set(0.13, -0.2, -0.05);
  g.rotation.set(0.2, 0.22, 0);
  return g;
}

export function buildShot(
  spec: ShotSpec,
  cast: readonly CastMember[],
  duration: number,
  models: Record<string, Model> = {},
): BuiltShot {
  const r = rng(spec.seed + 11);
  const flies = [spec.subject, ...spec.props].some((p) => FLYERS.has(p));
  const set = buildSet(spec.set, spec.seed, {
    clearing: flies,
    night: spec.time === 'night',
    ownBed: spec.action === 'sleep' || spec.action === 'lie',
  });
  const { scene } = set;
  const setObjects = [...scene.children];
  const camera = new THREE.PerspectiveCamera(40, 9 / 16, 0.03, 400);
  const member = (id: string) => cast.find((c) => c.id === id) ?? (id === 'you' ? YOU : undefined);

  const animated: ((t: number) => void)[] = [];

  // People.
  const people = new Map<string, Person>();
  const mainCast = member(spec.subject);
  const pov = spec.framing === 'pov';
  // Looking at something in the sky: we watch over their shoulder.
  // A giant with people at their feet faces the camera across the street, the town behind.
  const giantWithCrowd = (spec.sizes[spec.subject]?.height ?? 0) > 3 && spec.crowd > 0;
  const facing =
    pov || (flies && spec.framing !== 'object' && !giantWithCrowd)
      ? Math.PI
      : giantWithCrowd
        ? 0
        : [0, 0, 0.45, -0.45, 1.25][Math.floor(r() * 5)]!;
  const subject = mainCast ? new Person(mainCast, spec.seed) : null;
  if (subject) {
    people.set(mainCast!.id, subject);
    scene.add(subject.root);
    if (pov) subject.root.visible = false;
  }
  const others = spec.others.map((id) => member(id)).filter((c): c is CastMember => !!c);
  others.forEach((c, i) => {
    const p = new Person(c, spec.seed + i + 1);
    const side = i % 2 ? -1 : 1;
    p.root.position.set(side * (1.1 + Math.floor(i / 2) * 1.1), 0, -0.4 - Math.floor(i / 2) * 0.8);
    p.root.rotation.y = -side * 0.5;
    people.set(c.id, p);
    scene.add(p.root);
  });
  const otherSpots = others.map((_, i) => {
    const side = i % 2 ? -1 : 1;
    return {
      pos: new THREE.Vector3(
        side * (1.1 + Math.floor(i / 2) * 1.1),
        0,
        -0.4 - Math.floor(i / 2) * 0.8,
      ),
      facing: -side * 0.5,
    };
  });

  // Story state: how tall each person is (growing during the shot when the story says so). A
  // standing giant indoors stops at the ceiling ("his head was touching the kitchen ceiling").
  const lyingDown = ['sleep', 'lie', 'sitFloor', 'sit'].includes(spec.action);
  const sized = [...people].flatMap(([id, person]) => {
    const size = spec.sizes[id];
    if (!size) return [];
    const cap = set.indoor && !(person === subject && lyingDown) ? 2.86 : 30;
    const to = Math.min(cap, size.height);
    const from = Math.min(cap, size.from);
    person.setHeight(from, size.legs);
    return [{ person, from, to, legs: size.legs }];
  });
  const growTo = (t: number) => {
    const k = smooth(t / Math.max(0.3, duration * 0.75));
    for (const x of sized)
      if (x.from !== x.to || t === 0) x.person.setHeight(x.from + (x.to - x.from) * k, x.legs);
  };
  growTo(duration);
  // How much taller than normal the subject stands (sitting giants are at everyone's level).
  const tall =
    subject && !['sitFloor', 'sit', 'lie', 'sleep'].includes(spec.action)
      ? subject.height / 1.78
      : 1;
  const giantSitting = !!subject && tall === 1 && subject.height > 3;
  // A phone named in the shot is in the subject's hands, looked at.
  if (subject && spec.props.includes('phone')) {
    subject.phone = true;
    // At night the screen lights the face.
    if (spec.time === 'night') {
      const screenLight = new THREE.PointLight('#a8d4ff', 3, 2.2, 1.5);
      screenLight.position.set(0, 0.05, 0.15);
      subject.handR.add(screenLight);
    }
  }

  // Furniture the action needs.
  let base = new THREE.Vector3();
  const flatOut = (v: THREE.Vector3) => v.applyAxisAngle(new THREE.Vector3(0, 1, 0), facing);
  const atTable = !!subject && spec.action === 'sit' && spec.props.includes('table');
  if (subject && spec.action === 'sit') {
    const chair = makeProp('chair').object;
    chair.position.set(0, 0, -0.12);
    chair.rotation.y = facing;
    scene.add(chair);
  }
  if (atTable) {
    // Breakfast: the table in front, the bowl on it within reach.
    const table = makeProp('table').object;
    table.position.copy(flatOut(new THREE.Vector3(0, 0, 0.62)));
    table.rotation.y = facing;
    if (blocky()) table.scale.y = 0.78;
    scene.add(table);
    if (spec.props.includes('bowl')) {
      const bowl = makeProp('bowl').object;
      bowl.position.copy(flatOut(new THREE.Vector3(-0.12, 0, 0.48)));
      bowl.position.y = set.tableTop * (blocky() ? 0.78 : 1) + 0.01;
      bowl.scale.setScalar(blocky() ? 1.6 : 1);
      scene.add(bowl);
    }
  }
  if (subject && (spec.action === 'sleep' || spec.action === 'lie')) {
    if (set.indoor || spec.props.includes('bed')) {
      // The bed runs from the feet (here) to past the head; the headboard stays clear of it.
      const bed = makeProp('bed').object;
      bed.rotation.y = facing;
      bed.position.copy(
        new THREE.Vector3(0, 0, -0.98).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing),
      );
      scene.add(bed);
      base = new THREE.Vector3(0, 0.55, 0);
    } else base = new THREE.Vector3(0, 0.12, 0);
  }

  // Props.
  const props: Prop[] = [];
  const propSubject = !mainCast && spec.subject !== 'none' ? spec.subject : '';
  const propIds = [...new Set([...(propSubject ? [propSubject] : []), ...spec.props])];
  let focusProp = null as Prop | null;
  let onSign = false;
  // Things near the person stand where the camera sees them: in front and to the side.
  const near = (side: number, ahead: number) =>
    new THREE.Vector3(side, 0, ahead).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing);
  let held = 0;
  let holdingPaper = false;
  let nearIndex = 0;
  propIds.forEach((id, i) => {
    if (id === 'bed' && (spec.action === 'sleep' || spec.action === 'lie')) return;
    if (atTable && (id === 'table' || id === 'bowl')) return;
    // A bowl with nobody at a table stands on the table of the set, or the ground.
    if (id === 'bowl' && !atTable && subject) {
      const bowl = makeProp('bowl').object;
      bowl.position.copy(near(0.45, 0.5));
      bowl.scale.setScalar(1.5);
      scene.add(bowl);
      return;
    }
    // Birds on a giant perch on the shoulders (and one more circles the head).
    if (id === 'bird' && subject && tall > 1.7) {
      for (const [k, shoulder] of [subject.shoulderL, subject.shoulderR].entries()) {
        const b = makeProp('bird').object;
        b.scale.setScalar(1.4 / Math.max(1, subject.root.scale.x));
        b.position.set(0, 0.12, 0);
        b.rotation.y = k ? -0.4 : 0.4;
        shoulder.add(b);
        animated.push((t) => {
          b.position.y = 0.12 + Math.abs(Math.sin(t * 3 + k)) * 0.03;
          b.rotation.z = Math.sin(t * 2 + k) * 0.12;
        });
      }
      const flier = makeProp('bird').object;
      flier.scale.setScalar(2.2);
      scene.add(flier);
      animated.push((t) => {
        const head = subject.point('eyes');
        flier.position.set(
          head.x + Math.cos(t * 1.4) * 1.6,
          head.y + 0.6 + Math.sin(t * 2.8) * 0.2,
          head.z + Math.sin(t * 1.4) * 1.6,
        );
        flier.rotation.y = -t * 1.4;
      });
      return;
    }
    // A leaflet on the ground story-wise is one sheet in the hand, not a falling cloud.
    if (id === 'paper' && subject && !flies && held < 2) {
      const hand =
        held === 0 && !['salute', 'wave', 'point', 'think'].includes(spec.action)
          ? subject.handR
          : subject.handL;
      hand.add(heldSheet());
      held++;
      holdingPaper = true;
      return;
    }
    const p = anyProp(id, spec.bigText, models);
    p.id = id;
    if (id === 'sign' && spec.bigText) onSign = true;
    props.push(p);
    const o = p.object;
    const isSubject = id === propSubject;
    if (isSubject) focusProp = p;
    if (isSubject && !subject) {
      if (p.placement === 'float') o.position.set(0, 1.35, 0);
      else if (p.placement === 'hand') {
        if (set.tableTop > 0) {
          const table = makeProp('table').object;
          scene.add(table);
          o.position.set(0, set.tableTop + 0.02, 0);
          o.scale.setScalar(1.6);
        } else {
          // Nothing floats: without a table it lies on the ground.
          o.position.set(0, 0.04, 0);
          o.rotation.z = Math.PI / 2;
          o.scale.setScalar(1.6);
        }
      } else o.position.set(0, 0, 0);
      if (
        [
          'dog',
          'cat',
          'cow',
          'fish',
          'bird',
          'rat',
          'plane',
          'car',
          'rocket',
          'boat',
          'helicopter',
        ].includes(id)
      )
        o.rotation.y = id === 'plane' ? 2.2 : 1.1;
      if (p.placement === 'float' && ['fish', 'bird'].includes(id)) o.position.y = 1.2;
    } else if (p.placement === 'hand' && subject && pov) {
      // First person: the thing sits in front of you, waiting to be touched.
      o.position.set(0.05, set.tableTop > 0 ? set.tableTop + 0.02 : 1.0, 0.75);
      if (set.tableTop > 0) {
        const table = makeProp('table').object;
        table.position.set(0, 0, 0.75);
        scene.add(table);
      }
      o.scale.setScalar(1.4);
      focusProp = p;
    } else if (p.placement === 'hand' && subject && held < 2) {
      // The right hand, unless the action needs it (a salute, a wave): then the left.
      const rightBusy = ['salute', 'wave', 'point', 'think'].includes(spec.action);
      const hand = (held === 0) !== rightBusy ? subject.handR : subject.handL;
      held++;
      hand.add(o);
    } else if (p.placement === 'hand' && subject) {
      // A second small thing (coconuts with a banana in hand): at the person's feet, in view.
      const k = nearIndex++;
      o.position.copy(near((k % 2 ? -1 : 1) * 0.32, 0.45 + k * 0.1));
      o.position.y = 0.05;
      o.scale.setScalar(1.6);
    } else if (p.placement === 'float') {
      // Beside the subject's head, on the side away from the camera's line.
      const side = new THREE.Vector3(
        (i % 2 ? -1 : 1) * (0.42 + p.size * 0.2),
        subject ? subject.height * 0.8 : 1.55,
        0.3,
      );
      side.applyAxisAngle(new THREE.Vector3(0, 1, 0), facing);
      o.position.copy(side);
      o.scale.setScalar(0.6);
    } else if (p.placement === 'big') {
      o.position.set(
        (i % 2 ? -1 : 1) * (2.5 + p.size * 0.3),
        id === 'plane' ? 9 : 0,
        -4 - p.size * 0.4,
      );
      o.rotation.y = id === 'plane' ? Math.PI / 2 : r() * 0.6 - 0.3;
    } else if (subject && p.size > 0.9) {
      // Furniture and big things stand clear of the person, beside and a little behind.
      const side = i % 2 ? -1 : 1;
      o.position.copy(near(side * (0.9 + p.size * 0.6), -0.6));
      o.rotation.y = facing + side * 0.3;
    } else if (subject) {
      const k = nearIndex++;
      o.position.copy(near((k % 2 ? -1 : 1) * 0.55, 0.5 + k * 0.1));
      o.rotation.y = facing + (r() - 0.5) * 1.2;
    } else {
      o.position.set((i % 2 ? -1 : 1) * 1.0, 0, 0.3);
      o.rotation.y = (r() - 0.5) * 1.2;
    }
    if (!o.parent) scene.add(o);
  });
  if (spec.bigText && !onSign && spec.props.includes('sign')) onSign = true;

  // A crowd in the background: villagers, soldiers, passers-by.
  const crowdLook = ['battlefield', 'jungle', 'island'].includes(spec.set);
  const crowd: { person: Person; pos: THREE.Vector3; facing: number; action: Action }[] =
    Array.from({ length: spec.crowd }, (_, i) => {
      const look: CastMember = {
        id: `extra${i}`,
        name: 'Extra',
        gender: r() > 0.45 ? 'male' : 'female',
        age: r() > 0.8 ? 'old' : 'adult',
        skin: (['pale', 'light', 'tan', 'brown', 'dark'] as const)[Math.floor(r() * 5)]!,
        hair: (['short', 'long', 'curly', 'bald'] as const)[Math.floor(r() * 4)]!,
        hairColor: ['#2a1f18', '#4a3324', '#8a6a3a', '#1c1c1c'][Math.floor(r() * 4)]!,
        top: crowdLook
          ? 'uniform'
          : (['tshirt', 'jacket', 'hoodie', 'sweater', 'suit'] as const)[Math.floor(r() * 5)]!,
        topColor: crowdLook
          ? '#5a6a3a'
          : ['#4a6fa5', '#a3342a', '#3f7a3a', '#d9b53a', '#5e3c7a', '#7a7c80'][
              Math.floor(r() * 6)
            ]!,
        bottomColor: ['#3a3f4a', '#3b5a8c', '#5a4a34'][Math.floor(r() * 3)]!,
        extra: crowdLook ? 'cap' : 'none',
      };
      const person = new Person(look, spec.seed + 50 + i);
      const side = i % 2 ? -1 : 1;
      const doing = spec.crowdAction;
      scene.add(person.root);
      if (subject && (tall > 1.7 || giantSitting)) {
        // At a giant's feet: a half ring in front, everyone facing up at them. A sitting giant's
        // legs reach out in front, so then they stand round the sides, chatting.
        const a = giantSitting
          ? (i % 2 ? -1 : 1) * (1.15 + (i >> 1) * 0.3)
          : (i / Math.max(1, spec.crowd - 1) - 0.5) * 2.2;
        const d = giantSitting ? 1.6 + (i % 3) * 0.6 : 1.6 + tall * 0.35 + (i % 3) * 0.7;
        const pos = flatOut(new THREE.Vector3(Math.sin(a) * d, 0, Math.cos(a) * d));
        return {
          person,
          pos,
          facing: Math.atan2(-pos.x, -pos.z) + (r() - 0.5) * 0.3,
          action: (giantSitting && ['idle', 'lookUp'].includes(doing)
            ? 'talk'
            : doing === 'idle'
              ? 'lookUp'
              : doing) as Action,
        };
      }
      if (doing === 'usePhone') {
        // Everyone on their phones: a loose group in front of the set, heads down.
        person.phone = true;
        const phone = makeProp('phone').object;
        person.handR.add(phone);
        const pos = new THREE.Vector3(
          side * (0.6 + (i >> 1) * 1.3) + (r() - 0.5) * 0.4,
          0,
          -0.5 - (i % 3) * 1.4,
        );
        return { person, pos, facing: (r() - 0.5) * 1.2, action: 'usePhone' as Action };
      }
      const pos = new THREE.Vector3(side * (2.2 + (i >> 1) * 1.4 + r() * 0.8), 0, -5 - r() * 4);
      const walking = doing === 'idle' && r() > 0.5;
      const facingC = walking ? (side * -Math.PI) / 2 : (r() - 0.5) * 0.8;
      return {
        person,
        pos,
        facing: facingC,
        action: (walking
          ? 'walk'
          : doing !== 'idle'
            ? doing
            : spec.action === 'lookUp'
              ? 'lookUp'
              : 'idle') as Action,
      };
    });
  // A classroom has pupils at their desks, facing the board.
  if (spec.set === 'classroom' && !spec.crowd)
    (
      [
        [-2, -1.05],
        [2, -1.05],
        [-2, -3.25],
        [2, -3.25],
      ] as [number, number][]
    ).forEach(([x, z], i) => {
      const look: CastMember = {
        id: `pupil${i}`,
        name: 'Pupil',
        gender: i % 2 ? 'female' : 'male',
        age: 'child',
        skin: (['light', 'tan', 'brown', 'pale'] as const)[i]!,
        hair: (['short', 'ponytail', 'curly', 'long'] as const)[i]!,
        hairColor: ['#2a1f18', '#8a6a3a', '#1c1c1c', '#4a3324'][i]!,
        top: 'hoodie',
        topColor: ['#d94a4a', '#4a8ad9', '#4ab06a', '#d9b53a'][i]!,
        bottomColor: '#3a3f4a',
        extra: 'none',
      };
      const person = new Person(look, spec.seed + 90 + i);
      scene.add(person.root);
      crowd.push({
        person,
        pos: new THREE.Vector3(x, 0, z),
        facing: Math.PI,
        action: 'sit' as Action,
      });
      const chair = makeProp('chair').object;
      chair.position.set(x, 0, z - 0.12 * -1);
      chair.rotation.y = Math.PI;
      scene.add(chair);
    });

  // Reading or picking something up: a sheet of paper in the hand.
  if (
    subject &&
    (spec.action === 'read' || spec.action === 'pickUp') &&
    !holdingPaper &&
    held === 0
  )
    subject.handR.add(heldSheet());

  // Things in the sky fly across it, high and in clear view; leaflets fall from planes.
  const flyer = props.find((p) => FLYERS.has(p.id ?? ''));
  const leaflets = props.find((p) => p.id === 'paper');
  if (flyer) {
    flyer.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) (m as THREE.MeshLambertMaterial).fog = false;
    });
    // Flying in from far away towards us: it stays in the tall frame the whole time.
    const speed = flyer.id === 'bird' ? 5 : flyer.id === 'helicopter' ? 7 : 16;
    const height = flyer.id === 'bird' ? 7 : 14;
    flyer.object.scale.setScalar(flyer.id === 'plane' ? 0.6 : 1);
    const path = (t: number) => new THREE.Vector3(-3 + t * 1.2, height - t * 0.25, -70 + t * speed);
    animated.push((t) => {
      flyer.object.position.copy(path(t));
      flyer.object.rotation.set(-0.08, 0.1, Math.sin(t * 0.7) * 0.08);
    });
    if (leaflets) {
      // Each sheet leaves the plane as it passes and flutters down.
      leaflets.object.scale.setScalar(1);
      leaflets.object.position.set(0, 0, 0);
      const sheets = leaflets.object.children;
      animated.push((t) =>
        sheets.forEach((c, i) => {
          const born = 0.2 + i * 0.12;
          const age = t - born;
          c.visible = age > 0;
          if (age <= 0) return;
          const from = path(born);
          c.scale.setScalar(2.2);
          c.position.set(
            from.x + Math.sin(age * 2 + i) * 0.9 + ((i % 5) - 2) * age * 1.1,
            Math.max(0.05, from.y - 1 - age * 2.2),
            from.z + age * 7,
          );
          c.rotation.set(age * 3 + i, age * 2, Math.sin(age * 4 + i) * 0.9);
        }),
      );
    }
  }
  const skyShot = !!flyer && !!subject && !pov && spec.framing !== 'object';

  // Effects.
  const effect = spec.effect;
  let tint = '#ffffff',
    tintAmount = 0;
  const dark = effect === 'darkness' || effect === 'spotlight';
  if (dark) {
    scene.background = new THREE.Color('#000000');
    scene.fog = new THREE.Fog('#000000', 2, 9);
    if (set.sky) set.sky.visible = false;
    for (const l of set.lights) l.intensity *= effect === 'darkness' ? 0.12 : 0.05;
    const key =
      effect === 'spotlight'
        ? new THREE.SpotLight('#fff4d8', 60, 12, 0.45, 0.4, 1.2)
        : new THREE.PointLight('#c8d4ff', 2.5, 4, 1.5);
    key.position.set(0, effect === 'spotlight' ? 5 : 2.2, effect === 'spotlight' ? 0.5 : 1.4);
    scene.add(key);
    if (key instanceof THREE.SpotLight) {
      key.target.position.set(0, 0, 0);
      scene.add(key.target);
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 2.2, 5, 10, 1, true),
        flat('#fff0c0', { additive: true, opacity: 0.08, side: THREE.DoubleSide }),
      );
      cone.position.set(0, 2.6, 0.3);
      scene.add(cone);
    }
  }
  const focusPerson = subject ?? null;
  if (effect === 'glow' || effect === 'silhouette') {
    const aura = sprite(effect === 'glow' ? '#3aa0ff' : '#ffffff', focusPerson ? 2.2 : 1.6);
    (aura.material as THREE.SpriteMaterial).opacity = 0.7;
    scene.add(aura);
    animated.push((t) => {
      const at = focusPerson
        ? focusPerson.point('body')
        : (focusProp?.object.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 1, 0));
      aura.position.copy(at);
      aura.scale
        .set(focusPerson ? 1.6 : 1.6, focusPerson ? 2.4 : 1.6, 1)
        .multiplyScalar(1 + Math.sin(t * 5) * 0.05);
    });
    if (effect === 'silhouette') {
      const white = new THREE.MeshBasicMaterial({ color: '#ffffff' });
      (focusPerson?.root ?? focusProp?.object)?.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = white;
      });
    }
  }
  if (effect === 'beam') {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.35, 5, 8, 1, true),
      flat('#fff2a0', { additive: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    beam.geometry.translate(0, -2.5, 0);
    scene.add(beam);
    animated.push((t) => {
      const eyes = focusPerson ? focusPerson.point('eyes') : new THREE.Vector3(0, 1.4, 0);
      beam.position.copy(eyes);
      const from = eyes.clone().add(new THREE.Vector3(-2.2, 2.2, 2.5));
      beam.lookAt(from);
      beam.rotateX(-Math.PI / 2);
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(t * 9) * 0.1;
    });
  }
  if (effect === 'xray') {
    // A scanner look: the set goes dark, the body turns to blue glass, the bones glow.
    focusPerson?.xray(true);
    for (const o of setObjects) if (!(o as THREE.Light).isLight) o.visible = false;
    scene.background = new THREE.Color('#07111e');
    scene.fog = null;
    tint = '#8fc0ff';
    tintAmount = 0.25;
  }
  if (effect === 'frozen') {
    tint = '#9fc8ff';
    tintAmount = 0.4;
    const dust = new THREE.Group();
    const mote = flat('#e8f4ff', { transparent: true, opacity: 0.8 });
    for (let i = 0; i < 60; i++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), mote);
      d.position.set((r() - 0.5) * 4, r() * 2.5, (r() - 0.5) * 3);
      dust.add(d);
    }
    scene.add(dust);
  }
  if (effect === 'sick') {
    tint = '#8fd06a';
    tintAmount = 0.35;
  }
  if (effect === 'sparkles') {
    const sparks = Array.from({ length: 30 }, () => {
      const s = sprite('#ffe680', 0.15);
      s.position.set((r() - 0.5) * 2, 0.3 + r() * 2, (r() - 0.5) * 1.2);
      scene.add(s);
      return { s, phase: r() * 6 };
    });
    animated.push((t) =>
      sparks.forEach(({ s, phase }) =>
        s.scale.setScalar(0.03 + Math.max(0, Math.sin(t * 6 + phase)) * 0.12),
      ),
    );
  }
  if (effect === 'rain') {
    tint = '#8a9ab0';
    tintAmount = 0.3;
    for (const l of set.lights) l.intensity *= 0.6;
    const drops = new THREE.Group();
    const dm = flat('#bcd0e8', { transparent: true, opacity: 0.55 });
    for (let i = 0; i < 260; i++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.35, 0.008), dm);
      d.userData = { x: (r() - 0.5) * 10, z: (r() - 0.5) * 8, o: r() * 8 };
      drops.add(d);
    }
    scene.add(drops);
    animated.push((t) =>
      drops.children.forEach((d) =>
        d.position.set(d.userData.x, 8 - ((t * 9 + d.userData.o) % 8), d.userData.z),
      ),
    );
  }
  if (effect === 'fire') {
    const flames = Array.from({ length: 9 }, (_, i) => {
      const f = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 0.9, 5),
        flat(i % 2 ? '#ff7a1a' : '#ffc23a', { additive: true, opacity: 0.85 }),
      );
      const a = (i / 9) * Math.PI * 2;
      f.position.set(Math.cos(a) * 0.7, 0.45, Math.sin(a) * 0.7);
      scene.add(f);
      return f;
    });
    const glowLight = new THREE.PointLight('#ff8a30', 10, 6, 1.5);
    glowLight.position.set(0, 1, 0.6);
    scene.add(glowLight);
    animated.push((t) => {
      flames.forEach((f, i) => f.scale.set(1, 0.7 + Math.abs(Math.sin(t * 11 + i * 1.7)) * 0.6, 1));
      glowLight.intensity = 8 + Math.sin(t * 17) * 2;
    });
  }
  let flash = (_t: number) => 0;
  if (effect === 'explosion') {
    const t0 = Math.min(0.4, duration * 0.2);
    const balls = Array.from({ length: 14 }, (_, i) => {
      const b = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.4, 0),
        flat(['#ffcf40', '#ff8a20', '#ff4a10', '#5a5a5a'][i % 4]!, { transparent: true }),
      );
      const dir = new THREE.Vector3(r() - 0.5, r() * 0.8, r() - 0.5).normalize();
      b.userData = { dir, speed: 2 + r() * 4 };
      b.visible = false;
      scene.add(b);
      return b;
    });
    const at = new THREE.Vector3(0, 1, -1.5);
    animated.push((t) => {
      const k = t - t0;
      balls.forEach((b) => {
        b.visible = k > 0;
        if (k <= 0) return;
        b.position.copy(at).addScaledVector(b.userData.dir, b.userData.speed * Math.min(k, 1.2));
        b.scale.setScalar(1 + k * 2);
        (b.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k / 1.4);
      });
    });
    flash = (t) => Math.max(0, 0.85 - Math.abs(t - t0) * 4) * (t > t0 - 0.05 ? 1 : 0);
  }

  // Signs carry the big words when the shot has one.
  if (onSign && !propIds.includes('sign')) {
    const s = sign(spec.bigText);
    s.position.set(1.4, 0, -0.6);
    scene.add(s);
  }

  const action = spec.action;
  const frozen = effect === 'frozen';
  const speaker = spec.speaker;
  const shake = spec.camera === 'shake' || effect === 'explosion';

  let focusDist = 5;
  // Set furniture never stands where a person is (a bed through the legs, a table in a body).
  {
    const spots = [
      base.clone(),
      ...otherSpots.map((o) => o.pos),
      ...crowd.filter((c) => c.action !== 'sit').map((c) => c.pos),
    ];
    const size = new THREE.Vector3();
    for (const o of setObjects) {
      if ((o as THREE.Light).isLight || o === set.sky || !o.parent) continue;
      const box = new THREE.Box3().setFromObject(o);
      box.getSize(size);
      if (size.x > 3.5 || size.z > 3.5 || size.y > 5 || box.isEmpty()) continue;
      box.expandByScalar(0.3);
      if (
        spots.some((p) => p.x > box.min.x && p.x < box.max.x && p.z > box.min.z && p.z < box.max.z)
      )
        scene.remove(o);
    }
  }

  // What can stand between the camera and its subject (not people, not the sky, not glows).
  let blockers: THREE.Object3D[] | null = null;
  const ray = new THREE.Raycaster();
  const blockersNow = () => {
    if (blockers) return blockers;
    const personal = new Set<THREE.Object3D>();
    for (const p of [...people.values(), ...crowd.map((c) => c.person)])
      p.root.traverse((o) => personal.add(o));
    blockers = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || personal.has(o) || !o.visible) return;
      const m = mesh.material as THREE.Material;
      if (
        Array.isArray(m) ||
        m.transparent ||
        m.side === THREE.BackSide ||
        (m as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending
      )
        return;
      blockers!.push(o);
    });
    return blockers;
  };

  // Small set pieces that may end up right in front of the camera.
  let clutterList: { object: THREE.Object3D; box: THREE.Box3 }[] | null = null;
  const clutter = () => {
    if (clutterList) return clutterList;
    scene.updateMatrixWorld();
    const size = new THREE.Vector3();
    clutterList = setObjects
      .filter((o) => o.parent && !(o as THREE.Light).isLight && o !== set.sky)
      .map((o) => ({ object: o, box: new THREE.Box3().setFromObject(o) }))
      .filter((c) => !c.box.isEmpty() && c.box.getSize(size).length() < 12);
    return clutterList;
  };

  const update = (t: number, frame: number) => {
    growTo(t);
    const at = frozen ? 0.4 : t;
    set.update?.(at);
    for (const p of props) p.update?.(at);
    if (subject)
      subject.pose(
        action,
        at,
        speaker === mainCast?.id ? (spec.mouth[frame] ?? 0) : 0,
        base,
        facing,
        spec.mood,
      );
    others.forEach((c, i) => {
      const p = people.get(c.id)!;
      const spot = otherSpots[i]!;
      p.pose(
        speaker === c.id
          ? 'talk'
          : ['shock', 'celebrate', 'lookUp', 'salute', 'patrol', 'nod', 'wave'].includes(action)
            ? action
            : 'idle',
        at + i,
        speaker === c.id ? (spec.mouth[frame] ?? 0) : 0,
        spot.pos,
        spot.facing,
        spec.mood,
      );
    });
    crowd.forEach((c, i) => c.person.pose(c.action, at + i * 0.7, 0, c.pos, c.facing, spec.mood));
    for (const a of animated) a(t);

    // Camera. The blocky look (ADR-055) is livelier: long shots cut to a closer angle halfway,
    // every shot drifts, and moves cover more ground.
    const lively = blocky();
    const recut =
      lively &&
      duration > 3.4 &&
      t > duration / 2 &&
      !pov &&
      !skyShot &&
      !!subject &&
      // Never cut away from what the shot is about: a second person, things at the feet.
      !(spec.framing === 'medium' && (others.length > 0 || nearIndex > 0));
    const framing: ShotSpec['framing'] = recut
      ? (RECUT[spec.framing] ?? spec.framing)
      : spec.framing;
    const span = lively && duration > 3.4 ? duration / 2 : duration;
    const k = smooth((recut ? t - duration / 2 : t) / Math.max(0.1, span));
    let focus: THREE.Vector3;
    let dist: number;
    let lift = 0;
    let fov = 40;
    if (subject && !pov && !skyShot) {
      const eyes = subject.point('eyes');
      switch (framing) {
        case 'extremeCloseUp':
          focus = eyes.clone().add(new THREE.Vector3(0, -0.04, 0));
          dist = 0.62;
          fov = 38;
          break;
        case 'closeUp':
          focus = eyes.clone().add(new THREE.Vector3(0, -0.1, 0));
          dist = 1.05;
          break;
        case 'medium': {
          focus = subject.point('chest').add(new THREE.Vector3(0, 0.15, 0));
          dist = 2.3;
          lift = 0.1;
          // Things at their feet (coconuts by the banana-eater) must be in frame too.
          if (nearIndex > 0) {
            focus = subject.point('body').add(new THREE.Vector3(0, -0.1, 0));
            dist = 3.4;
            lift = 0.5;
          }
          // Two people: frame them both.
          const other = others[0] && people.get(others[0].id);
          if (other) {
            focus.lerp(other.point('chest').add(new THREE.Vector3(0, 0.15, 0)), 0.5);
            dist = 3.6;
          }
          break;
        }
        case 'overhead':
          focus = subject.point('body');
          dist = 6;
          break;
        case 'lowAngle':
          // From about knee height, never from under the feet. A giant is seen from the
          // ground, where the people at their feet stand.
          focus = subject.point('chest').add(new THREE.Vector3(0, 0.2, 0));
          dist = 2.6;
          lift = -0.55;
          if (tall > 1.7) {
            // From behind the people at the giant's feet: them below, the giant above.
            focus = subject.root.position
              .clone()
              .add(new THREE.Vector3(0, subject.height * 0.52, 0));
            dist = subject.height * 1.5;
            lift = 1.5 - focus.y;
          }
          break;
        case 'object':
          focus = focusProp
            ? (focusProp as Prop).object.getWorldPosition(new THREE.Vector3())
            : subject.point('hand');
          dist = focusProp ? Math.max(0.5, (focusProp as Prop).size * 2.4) : 0.7;
          break;
        default:
          focus = subject.point('body').add(new THREE.Vector3(0, 0.1, 0));
          dist = 5.2;
          lift = 0.9;
      }
      // Blocky heads are bigger: close framings step back to fit them.
      // Close-ups keep the shoulders in (head and shoulders, as the genre frames faces).
      if (lively && (framing === 'closeUp' || framing === 'extremeCloseUp')) {
        dist *= framing === 'closeUp' ? 1.75 : 1.5;
        focus.y -= 0.12;
      } else if (lively && framing === 'medium') dist *= 1.2;
      // A giant's close shots look down a little, so the town is behind them, not empty sky.
      if (
        tall > 1.7 &&
        action !== 'usePhone' &&
        ['medium', 'closeUp', 'extremeCloseUp'].includes(framing)
      )
        lift = Math.max(lift, dist * 0.22);
      // A giant sitting among people: wide enough to see everyone round them.
      if (giantSitting && spec.crowd > 0) {
        focus = subject.point('chest');
        dist = 6.5;
        lift = 0.8;
      }
      // Taller people need more room in the frame.
      if (tall > 1.25 && ['wide', 'medium', 'overhead'].includes(framing)) {
        dist *= tall * (framing === 'medium' ? 0.75 : 1);
        lift *= tall;
      }
      // Someone lying down is seen from above and beside, never from the feet (that looked
      // into the bed frame or a wall).
      if ((action === 'sleep' || action === 'lie') && framing !== 'object') {
        lift = dist * 0.85;
        dist *= 0.7;
      }
    } else if (skyShot) {
      // Over the shoulder, looking up at the sky: the person low in frame, the flyer above.
      focus = new THREE.Vector3(0, 6.5, -26);
      dist = 0;
    } else if (pov) {
      focus = focusProp
        ? (focusProp as Prop).object.getWorldPosition(new THREE.Vector3())
        : new THREE.Vector3(0, 1.4, -2);
      dist = 0;
    } else if (focusProp) {
      const fp = focusProp as Prop;
      focus = fp.object.getWorldPosition(new THREE.Vector3());
      if (fp.placement === 'big') focus.y += fp.size * 0.25;
      dist = Math.max(
        0.7,
        fp.size * (framing === 'wide' ? 2.4 : framing === 'extremeCloseUp' ? 1.4 : 2.2),
      );
      lift = fp.size * 0.15;
    } else {
      focus = new THREE.Vector3(0, 1.4, -2);
      dist = framing === 'wide' || framing === 'overhead' ? 9 : 5;
      lift = 1;
    }
    const move = spec.camera;
    // Gentle moves: a push-in covers a tenth of the distance (a twentieth on faces).
    const amount =
      (framing === 'extremeCloseUp' || framing === 'closeUp' ? 0.05 : 0.1) * (lively ? 2.4 : 1);
    const scale =
      move === 'pushIn'
        ? 1 + amount / 2 - amount * k
        : move === 'pullOut'
          ? 1 - amount / 2 + amount * k
          : 1 - (lively ? 0.08 : 0.02) * k;
    let az = (subject ? facing : 0) * (framing === 'wide' ? 0.5 : 1);
    // Someone lying down is filmed from beside the bed, where the face is seen.
    if (subject && (action === 'sleep' || action === 'lie')) az += 0.95;
    if (move === 'orbit') az += (k - 0.5) * (lively ? 1.1 : 0.5);
    else if (lively) az += (k - 0.5) * (recut ? -0.3 : 0.35);
    const d = dist * scale;
    if (skyShot) {
      const head = subject!.point('eyes');
      // Just behind and above the shoulder, so the head and shoulders sit at the bottom of the tall frame.
      camera.position.set(
        head.x + 0.28 + Math.sin(k * 1.2) * 0.06,
        head.y + 0.1,
        head.z + 3.6 - k * 0.3,
      );
      camera.lookAt(focus);
    } else if (pov) {
      camera.position.set(0, 1.55, 1.9 - k * (move === 'pushIn' ? 0.35 : 0.1));
      camera.lookAt(focus);
      if (!camera.children.length && mainCast) camera.add(povArm(mainCast));
      if (!camera.parent) scene.add(camera);
    } else if (framing === 'overhead' && subject && tall > 1.7 && action === 'lookDown') {
      // Over a giant's shoulder, looking down at what is at their feet.
      const eyes = subject.point('eyes');
      const back = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
      camera.position
        .copy(eyes)
        .addScaledVector(back, -4.2 - k * 0.5)
        .add(new THREE.Vector3(1.2, 2.4, 0));
      focus = back
        .clone()
        .multiplyScalar(subject.height * 1.1)
        .setY(0.6);
      camera.lookAt(focus);
    } else if (framing === 'overhead') {
      camera.position.set(focus.x + Math.sin(az) * 0.6, focus.y + d, focus.z + Math.cos(az) * 0.6);
      camera.lookAt(focus);
    } else {
      const tiltLift = move === 'tilt' ? (1 - k) * -0.4 * d : 0;
      camera.position.set(
        focus.x + Math.sin(az) * d,
        focus.y + lift + tiltLift,
        focus.z + Math.cos(az) * d,
      );
      camera.lookAt(focus);
    }
    if (shake) {
      const s = 0.018 * Math.max(0.5, d * 0.3) * (effect === 'explosion' ? 3 : 1);
      camera.position.x += Math.sin(t * 47) * s;
      camera.position.y += Math.sin(t * 59 + 1) * s;
    }
    if (effect === 'sick') camera.rotateZ(Math.sin(t * 2.2) * 0.06);
    // Nothing between the camera and what it films: pull in in front of any wall or object.
    // Indoors the camera stays under the ceiling.
    if (set.indoor && camera.position.y > 2.65) {
      camera.position.y = 2.65;
      camera.lookAt(focus);
    }
    if (!pov && !skyShot) {
      // Moving things (cars, people) were just moved: bring their world positions up to date.
      scene.updateMatrixWorld();
      const toCam = camera.position.clone().sub(focus);
      const len = toCam.length();
      if (len > 0.05) {
        toCam.divideScalar(len);
        ray.set(focus, toCam);
        ray.far = len;
        const blocked = (dir: THREE.Vector3) => {
          ray.set(focus, dir);
          // Ignore what the focus itself touches (the floor under a point on the ground).
          ray.near = 0.25;
          ray.far = len;
          const hit = ray.intersectObjects(blockersNow(), false)[0];
          return hit && hit.distance < len - 0.05 ? hit.distance : null;
        };
        const first = blocked(toCam);
        if (first !== null) {
          // Swing round the subject to a clear angle; only pull in when none is clear.
          let clear: THREE.Vector3 | null = null;
          for (const turn of [0.5, -0.5, 1, -1, 1.5, -1.5]) {
            const dir = toCam.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn);
            if (blocked(dir) === null) {
              clear = dir;
              break;
            }
          }
          if (clear) camera.position.copy(focus).addScaledVector(clear, len);
          else camera.position.copy(focus).addScaledVector(toCam, Math.max(0.6, first - 0.25));
          camera.lookAt(focus);
        }
      }
    }
    if (lively && !pov) {
      // A hand-held float, slow enough never to blur a face.
      const f = 0.012 * Math.max(0.6, camera.position.distanceTo(focus) * 0.25);
      camera.position.x += Math.sin(t * 0.9 + spec.seed) * f;
      camera.position.y += Math.sin(t * 1.3 + spec.seed * 2) * f * 0.6;
      camera.lookAt(focus);
    }
    // Clutter right in front of the lens (a parked car, a fence, a branch) is not drawn.
    if (!pov) {
      const near = clutter();
      for (const c of near) {
        // Moving things (the passing car) are measured where they are now.
        c.object.visible = true;
        c.box.setFromObject(c.object);
        c.object.visible = c.box.distanceToPoint(camera.position) > 2.2;
      }
    }
    focusDist = camera.position.distanceTo(focus);
    camera.fov = fov;
    camera.updateProjectionMatrix();
  };

  return {
    scene,
    camera,
    update,
    look: (t) => ({ tint, tintAmount, flash: flash(t) }),
    overlay: onSign ? '' : spec.bigText,
    focusDistance: () => focusDist,
  };
}

/** Frees a shot's GPU memory (textures are shared and freed after the whole render). */
export function disposeShot(shot: BuiltShot): void {
  shot.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material;
    if (m) for (const x of Array.isArray(m) ? m : [m]) x.dispose();
  });
}

/** One sheet of paper with lines of print, for holding. */
function heldSheet(): THREE.Mesh {
  const sheet = new THREE.Mesh(
    new THREE.BoxGeometry(0.21, 0.29, 0.004),
    mat('#ffffff', {
      map: texture('leaflet:held', [16, 24], (g, w, h, rr) => {
        g.fillStyle = '#efe9d6';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#3a3a3a';
        for (let y = 3; y < h - 2; y += 3) g.fillRect(2, y, 4 + rr() * (w - 6), 1);
      }),
    }),
  );
  sheet.rotation.x = -1.1;
  return sheet;
}
