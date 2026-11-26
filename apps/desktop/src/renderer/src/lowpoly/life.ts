// Background life for the low-poly sets (ADR-054): nothing in a shot should stand completely
// still. Trees sway, clouds drift, birds cross the sky, leaves fall in forests, cars pass in
// streets, people walk behind, waves roll, smoke rises, dust floats indoors. Everything is a pure
// function of time, seeded per shot.
import * as THREE from 'three';
import type { CastMember, SetId } from '@rec-it/lowpoly';
import { Person } from './people';
import { makeProp } from './props';
import { flat, mat } from './ps1';

type Update = (t: number) => void;

function bird(colour: string): { object: THREE.Group; wings: THREE.Mesh[] } {
  const body = mat(colour);
  const object = new THREE.Group();
  object.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.3), body));
  const wings = [-1, 1].map((side) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.02, 0.14), body);
    w.geometry.translate((side * 0.32) / 2, 0, 0);
    object.add(w);
    return w;
  });
  return { object, wings };
}

const PASSERS: CastMember[] = [
  {
    id: 'passer1',
    name: 'Passer-by',
    gender: 'female',
    age: 'adult',
    skin: 'light',
    hair: 'long',
    hairColor: '#6a4a2a',
    top: 'jacket',
    topColor: '#3f7a3a',
    bottomColor: '#3a3f4a',
    extra: 'none',
  },
  {
    id: 'passer2',
    name: 'Passer-by',
    gender: 'male',
    age: 'old',
    skin: 'brown',
    hair: 'short',
    hairColor: '#2a1f18',
    top: 'sweater',
    topColor: '#7a5a3a',
    bottomColor: '#5a4a34',
    extra: 'hat',
  },
];

/** Adds the moving background of a set; returns its update. */
export function addLife(
  scene: THREE.Scene,
  id: SetId,
  r: () => number,
  sky: THREE.Object3D | null,
): Update {
  const updates: Update[] = [];
  const outdoor = ![
    'livingRoom',
    'kitchen',
    'bedroom',
    'office',
    'hospital',
    'lab',
    'classroom',
    'prison',
    'bank',
    'courtroom',
  ].includes(id);

  // Swaying trees and drifting clouds.
  const swaying: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (o.userData.sway !== undefined) swaying.push(o);
  });
  if (swaying.length)
    updates.push((t) => {
      for (const o of swaying) {
        const p = o.userData.sway as number;
        o.rotation.z = Math.sin(t * 0.9 + p) * 0.03;
        o.rotation.x = Math.sin(t * 0.7 + p * 1.3) * 0.02;
      }
    });
  if (sky && outdoor) updates.push((t) => (sky.rotation.y = t * 0.008));

  // Birds crossing the sky.
  if (outdoor && !['space', 'underwater', 'void', 'city'].includes(id)) {
    const colour = id === 'island' || id === 'ocean' || id === 'beach' ? '#f2f2ee' : '#2a2a2e';
    const flock = Array.from({ length: 4 }, (_, i) => {
      const b = bird(colour);
      scene.add(b.object);
      return {
        ...b,
        off: r() * 60,
        h: 7 + r() * 6,
        z: -14 - r() * 18,
        speed: 3 + r() * 2,
        phase: i,
      };
    });
    updates.push((t) =>
      flock.forEach((b) => {
        b.object.position.set(
          -30 + ((t * b.speed + b.off) % 60),
          b.h + Math.sin(t + b.phase) * 0.4,
          b.z,
        );
        b.object.rotation.y = Math.PI / 2;
        const flap = Math.sin(t * 11 + b.phase) * 0.6;
        b.wings[0]!.rotation.z = flap;
        b.wings[1]!.rotation.z = -flap;
      }),
    );
  }

  // Falling leaves in forests and jungles.
  if (id === 'jungle' || id === 'forest') {
    const leaf = flat(id === 'jungle' ? '#5a8a3a' : '#c9a23a', { side: THREE.DoubleSide });
    const leaves = Array.from({ length: 26 }, () => {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.05), leaf);
      scene.add(l);
      return { l, x: (r() - 0.5) * 8, z: -4 + r() * 6, o: r() * 6, s: 0.25 + r() * 0.3 };
    });
    updates.push((t) =>
      leaves.forEach(({ l, x, z, o, s }) => {
        const age = (t * s + o) % 6;
        l.position.set(x + Math.sin(age * 2 + o) * 0.4, 5.5 - age * 0.95, z);
        l.rotation.set(age * 2, age * 3, age);
      }),
    );
  }

  // Streets: a passing car and people walking behind.
  if (id === 'street' || id === 'city') {
    const car = makeProp('car').object;
    car.rotation.y = Math.PI / 2;
    scene.add(car);
    const lights = id === 'city' ? new THREE.PointLight('#ffe8b0', 5, 8, 1.5) : null;
    if (lights) car.add(lights);
    const off = r() * 40;
    updates.push((t) =>
      car.position.set(-60 + ((t * 11 + off) % 120), 0, id === 'street' ? -4.6 : -7),
    );
    const walkers = PASSERS.map((c, i) => {
      const p = new Person(c, 900 + i);
      scene.add(p.root);
      return { p, dir: i ? -1 : 1, start: (r() - 0.5) * 10, z: -8.5 - i * 1.2 };
    });
    updates.push((t) =>
      walkers.forEach((w) =>
        w.p.pose(
          'walk',
          t + w.dir,
          0,
          new THREE.Vector3(w.start - w.dir * 3, 0, w.z),
          (w.dir * Math.PI) / 2,
        ),
      ),
    );
  }

  // Water rolls.
  scene.traverse((o) => {
    if (!o.userData.waves) return;
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
    const pos = geo.attributes.position!;
    const base = Float32Array.from(pos.array as Float32Array);
    updates.push((t) => {
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3]!,
          z = base[i * 3 + 2]!;
        pos.setY(
          i,
          base[i * 3 + 1]! +
            Math.sin(x * 0.3 + t * 1.6) * 0.12 +
            Math.cos(z * 0.22 + t * 1.1) * 0.1,
        );
      }
      pos.needsUpdate = true;
    });
  });

  // Smoke rises over battlefields; distant flashes.
  if (id === 'battlefield') {
    const puffs = Array.from({ length: 10 }, () => {
      const p = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 0),
        flat('#8a8580', { transparent: true, opacity: 0.3 }),
      );
      scene.add(p);
      return { p, x: (r() - 0.5) * 30, z: -12 - r() * 25, o: r() * 8 };
    });
    const flash = new THREE.PointLight('#ffb070', 0, 60, 1);
    flash.position.set(-8, 4, -30);
    scene.add(flash);
    updates.push((t) => {
      puffs.forEach(({ p, x, z, o }) => {
        const age = (t * 0.6 + o) % 8;
        p.position.set(x + age * 0.4, 1 + age * 1.2, z);
        p.scale.setScalar(0.8 + age * 0.5);
        (p.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - age / 8);
      });
      flash.intensity = Math.max(0, Math.sin(t * 2.3) * Math.sin(t * 5.1)) > 0.7 ? 30 : 0;
    });
  }

  // Dust floating in the light indoors.
  if (!outdoor) {
    const mote = flat('#fff6e0', { additive: true, opacity: 0.5 });
    const motes = Array.from({ length: 40 }, () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.012), mote);
      scene.add(m);
      return { m, x: (r() - 0.5) * 5, y: 0.4 + r() * 2.2, z: (r() - 0.5) * 4, o: r() * 6 };
    });
    updates.push((t) =>
      motes.forEach(({ m, x, y, z, o }) =>
        m.position.set(
          x + Math.sin(t * 0.3 + o) * 0.3,
          y + Math.sin(t * 0.4 + o * 2) * 0.2,
          z + Math.cos(t * 0.25 + o) * 0.3,
        ),
      ),
    );
  }

  // Fish swim underwater.
  if (id === 'underwater') {
    const school = Array.from({ length: 5 }, (_, i) => {
      const f = makeProp('fish').object;
      f.scale.setScalar(0.4);
      scene.add(f);
      return { f, r: 3 + i, h: 1 + r() * 3, o: r() * 6 };
    });
    updates.push((t) =>
      school.forEach(({ f, r: rad, h, o }) => {
        const a = t * 0.3 + o;
        f.position.set(Math.cos(a) * rad, h, -5 + Math.sin(a) * rad * 0.5);
        f.rotation.y = -a;
      }),
    );
  }

  // A tumbleweed in the desert.
  if (id === 'desert') {
    const weed = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), mat('#8a6a3a'));
    scene.add(weed);
    updates.push((t) => {
      weed.position.set(-20 + ((t * 3) % 40), 0.4 + Math.abs(Math.sin(t * 3)) * 0.3, -4);
      weed.rotation.z = -t * 3;
    });
  }

  return (t) => updates.forEach((u) => u(t));
}
