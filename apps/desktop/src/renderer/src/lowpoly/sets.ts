// Sets for the low-poly kit (ADR-054). The subject stands at the origin facing +z, the camera
// is usually on the +z side, so each set dresses the space behind and beside the origin. Every
// set is seeded, so the same shot always looks the same.
import * as THREE from 'three';
import type { SetId } from '@rec-it/lowpoly';
import { flat, mat } from './ps1';
import { addLife } from './life';
import { blocky } from './style';
import { cloud, house, makeProp, tree } from './props';
import { noise, rng, shade, SURFACES, texture, type Paint } from './textures';

export interface BuiltSet {
  scene: THREE.Scene;
  indoor: boolean;
  /** Height of a table top near the subject, for object close-ups. */
  tableTop: number;
  /** Animated parts of the set (water, bubbles…). */
  update?: (t: number) => void;
  /** Lights (dimmed by the darkness and spotlight effects). */
  lights: THREE.Light[];
  sky: THREE.Object3D | null;
}

const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

function m(geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, y, z);
  return mesh;
}

function surface(key: string, paint: Paint, repeat: [number, number], colour = '#ffffff') {
  return mat(colour, { map: texture(key, [32, 32], paint, repeat) });
}

/** A floor: a subdivided plane (big flat triangles swim too much with affine textures). */
function floor(size: number, material: THREE.Material, y = 0): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(size, size, 24, 24);
  geo.rotateX(-Math.PI / 2);
  return m(geo, material, 0, y, 0);
}

function skyDome(top: string, bottom: string, clouds = true): THREE.Mesh {
  const tex = texture(
    `sky:${top}:${bottom}:${clouds}`,
    [128, 64],
    SURFACES.sky(top, bottom, clouds),
  );
  tex.wrapS = THREE.RepeatWrapping;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(180, 16, 10),
    flat('#ffffff', { map: tex, side: THREE.BackSide, fog: false }),
  );
  return dome;
}

function light(
  scene: THREE.Scene,
  o: {
    sky: string;
    ground: string;
    hemi: number;
    sun: string;
    sunI: number;
    dir: [number, number, number];
  },
): THREE.Light[] {
  const hemi = new THREE.HemisphereLight(o.sky, o.ground, o.hemi);
  const sun = new THREE.DirectionalLight(o.sun, o.sunI);
  sun.position.set(...o.dir);
  scene.add(hemi, sun);
  return [hemi, sun];
}

/** A room: floor, three walls and a ceiling, open towards the camera. */
function room(
  scene: THREE.Scene,
  o: {
    floor: THREE.Material;
    wall: THREE.Material;
    w?: number;
    d?: number;
    h?: number;
    window?: boolean;
    night?: boolean;
  },
) {
  const night = !!o.night;
  const w = o.w ?? 9,
    d = o.d ?? 8,
    h = o.h ?? 3;
  scene.add(floor(Math.max(w, d) * 2, o.floor));
  scene.add(m(B(w, h, 0.2), o.wall, 0, h / 2, -d / 2));
  scene.add(m(B(0.2, h, d * 2), o.wall, -w / 2, h / 2, 0));
  scene.add(m(B(0.2, h, d * 2), o.wall, w / 2, h / 2, 0));
  scene.add(m(B(w, 0.2, d * 2), mat('#e9e6de'), 0, h, 0));
  scene.add(m(B(w, 0.12, 0.05), mat('#f2f0ea'), 0, 0.06, -d / 2 + 0.12));
  if (o.window ?? true) {
    const view = night
      ? texture('window:night', [32, 32], SURFACES.sky('#070d24', '#22305e', false))
      : texture('window:view', [32, 32], SURFACES.sky('#6fa8dc', '#dfeaf2'));
    scene.add(m(B(2, 1.3, 0.05), flat('#ffffff', { map: view }), 1.6, 1.7, -d / 2 + 0.12));
    scene.add(
      m(B(2.2, 0.08, 0.15), mat('#f2f0ea'), 1.6, 1.02, -d / 2 + 0.15),
      m(B(0.06, 1.3, 0.08), mat('#f2f0ea'), 1.6, 1.7, -d / 2 + 0.15),
    );
  }
  const lamp = new THREE.PointLight('#fff2d8', 8, 12, 1.4);
  lamp.position.set(0, h - 0.3, 0);
  scene.add(lamp, m(B(0.6, 0.06, 0.6), flat('#fff6e0'), 0, h - 0.1, 0));
  return lamp;
}

function place(
  scene: THREE.Scene,
  o: THREE.Object3D,
  x: number,
  z: number,
  rotY = 0,
  y = 0,
): THREE.Object3D {
  o.position.set(x, y, z);
  o.rotation.y = rotY;
  scene.add(o);
  return o;
}

export function buildSet(
  id: SetId,
  seed: number,
  opts: { clearing?: boolean; night?: boolean; ownBed?: boolean } = {},
): BuiltSet {
  const night = !!opts.night;
  // A clearing ahead of the subject, so the sky is in view (planes, birds).
  const clear = (x: number, z: number) => !!opts.clearing && Math.abs(x) < 10 && z > -40 && z < 2;
  const scene = new THREE.Scene();
  const r = rng(seed * 7 + 3);
  let indoor = true;
  let tableTop = 0.78;
  let update: ((t: number) => void) | undefined;
  let lights: THREE.Light[] = [];
  let sky: THREE.Object3D | null = null;
  const day = () => {
    indoor = false;
    if (night) {
      // Night (ADR-055): a deep blue sky with stars and a moon, cool moonlight.
      sky = skyDome('#070d24', '#22305e', false);
      scene.add(sky);
      scene.fog = new THREE.Fog('#121a38', 20, 110);
      lights = light(scene, {
        sky: '#5a6aa8',
        ground: '#1a1a24',
        hemi: 0.7,
        sun: '#a9bcff',
        sunI: 0.7,
        dir: [-5, 10, 4],
      });
      const stars = new THREE.Group();
      const star = flat('#ffffff', { fog: false });
      for (let i = 0; i < 260; i++) {
        const a = r() * Math.PI * 2;
        const e = 0.12 + r() * 1.3;
        const d = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), star);
        d.position.set(
          Math.cos(a) * Math.cos(e) * 160,
          Math.sin(e) * 160,
          Math.sin(a) * Math.cos(e) * 160,
        );
        stars.add(d);
      }
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(6, 16, 12),
        flat('#f4f0d8', { fog: false }),
      );
      moon.position.set(-40, 70, -120);
      scene.add(stars, moon);
      return;
    }
    // The blocky look's sky is a brighter, bluer game sky.
    sky = blocky() ? skyDome('#2f7fff', '#cfe8ff') : skyDome('#5f97d6', '#dce8f2');
    scene.add(sky);
    scene.fog = new THREE.Fog(blocky() ? '#d6eaff' : '#cfdbe6', 25, 120);
    lights = light(scene, {
      sky: '#dfeeff',
      ground: '#6a6a50',
      hemi: 1.6,
      sun: '#fff1d6',
      sunI: blocky() ? 2.6 : 2.2,
      dir: [5, 10, 6],
    });
  };
  const indoorLights = (extra: THREE.Light) => {
    scene.fog = new THREE.Fog('#2a2a2a', 12, 30);
    lights = [
      ...light(scene, {
        sky: night ? '#6a78b0' : '#fff6ea',
        ground: '#6a5a4a',
        hemi: night ? 0.45 : 1.4,
        sun: night ? '#9fb0ff' : '#fff1d6',
        sunI: night ? 0.25 : 1.2,
        dir: [3, 6, 8],
      }),
      extra,
    ];
    // At night only a warm lamp lights the room.
    if (night) (extra as THREE.PointLight).intensity *= 0.7;
  };

  switch (id) {
    case 'street': {
      day();
      scene.add(floor(300, surface('grass', SURFACES.grass(), [80, 80])));
      const road = m(
        new THREE.PlaneGeometry(7, 300, 4, 60).rotateX(-Math.PI / 2),
        mat('#ffffff', { map: texture('road', [32, 32], SURFACES.road(), [1, 40]) }),
        0,
        0.02,
        0,
      );
      road.rotation.y = Math.PI / 2;
      road.position.z = -3;
      scene.add(road);
      const walk = mat('#ffffff', {
        map: texture('pavement', [16, 16], SURFACES.pavement(), [150, 1]),
      });
      scene.add(m(B(300, 0.12, 2), walk, 0, 0.06, 0.8), m(B(300, 0.12, 2), walk, 0, 0.06, -6.8));
      // Game towns are colourful: bright walls, red and blue roofs.
      const walls = blocky()
        ? ['#f2c94c', '#7fd1e8', '#f28c8c', '#9be38a', '#f5f0e6', '#c9a8f2']
        : ['#d9d2c0', '#c9b9a0', '#b9c4c9', '#e2d6b8'];
      const roofs = blocky()
        ? ['#d9483b', '#3b6fd9', '#5a3b32', '#2f9e6a']
        : ['#5a3b32', '#3f4a5a', '#6a4030'];
      for (let i = -3; i <= 3; i++) {
        place(
          scene,
          house(walls[(i + 9) % walls.length]!, roofs[(i + 9) % roofs.length]!, night),
          i * 12 + (r() - 0.5) * 2,
          -14,
          0,
        );
        place(scene, tree(0.9 + r() * 0.4, i + 5), i * 12 + 6, -9 + (r() - 0.5) * 2);
        // Front gardens: a low fence and flower beds.
        const fence = mat('#f5f2ea');
        for (let k = -3; k <= 3; k++)
          scene.add(m(B(0.12, 0.7, 0.12), fence, i * 12 + k * 0.9, 0.35, -9.9));
        scene.add(m(B(5.6, 0.1, 0.06), fence, i * 12, 0.55, -9.9));
        for (let k = 0; k < 5; k++) {
          const colour = ['#ff5a7a', '#ffd23a', '#ff8a3a', '#c86aff'][(k + i + 9) % 4]!;
          scene.add(m(B(0.25, 0.25, 0.25), mat(colour), i * 12 - 2 + k, 0.13, -10.6));
        }
      }
      // Parked cars in different colours along the far kerb.
      for (let k = 0; k < 3; k++) {
        const parked = makeProp('car').object;
        place(scene, parked, -14 + k * 11 + r() * 3, -5.6, Math.PI / 2);
        // The body and roof share one paint material.
        ((parked.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial).color.set(
          ['#3b6fd9', '#f2c94c', '#2f9e6a'][k]!,
        );
      }
      for (let i = -3; i <= 3; i++) {
        const pole = m(
          new THREE.CylinderGeometry(0.06, 0.08, 4.5, 5),
          mat('#5a5a5a'),
          i * 14 + 5,
          2.25,
          -0.4,
        );
        scene.add(
          pole,
          m(B(0.8, 0.12, 0.3), night ? flat('#ffe2a0') : mat('#d9d9d0'), i * 14 + 5.3, 4.4, -0.4),
        );
        if (night && Math.abs(i) <= 1) {
          const glow = new THREE.PointLight('#ffd08a', 14, 12, 1.4);
          glow.position.set(i * 14 + 5.3, 4.2, -0.4);
          scene.add(glow);
        }
      }
      const car = makeProp('car').object;
      place(scene, car, -6 + r() * 3, -4.6, Math.PI / 2);
      break;
    }
    case 'livingRoom':
    case 'bedroom':
    case 'kitchen':
    case 'office':
    case 'hospital':
    case 'lab':
    case 'classroom':
    case 'prison':
    case 'bank': {
      const look: Record<string, [THREE.Material, THREE.Material]> = {
        livingRoom: [
          surface('carpet', SURFACES.carpet('#8a6a52'), [12, 12]),
          surface('wallpaper', SURFACES.wallpaper('#c9b48a'), [6, 2]),
        ],
        bedroom: [
          surface('wood:floor', SURFACES.wood('#9a6a3e'), [10, 10]),
          surface('wallpaper:blue', SURFACES.wallpaper('#9fb4c9'), [6, 2]),
        ],
        kitchen: [
          surface('checker', SURFACES.checker(), [14, 14]),
          surface('tiles:wall', SURFACES.tiles('#e8e4d8', '#b8b2a2'), [8, 3]),
        ],
        office: [
          surface('carpet:grey', SURFACES.carpet('#5a6068'), [12, 12]),
          surface('plaster', SURFACES.plaster('#d8d4ca'), [6, 2]),
        ],
        hospital: [
          surface('tiles:floor', SURFACES.tiles('#c9d6cf', '#9fb0a8'), [14, 14]),
          surface('plaster:green', SURFACES.plaster('#b9d0c4'), [6, 2]),
        ],
        lab: [
          surface('tiles:white', SURFACES.tiles('#e8eaea', '#b9bcbe'), [14, 14]),
          surface('tiles:labwall', SURFACES.tiles('#f2f2ee', '#c9c9c4'), [8, 3]),
        ],
        classroom: [
          surface('wood:class', SURFACES.wood('#a8743e'), [10, 10]),
          surface('plaster:cream', SURFACES.plaster('#e2d6b0'), [6, 2]),
        ],
        prison: [
          surface('concrete', SURFACES.concrete(), [10, 10]),
          surface('brick:grey', SURFACES.brick('#8a8780'), [5, 2]),
        ],
        bank: [
          surface('marble', SURFACES.marble(), [8, 8]),
          surface('plaster:bank', SURFACES.plaster('#cfc4a8'), [6, 2]),
        ],
      };
      const [fl, wl] = look[id]!;
      const lamp = room(scene, {
        floor: fl,
        wall: wl,
        window: id !== 'prison' && id !== 'bank',
        night,
      });
      indoorLights(lamp);
      if (id === 'livingRoom') {
        const sofa = new THREE.Group();
        const cloth = mat('#5a6a8a');
        sofa.add(
          m(B(2.4, 0.45, 0.9), cloth, 0, 0.32, 0),
          m(B(2.4, 0.7, 0.25), cloth, 0, 0.75, -0.35),
          m(B(0.25, 0.6, 0.9), cloth, -1.2, 0.5, 0),
          m(B(0.25, 0.6, 0.9), cloth, 1.2, 0.5, 0),
        );
        place(scene, sofa, -1.5, -3.2);
        place(scene, makeProp('tv').object, 2.6, -3.4, -0.4);
        place(scene, tree(0.35, 2), -3.8, -3.2);
      }
      if (id === 'bedroom') {
        // (Not when the shot brings its own bed for someone lying in it.)
        if (!opts.ownBed) place(scene, makeProp('bed').object, -1.8, -2.8);
        place(
          scene,
          m(
            B(1.2, 2, 0.6),
            mat('#ffffff', { map: texture('wood:wardrobe', [32, 32], SURFACES.wood('#7a5232')) }),
            0,
            1,
            0,
          ),
          3,
          -3.6,
        );
      }
      if (id === 'kitchen') {
        const counter = mat('#ffffff', {
          map: texture('wood:cupboard', [32, 32], SURFACES.wood('#b98a5a')),
        });
        scene.add(
          m(B(8, 0.9, 0.7), counter, 0, 0.45, -3.6),
          m(B(8, 0.05, 0.75), mat('#e8e4d8'), 0, 0.92, -3.58),
          m(B(8, 0.8, 0.4), counter, 0, 2.1, -3.75),
        );
        place(scene, makeProp('fridge').object, 3.4, -3.4);
        place(scene, makeProp('table').object, -1.8, -1.2);
      }
      if (id === 'office' || id === 'classroom') {
        for (let i = 0; i < 4; i++) {
          const desk = makeProp('table').object;
          place(scene, desk, (i % 2 ? 2 : -2) + (r() - 0.5) * 0.3, -1.5 - Math.floor(i / 2) * 2.2);
          if (id === 'office')
            place(
              scene,
              makeProp('computer').object,
              i % 2 ? 2 : -2,
              -1.6 - Math.floor(i / 2) * 2.2,
              0,
              0.78,
            );
        }
        if (id === 'classroom')
          scene.add(
            m(
              B(4, 1.4, 0.05),
              mat('#ffffff', {
                map: texture('board', [64, 24], (g, w, h, rr) => {
                  g.fillStyle = '#2f4a3a';
                  g.fillRect(0, 0, w, h);
                  g.fillStyle = '#e8e8e0';
                  for (let k = 0; k < 6; k++)
                    g.fillRect(4 + rr() * 30, 4 + k * 3, 6 + rr() * 20, 1);
                }),
              }),
              0,
              1.7,
              -3.85,
            ),
          );
      }
      if (id === 'hospital') {
        const bed = makeProp('bed').object;
        place(scene, bed, -2, -2.6);
        scene.add(
          m(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 4), mat('#c9c9c9'), -0.9, 0.9, -3),
          m(B(0.2, 0.3, 0.06), mat('#d9eef5', { transparent: true, opacity: 0.8 }), -0.9, 1.7, -3),
        );
        scene.add(m(B(0.05, 2.4, 3), mat('#9fc9d9'), 1.6, 1.3, -2.4));
      }
      if (id === 'lab') {
        const bench = mat('#e8e8e4');
        scene.add(
          m(B(6, 0.9, 0.8), bench, 0, 0.45, -3.4),
          m(B(6, 0.05, 0.85), mat('#2a2a2e'), 0, 0.92, -3.4),
        );
        for (let i = 0; i < 6; i++) {
          const colour = ['#5ad94a', '#4ab0d9', '#d94ab0'][i % 3]!;
          scene.add(
            m(
              new THREE.CylinderGeometry(0.08, 0.12, 0.3, 6),
              mat(colour, {
                emissive: colour,
                emissiveIntensity: 0.6,
                transparent: true,
                opacity: 0.85,
              }),
              -2.4 + i * 0.9,
              1.1,
              -3.4,
            ),
          );
        }
        place(scene, makeProp('computer').object, 2.2, -2.6, -0.5);
      }
      if (id === 'prison') {
        const bar = mat('#4a4c50');
        for (let i = -12; i <= 12; i++)
          scene.add(m(new THREE.CylinderGeometry(0.03, 0.03, 3, 4), bar, i * 0.3, 1.5, 2.6));
        scene.add(m(B(8, 0.1, 0.1), bar, 0, 2.9, 2.6));
        scene.add(
          m(B(0.9, 0.12, 2), mat('#8a8780'), -3.2, 0.5, -2.5),
          m(B(0.85, 0.1, 1.9), mat('#c9c4b8'), -3.2, 0.6, -2.5),
        );
      }
      if (id === 'bank') {
        scene.add(
          m(
            B(7, 1.1, 0.7),
            mat('#ffffff', { map: texture('wood:bank', [32, 32], SURFACES.wood('#6a3a22')) }),
            0,
            0.55,
            -2.6,
          ),
        );
        scene.add(
          m(
            new THREE.CylinderGeometry(1.1, 1.1, 0.3, 12),
            mat('#ffffff', { map: texture('metal:vault', [32, 32], SURFACES.metal('#9ea3a8')) }),
            2.5,
            1.4,
            -3.85,
          ).rotateX(Math.PI / 2),
        );
        for (let i = 0; i < 4; i++)
          place(scene, makeProp('money').object, -2 + i * 0.6, -2.6, 0, 1.12);
      }
      break;
    }
    case 'city': {
      indoor = false;
      sky = skyDome('#0b1024', '#2a3358', false);
      scene.add(sky);
      scene.fog = new THREE.Fog('#141a30', 20, 90);
      lights = light(scene, {
        sky: '#4a5a8a',
        ground: '#1a1a24',
        hemi: 1.1,
        sun: '#9fb4ff',
        sunI: 0.9,
        dir: [-4, 8, 6],
      });
      scene.add(floor(300, surface('asphalt', SURFACES.asphalt(), [60, 60])));
      const lit = mat('#ffffff', {
        map: texture('windows', [32, 64], SURFACES.windowLit()),
        emissive: '#ffffff',
        emissiveIntensity: 0.5,
      });
      for (let i = 0; i < 26; i++) {
        const h = 10 + r() * 30;
        const bld = m(B(5 + r() * 4, h, 5 + r() * 4), lit, (r() - 0.5) * 70, h / 2, -12 - r() * 50);
        scene.add(bld);
      }
      for (let i = -3; i <= 3; i++) {
        const lamp = new THREE.PointLight('#ffd08a', 6, 10, 1.5);
        lamp.position.set(i * 9 + 4.5, 4, -2);
        scene.add(
          lamp,
          m(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 5), mat('#3a3a3a'), i * 9 + 4.5, 2.1, -2.2),
          m(B(0.4, 0.15, 0.3), flat('#ffe0a0'), i * 9 + 4.5, 4.2, -2.2),
        );
      }
      break;
    }
    case 'forest':
    case 'farm': {
      day();
      scene.add(floor(300, surface('grass', SURFACES.grass(), [80, 80])));
      if (id === 'forest') {
        scene.fog = new THREE.Fog('#a9bba0', 8, 60);
        for (let i = 0; i < 40; i++) {
          const a = r() * Math.PI * 2,
            d = 4 + r() * 30;
          const x = Math.cos(a) * d,
            z = -Math.abs(Math.sin(a) * d) + 1;
          if ((Math.abs(x) < 2 && z > -3) || clear(x, z)) continue;
          place(scene, tree(0.9 + r() * 0.8, i), x, z, r() * 6);
        }
        for (let i = 0; i < 10; i++)
          scene.add(
            m(
              new THREE.IcosahedronGeometry(0.3 + r() * 0.6, 0),
              mat('#ffffff', { map: texture('rock', [16, 16], SURFACES.rock()) }),
              (r() - 0.5) * 20,
              0.2,
              -2 - r() * 15,
            ),
          );
      } else {
        const barn = new THREE.Group();
        barn.add(
          m(
            B(8, 5, 6),
            mat('#ffffff', {
              map: texture('wood:barn', [32, 32], SURFACES.wood('#9a2a22'), [3, 2]),
            }),
            0,
            2.5,
            0,
          ),
        );
        const roof = m(new THREE.CylinderGeometry(3.2, 3.2, 8.2, 3), mat('#4a4a4e'), 0, 5.4, 0);
        roof.rotation.z = Math.PI / 2;
        barn.add(roof, m(B(2.4, 3, 0.1), mat('#f2f0ea'), 0, 1.5, 3.05));
        place(scene, barn, -6, -16, 0.3);
        const wood = mat('#8a6a4a');
        for (let i = -10; i <= 10; i++) scene.add(m(B(0.12, 1, 0.12), wood, i * 1.6, 0.5, -6));
        scene.add(m(B(32, 0.1, 0.06), wood, 0, 0.8, -6), m(B(32, 0.1, 0.06), wood, 0, 0.45, -6));
        for (let i = 0; i < 6; i++)
          scene.add(
            m(
              new THREE.CylinderGeometry(0.6, 0.6, 1.2, 8),
              mat('#d9b85a'),
              6 + i * 2.2,
              0.6,
              -10 - (i % 2) * 2,
            ).rotateZ(Math.PI / 2),
          );
        place(scene, tree(1.2, 4), 10, -20);
      }
      break;
    }
    case 'desert':
    case 'beach': {
      indoor = false;
      sky = skyDome(
        id === 'desert' ? '#4f8fd6' : '#4fa0e0',
        id === 'desert' ? '#f2dcb0' : '#e8f4fa',
        id === 'beach',
      );
      scene.add(sky);
      scene.fog = new THREE.Fog(id === 'desert' ? '#e8d4a8' : '#d8e8f0', 30, 140);
      lights = light(scene, {
        sky: '#fff4dc',
        ground: '#b09060',
        hemi: 1.7,
        sun: '#fff0cc',
        sunI: 2.4,
        dir: [6, 12, 4],
      });
      const geo = new THREE.PlaneGeometry(300, 300, 60, 60);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position!;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i),
          z = pos.getZ(i);
        const far = Math.min(1, Math.max(0, (-z - 8) / 30));
        pos.setY(
          i,
          id === 'desert'
            ? (Math.sin(x * 0.08) * 2 + Math.cos(z * 0.11 + x * 0.03) * 2.4) * far
            : 0,
        );
      }
      geo.computeVertexNormals();
      scene.add(m(geo, surface('sand', SURFACES.sand(), [70, 70])));
      if (id === 'desert') {
        const cactus = mat('#4a7a3a');
        for (let i = 0; i < 8; i++) {
          const g = new THREE.Group();
          g.add(
            m(new THREE.CylinderGeometry(0.25, 0.3, 3, 6), cactus, 0, 1.5, 0),
            m(new THREE.CylinderGeometry(0.15, 0.15, 1, 6), cactus, 0.5, 1.8, 0),
            m(B(0.5, 0.25, 0.25), cactus, 0.25, 1.3, 0),
          );
          place(scene, g, (r() - 0.5) * 40, -6 - r() * 30, r() * 6);
        }
      } else {
        const water = m(
          new THREE.PlaneGeometry(400, 200, 40, 20).rotateX(-Math.PI / 2),
          mat('#ffffff', { map: texture('water', [32, 32], SURFACES.water(), [60, 30]) }),
          0,
          0.05,
          -110,
        );
        water.userData.waves = true;
        scene.add(water);
        const tex = (water.material as THREE.MeshLambertMaterial).map!;
        update = (t) => {
          tex.offset.set(t * 0.02, t * 0.05);
        };
        for (let i = 0; i < 5; i++) {
          const palm = tree(1, 1);
          palm.children.slice(1).forEach((c) => c.scale.set(1.4, 0.35, 1.4));
          place(scene, palm, -14 + i * 7 + r() * 2, -4 - r() * 4, r() * 6);
        }
      }
      break;
    }
    case 'underwater': {
      indoor = false;
      scene.background = new THREE.Color('#0d3a5a');
      scene.fog = new THREE.Fog('#0d3a5a', 3, 28);
      lights = light(scene, {
        sky: '#7fc6e8',
        ground: '#0a2030',
        hemi: 1.4,
        sun: '#bfe8ff',
        sunI: 1.2,
        dir: [0, 10, 3],
      });
      scene.add(floor(200, surface('sand', SURFACES.sand(), [50, 50], '#b9c9c0')));
      for (let i = 0; i < 18; i++) {
        scene.add(
          m(
            new THREE.IcosahedronGeometry(0.4 + r() * 1.2, 0),
            mat('#ffffff', { map: texture('rock', [16, 16], SURFACES.rock()) }),
            (r() - 0.5) * 30,
            0.2,
            -3 - r() * 20,
          ),
        );
        const weed = m(
          new THREE.ConeGeometry(0.15, 1.6 + r() * 2, 3),
          mat('#3a8a4a'),
          (r() - 0.5) * 24,
          0.8,
          -2 - r() * 16,
        );
        scene.add(weed);
      }
      const bubbles = new THREE.Group();
      const bub = flat('#cfeeff', { transparent: true, opacity: 0.6 });
      for (let i = 0; i < 40; i++)
        bubbles.add(
          m(
            new THREE.IcosahedronGeometry(0.04 + r() * 0.05, 0),
            bub,
            (r() - 0.5) * 8,
            r() * 6,
            -r() * 6,
          ),
        );
      scene.add(bubbles);
      for (let i = 0; i < 4; i++) {
        const ray = m(
          new THREE.CylinderGeometry(0.3, 1.4, 14, 5, 1, true),
          flat('#9fdcff', { additive: true, opacity: 0.08 }),
          (r() - 0.5) * 14,
          6,
          -6 - r() * 8,
        );
        ray.rotation.z = 0.3;
        scene.add(ray);
      }
      update = (t) =>
        bubbles.children.forEach((b, i) => (b.position.y = ((i * 0.37 + t * 0.8) % 6) + 0.2));
      break;
    }
    case 'space': {
      indoor = false;
      const stars = texture('stars', [256, 128], SURFACES.stars());
      sky = new THREE.Mesh(
        new THREE.SphereGeometry(180, 16, 10),
        flat('#ffffff', { map: stars, side: THREE.BackSide, fog: false }),
      );
      scene.add(sky);
      lights = light(scene, {
        sky: '#8090b0',
        ground: '#101018',
        hemi: 0.7,
        sun: '#fff4e0',
        sunI: 2.6,
        dir: [-6, 3, 5],
      });
      const earth = makeProp('planet');
      earth.object.scale.setScalar(9);
      place(scene, earth.object, 8, -30, 0, -6);
      update = (t) => earth.update?.(t);
      break;
    }
    case 'sky': {
      indoor = false;
      sky = skyDome('#2f6fc8', '#a9cbe8');
      scene.add(sky);
      scene.fog = new THREE.Fog('#cfe2f2', 60, 320);
      lights = light(scene, {
        sky: '#e8f2ff',
        ground: '#8aa0b0',
        hemi: 1.6,
        sun: '#ffffff',
        sunI: 2,
        dir: [4, 10, 6],
      });
      for (let i = 0; i < 12; i++)
        place(scene, cloud(r), (r() - 0.5) * 120, -40 - r() * 80, 0, -10 + r() * 20);
      const ground = floor(600, surface('grass:far', SURFACES.grass(), [200, 200]), -60);
      scene.add(ground);
      break;
    }
    case 'jungle': {
      day();
      scene.fog = opts.clearing
        ? new THREE.Fog('#9ab08a', 14, 80)
        : new THREE.Fog('#7a9a6a', 6, 45);
      scene.add(floor(300, surface('grass:jungle', SURFACES.leaves('#3a6a2a'), [70, 70])));
      for (let i = 0; i < 46; i++) {
        const a = r() * Math.PI * 2,
          d = 3 + r() * 26;
        const x = Math.cos(a) * d,
          z = -Math.abs(Math.sin(a) * d) + 1.5;
        if ((Math.abs(x) < 1.8 && z > -2.5) || clear(x, z)) continue;
        const t = tree(0.8 + r() * 0.9, i);
        if (i % 3 === 0) t.children.slice(1).forEach((c) => c.scale.set(1.6, 0.35, 1.6));
        place(scene, t, x, z, r() * 6);
      }
      const leaf = mat('#2f6a2a', { side: THREE.DoubleSide });
      for (let i = 0; i < 30; i++) {
        const fern = m(
          new THREE.ConeGeometry(0.5 + r() * 0.4, 0.9, 5, 1, true),
          leaf,
          (r() - 0.5) * 14,
          0.45,
          -1.5 - r() * 8,
        );
        scene.add(fern);
      }
      const vine = mat('#2a4a1e');
      for (let i = 0; i < 12; i++) {
        const x = (r() - 0.5) * 12,
          z = -3 - r() * 8;
        if (!clear(x, z))
          scene.add(m(new THREE.CylinderGeometry(0.02, 0.02, 4 + r() * 3, 3), vine, x, 4, z));
      }
      break;
    }
    case 'island':
    case 'ocean': {
      indoor = false;
      sky = skyDome('#3f8fe0', '#e2f0f8');
      scene.add(sky);
      scene.fog = new THREE.Fog('#d8e8f0', 40, 200);
      lights = light(scene, {
        sky: '#fff4dc',
        ground: '#8ab0c0',
        hemi: 1.6,
        sun: '#fff0cc',
        sunI: 2.3,
        dir: [6, 12, 4],
      });
      const water = m(
        new THREE.PlaneGeometry(500, 500, 50, 50).rotateX(-Math.PI / 2),
        mat('#ffffff', { map: texture('water', [32, 32], SURFACES.water(), [90, 90]) }),
        0,
        id === 'ocean' ? 0 : -0.25,
        0,
      );
      water.userData.waves = true;
      scene.add(water);
      const tex = (water.material as THREE.MeshLambertMaterial).map!;
      update = (t) => tex.offset.set(t * 0.02, t * 0.04);
      if (id === 'island') {
        const sandGeo = new THREE.CylinderGeometry(14, 18, 1, 16, 1);
        scene.add(m(sandGeo, surface('sand', SURFACES.sand(), [8, 2]), 0, -0.5, -4));
        for (let i = 0; i < 9; i++) {
          const palm = tree(1 + r() * 0.4, 1);
          palm.children.slice(1).forEach((c) => c.scale.set(1.5, 0.35, 1.5));
          const a = r() * Math.PI - Math.PI;
          if (clear(Math.cos(a) * 8, -4 + Math.sin(a) * 8)) continue;
          place(
            scene,
            palm,
            Math.cos(a) * (5 + r() * 6),
            -4 + Math.sin(a) * (5 + r() * 5),
            r() * 6,
          );
        }
        for (let i = 0; i < 6; i++) {
          const x = (r() - 0.5) * 16,
            z = -12 - r() * 4;
          if (!clear(x, z)) place(scene, tree(1.3, i), x, z);
        }
      } else {
        const boat = makeProp('boat').object;
        place(scene, boat, 0, -1.5, 0.2, 0);
        const f = makeProp('boat');
        place(scene, f.object, -14, -40, 1);
      }
      break;
    }
    case 'battlefield': {
      indoor = false;
      sky = skyDome('#6a6a6a', '#b9b2a0');
      scene.add(sky);
      scene.fog = new THREE.Fog('#a8a090', 12, 70);
      lights = light(scene, {
        sky: '#d8d0c0',
        ground: '#4a4030',
        hemi: 1.3,
        sun: '#e8dcc0',
        sunI: 1.4,
        dir: [4, 9, 6],
      });
      scene.add(
        floor(
          300,
          surface(
            'mud',
            (g, w, h, rr) => {
              for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                  g.fillStyle = rr() > 0.5 ? '#5a4a34' : '#6a5a40';
                  g.fillRect(x, y, 1, 1);
                }
            },
            [70, 70],
          ),
        ),
      );
      const sack = mat('#a8925a');
      for (let i = -4; i <= 4; i++)
        for (let k = 0; k < 2; k++)
          scene.add(m(B(0.9, 0.35, 0.5), sack, i * 0.95 + (k ? 0.45 : 0), 0.18 + k * 0.35, -3));
      const wire = mat('#3a3a3a');
      for (let i = -8; i <= 8; i++) {
        const post = m(B(0.08, 1.1, 0.08), mat('#4a3a2a'), i * 2.2, 0.55, -9);
        post.rotation.z = (r() - 0.5) * 0.3;
        scene.add(
          post,
          m(B(2.2, 0.02, 0.02), wire, i * 2.2 + 1.1, 0.8, -9),
          m(B(2.2, 0.02, 0.02), wire, i * 2.2 + 1.1, 0.45, -9),
        );
      }
      for (let i = 0; i < 8; i++)
        scene.add(
          m(
            new THREE.TorusGeometry(1 + r(), 0.25, 3, 8).rotateX(Math.PI / 2),
            mat('#4a3a28'),
            (r() - 0.5) * 30,
            0.05,
            -6 - r() * 25,
          ),
        );
      for (let i = 0; i < 5; i++) {
        const smoke = m(
          new THREE.IcosahedronGeometry(2 + r() * 2, 0),
          flat('#8a8580', { transparent: true, opacity: 0.35 }),
          (r() - 0.5) * 40,
          2 + r() * 4,
          -20 - r() * 20,
        );
        scene.add(smoke);
      }
      for (let i = 0; i < 4; i++)
        place(scene, tree(0.9, 0), (r() - 0.5) * 30, -15 - r() * 15)
          .children.slice(1)
          .forEach((c) => (c.visible = false));
      break;
    }
    case 'snow': {
      indoor = false;
      sky = skyDome('#8fa8c8', '#e8eef4');
      scene.add(sky);
      scene.fog = new THREE.Fog('#dfe6ee', 10, 80);
      lights = light(scene, {
        sky: '#f0f4ff',
        ground: '#c8d0dc',
        hemi: 1.7,
        sun: '#ffffff',
        sunI: 1.6,
        dir: [4, 9, 6],
      });
      scene.add(
        floor(
          300,
          surface('snow', (g, w, h, rr) => noise(g, w, h, rr, '#eef2f6', 0.05), [60, 60]),
        ),
      );
      const pine = mat('#2f4a3a');
      const snowCap = mat('#f2f5f8');
      for (let i = 0; i < 30; i++) {
        const g = new THREE.Group();
        g.add(m(new THREE.CylinderGeometry(0.12, 0.16, 1, 5), mat('#4a3424'), 0, 0.5, 0));
        for (let k = 0; k < 3; k++)
          g.add(
            m(
              new THREE.ConeGeometry(1.2 - k * 0.3, 1.4, 6),
              k === 2 ? snowCap : pine,
              0,
              1.2 + k * 0.8,
              0,
            ),
          );
        const a = r() * Math.PI,
          d = 5 + r() * 30;
        place(scene, g, Math.cos(a) * d * (r() > 0.5 ? 1 : -1), -Math.sin(a) * d - 2, 0);
      }
      for (let i = 0; i < 3; i++) {
        const mtn = m(new THREE.ConeGeometry(18, 24, 6), mat('#9aa6b4'), -40 + i * 40, 12, -90);
        scene.add(mtn, m(new THREE.ConeGeometry(7, 9, 6), snowCap, -40 + i * 40, 19.5, -90));
      }
      const flakes = new THREE.Group();
      const flake = flat('#ffffff');
      for (let i = 0; i < 200; i++) {
        const f = m(B(0.03, 0.03, 0.03), flake);
        f.userData = { x: (r() - 0.5) * 12, z: (r() - 0.5) * 10, o: r() * 6 };
        flakes.add(f);
      }
      scene.add(flakes);
      update = (t) =>
        flakes.children.forEach((f) =>
          f.position.set(
            f.userData.x + Math.sin(t + f.userData.o) * 0.2,
            6 - ((t * 0.8 + f.userData.o) % 6),
            f.userData.z,
          ),
        );
      break;
    }
    case 'courtroom': {
      const wood = surface('wood:court', SURFACES.wood('#6a3a22'), [6, 6]);
      const lamp = room(scene, {
        floor: surface('wood:courtfloor', SURFACES.wood('#8a5a34'), [10, 10]),
        wall: surface('wallpaper:court', SURFACES.wallpaper('#b8a07a'), [6, 2]),
        window: false,
      });
      indoorLights(lamp);
      scene.add(
        m(B(4, 1.4, 1), wood, 0, 0.7, -3.3),
        m(B(4.2, 0.08, 1.1), mat('#4a2a1a'), 0, 1.42, -3.3),
      );
      scene.add(m(B(0.8, 1.6, 0.08), mat('#c9a23a'), 0, 2.2, -3.85));
      for (let i = 0; i < 3; i++)
        scene.add(
          m(B(3, 0.45, 0.6), wood, (i - 1) * 0.1, 0.3, 1.8 + i * 1.2),
          m(B(3, 0.8, 0.08), wood, 0, 0.7, 2.1 + i * 1.2),
        );
      break;
    }
    case 'void': {
      indoor = false;
      sky = skyDome('#2a2f45', '#6a7090', false);
      scene.add(sky);
      lights = light(scene, {
        sky: '#e8ecff',
        ground: '#40445a',
        hemi: 1.6,
        sun: '#ffffff',
        sunI: 1.6,
        dir: [3, 8, 6],
      });
      const grid = texture(
        'grid',
        [32, 32],
        (g, w, h) => {
          g.fillStyle = '#3a3f58';
          g.fillRect(0, 0, w, h);
          g.fillStyle = '#6a7090';
          g.fillRect(0, 0, w, 1);
          g.fillRect(0, 0, 1, h);
        },
        [40, 40],
      );
      scene.add(floor(120, mat('#ffffff', { map: grid })));
      scene.fog = new THREE.Fog('#4a5070', 12, 60);
      tableTop = 0;
      break;
    }
  }
  if (!lights.length)
    lights = light(scene, {
      sky: '#ffffff',
      ground: '#888888',
      hemi: 1.4,
      sun: '#ffffff',
      sunI: 1.5,
      dir: [3, 8, 5],
    });
  void shade;
  const life = addLife(scene, id, rng(seed * 13 + 5), sky);
  const own = update;
  return {
    scene,
    indoor,
    tableTop: indoor ? tableTop : 0,
    update: (t: number) => {
      own?.(t);
      life(t);
    },
    lights,
    sky,
  };
}
