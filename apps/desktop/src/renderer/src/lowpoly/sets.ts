// Sets for the low-poly kit (ADR-054). The subject stands at the origin facing +z, the camera
// is usually on the +z side, so each set dresses the space behind and beside the origin. Every
// set is seeded, so the same shot always looks the same.
import * as THREE from 'three';
import type { SetId } from '@rec-it/lowpoly';
import { flat, mat } from './ps1';
import { cloud, house, makeProp, tree } from './props';
import { rng, shade, SURFACES, texture, type Paint } from './textures';

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
  },
) {
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
    const view = texture('window:view', [32, 32], SURFACES.sky('#6fa8dc', '#dfeaf2'));
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

export function buildSet(id: SetId, seed: number): BuiltSet {
  const scene = new THREE.Scene();
  const r = rng(seed * 7 + 3);
  let indoor = true;
  let tableTop = 0.78;
  let update: ((t: number) => void) | undefined;
  let lights: THREE.Light[] = [];
  let sky: THREE.Object3D | null = null;
  const day = () => {
    indoor = false;
    sky = skyDome('#5f97d6', '#dce8f2');
    scene.add(sky);
    scene.fog = new THREE.Fog('#cfdbe6', 25, 120);
    lights = light(scene, {
      sky: '#dfeeff',
      ground: '#6a6a50',
      hemi: 1.6,
      sun: '#fff1d6',
      sunI: 2.2,
      dir: [5, 10, 6],
    });
  };
  const indoorLights = (extra: THREE.Light) => {
    scene.fog = new THREE.Fog('#2a2a2a', 12, 30);
    lights = [
      ...light(scene, {
        sky: '#fff6ea',
        ground: '#6a5a4a',
        hemi: 1.4,
        sun: '#fff1d6',
        sunI: 1.2,
        dir: [3, 6, 8],
      }),
      extra,
    ];
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
      const walls = ['#d9d2c0', '#c9b9a0', '#b9c4c9', '#e2d6b8'];
      const roofs = ['#5a3b32', '#3f4a5a', '#6a4030'];
      for (let i = -3; i <= 3; i++) {
        place(
          scene,
          house(walls[(i + 9) % 4]!, roofs[(i + 9) % 3]!),
          i * 12 + (r() - 0.5) * 2,
          -14,
          0,
        );
        place(scene, tree(0.9 + r() * 0.4, i + 5), i * 12 + 6, -9 + (r() - 0.5) * 2);
      }
      for (let i = -3; i <= 3; i++) {
        const pole = m(
          new THREE.CylinderGeometry(0.06, 0.08, 4.5, 5),
          mat('#5a5a5a'),
          i * 14 + 5,
          2.25,
          -0.4,
        );
        scene.add(pole, m(B(0.8, 0.12, 0.3), mat('#d9d9d0'), i * 14 + 5.3, 4.4, -0.4));
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
      const lamp = room(scene, { floor: fl, wall: wl, window: id !== 'prison' && id !== 'bank' });
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
        place(scene, makeProp('bed').object, -1.8, -2.8);
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
          if (Math.abs(x) < 2 && z > -3) continue;
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
  return {
    scene,
    indoor,
    tableTop: indoor ? tableTop : 0,
    ...(update ? { update } : {}),
    lights,
    sky,
  };
}
