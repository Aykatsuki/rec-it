// One shot of a low-poly Short (ADR-054): the set, the people and props placed in it, the effect,
// and a camera that frames the subject and moves over the shot. `update(t)` is a pure function of
// the time into the shot, so any frame can be drawn on its own.
import * as THREE from 'three';
import type { CastMember, Model, ShotSpec } from '@rec-it/lowpoly';
import { YOU } from '@rec-it/lowpoly';
import { Person } from './people';
import { anyProp, makeProp, sign, type Prop } from './props';
import { flat } from './ps1';
import { buildSet } from './sets';
import { rng, texture } from './textures';

export interface BuiltShot {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update: (t: number, frame: number) => void;
  /** Post-process settings for this moment. */
  look: (t: number) => { tint: string; tintAmount: number; flash: number };
  /** Big words drawn over the picture (unless they are on a sign in the scene). */
  overlay: string;
}

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
  const set = buildSet(spec.set, spec.seed);
  const { scene } = set;
  const setObjects = [...scene.children];
  const camera = new THREE.PerspectiveCamera(40, 9 / 16, 0.03, 400);
  const member = (id: string) => cast.find((c) => c.id === id) ?? (id === 'you' ? YOU : undefined);

  // People.
  const people = new Map<string, Person>();
  const mainCast = member(spec.subject);
  const pov = spec.framing === 'pov';
  const facing = pov ? Math.PI : [0, 0, 0.45, -0.45, 1.25][Math.floor(r() * 5)]!;
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

  // Furniture the action needs.
  let base = new THREE.Vector3();
  if (subject && spec.action === 'sit') {
    const chair = makeProp('chair').object;
    chair.position.set(0, 0, -0.12);
    chair.rotation.y = facing;
    scene.add(chair);
  }
  if (subject && spec.action === 'sleep') {
    const bed = makeProp('bed').object;
    bed.rotation.y = facing;
    bed.position.copy(
      new THREE.Vector3(0, 0, -0.85).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing),
    );
    scene.add(bed);
    base = new THREE.Vector3(0, 0.55, 0);
  }

  // Props.
  const props: Prop[] = [];
  const propSubject = !mainCast && spec.subject !== 'none' ? spec.subject : '';
  const propIds = [...new Set([...(propSubject ? [propSubject] : []), ...spec.props])];
  let focusProp = null as Prop | null;
  let onSign = false;
  propIds.forEach((id, i) => {
    const p = anyProp(id, spec.bigText, models);
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
        } else o.position.set(0, 1.0, 0);
        o.scale.setScalar(1.6);
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
    } else if (p.placement === 'hand' && subject) {
      subject.handR.add(o);
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
    } else {
      o.position.set((i % 2 ? -1 : 1) * 1.0, 0, 0.3);
      o.rotation.y = (r() - 0.5) * 1.2;
    }
    if (!o.parent) scene.add(o);
  });
  if (spec.bigText && !onSign && spec.props.includes('sign')) onSign = true;

  // Effects.
  const effect = spec.effect;
  let tint = '#ffffff',
    tintAmount = 0;
  const animated: ((t: number) => void)[] = [];
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

  const update = (t: number, frame: number) => {
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
      );
    others.forEach((c, i) => {
      const p = people.get(c.id)!;
      const spot = otherSpots[i]!;
      p.pose(
        speaker === c.id ? 'talk' : action === 'shock' || action === 'celebrate' ? action : 'idle',
        at + i,
        speaker === c.id ? (spec.mouth[frame] ?? 0) : 0,
        spot.pos,
        spot.facing,
      );
    });
    for (const a of animated) a(t);

    // Camera.
    const k = smooth(t / Math.max(0.1, duration));
    let focus: THREE.Vector3;
    let dist: number;
    let lift = 0;
    let fov = 40;
    if (subject && !pov) {
      const eyes = subject.point('eyes');
      switch (spec.framing) {
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
          focus = subject.point('chest');
          dist = 2.4;
          lift = -1.1;
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
        fp.size * (spec.framing === 'wide' ? 2.4 : spec.framing === 'extremeCloseUp' ? 1.4 : 2.2),
      );
      lift = fp.size * 0.15;
    } else {
      focus = new THREE.Vector3(0, 1.4, -2);
      dist = spec.framing === 'wide' || spec.framing === 'overhead' ? 9 : 5;
      lift = 1;
    }
    const move = spec.camera;
    // Gentle moves: a push-in covers a tenth of the distance (a twentieth on faces).
    const amount = spec.framing === 'extremeCloseUp' || spec.framing === 'closeUp' ? 0.05 : 0.1;
    const scale =
      move === 'pushIn'
        ? 1 + amount / 2 - amount * k
        : move === 'pullOut'
          ? 1 - amount / 2 + amount * k
          : 1 - 0.02 * k;
    let az = (subject ? facing : 0) * (spec.framing === 'wide' ? 0.5 : 1);
    if (move === 'orbit') az += (k - 0.5) * 0.5;
    const d = dist * scale;
    if (pov) {
      camera.position.set(0, 1.55, 1.9 - k * (move === 'pushIn' ? 0.35 : 0.1));
      camera.lookAt(focus);
      if (!camera.children.length && mainCast) camera.add(povArm(mainCast));
      if (!camera.parent) scene.add(camera);
    } else if (spec.framing === 'overhead') {
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
    camera.fov = fov;
    camera.updateProjectionMatrix();
  };

  return {
    scene,
    camera,
    update,
    look: (t) => ({ tint, tintAmount, flash: flash(t) }),
    overlay: onSign ? '' : spec.bigText,
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
