// Props for the low-poly kit (ADR-054): a few boxes, cylinders and low icosahedra each, with
// painted textures. Each says how it is placed: held in the hand, standing on the ground, or
// floating beside the subject (organs, planets, atoms: the "diagram" things).
import * as THREE from 'three';
import type { PropId } from '@rec-it/lowpoly';
import { flat, mat } from './ps1';
import { noise, shade, SURFACES, texture } from './textures';

export type Placement = 'hand' | 'ground' | 'float' | 'big';

export interface Prop {
  object: THREE.Object3D;
  placement: Placement;
  /** Rough size (metres) for framing a close-up of it. */
  size: number;
  update?: (t: number) => void;
}

function m(geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, y, z);
  return mesh;
}
const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const C = (rt: number, rb: number, h: number, seg = 8) =>
  new THREE.CylinderGeometry(rt, rb, h, seg);
const I = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);

function sized(mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh {
  mesh.scale.set(x, y, z);
  return mesh;
}

function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.add(...children);
  return g;
}

function screen(colour: string) {
  return mat('#ffffff', {
    map: texture(`screen:${colour}`, [32, 24], SURFACES.screen(colour)),
    emissive: '#ffffff',
    emissiveIntensity: 0.35,
  });
}

/** A sign with words on it (bigText). */
export function sign(text: string, w = 1.6, h = 0.6): THREE.Object3D {
  const t = texture(`sign:${text}`, [128, 48], (g) => {
    g.fillStyle = '#f2ecd8';
    g.fillRect(0, 0, 128, 48);
    g.strokeStyle = '#3a2a1a';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, 125, 45);
    g.fillStyle = '#1c1612';
    g.font = 'bold 26px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text.toUpperCase().slice(0, 12), 64, 26, 120);
  });
  return group(
    m(B(w, h, 0.05), mat('#ffffff', { map: t }), 0, 1.6),
    m(B(0.06, 1.4, 0.06), mat('#6b4a2f'), 0, 0.7, -0.04),
  );
}

export function animal(kind: 'dog' | 'cat' | 'cow' | 'rat' | 'bird' | 'fish'): Prop {
  const furs = {
    dog: '#9a6a3a',
    cat: '#7a7672',
    cow: '#ece8df',
    rat: '#8a8580',
    bird: '#4a6fa5',
    fish: '#d9a03a',
  };
  const scale = { dog: 1, cat: 0.6, cow: 2.2, rat: 0.3, bird: 0.35, fish: 0.5 }[kind];
  const fur = mat('#ffffff', {
    map: texture(
      `fur:${kind}`,
      [16, 16],
      kind === 'cow' ? SURFACES.cowHide() : SURFACES.fur(furs[kind]),
    ),
  });
  const dark = mat(shade(furs[kind], -0.5));
  const eye = flat('#111111');
  const g = new THREE.Group();
  if (kind === 'fish') {
    g.add(sized(m(I(0.5, 0), fur), 1, 0.7, 0.3));
    const tail = m(new THREE.ConeGeometry(0.3, 0.4, 3), fur, -0.6, 0, 0);
    tail.rotation.z = Math.PI / 2;
    g.add(tail, m(B(0.06, 0.06, 0.32), eye, 0.32, 0.08, 0));
  } else if (kind === 'bird') {
    g.add(sized(m(I(0.4, 0), fur), 1.2, 0.9, 0.9), m(I(0.28, 0), fur, 0.45, 0.35, 0));
    const beak = m(new THREE.ConeGeometry(0.08, 0.25, 4), mat('#e0a030'), 0.75, 0.33, 0);
    beak.rotation.z = -Math.PI / 2;
    g.add(beak, m(B(0.05, 0.05, 0.5), eye, 0.6, 0.42, 0));
    g.add(m(B(0.6, 0.06, 0.3), fur, -0.1, 0.15, 0.4), m(B(0.6, 0.06, 0.3), fur, -0.1, 0.15, -0.4));
  } else {
    const long = kind === 'cow' ? 1.0 : kind === 'rat' ? 1.3 : 1.1;
    g.add(m(B(long, 0.5, 0.45), fur, 0, 0.75, 0));
    g.add(m(B(0.4, 0.38, 0.36), fur, long / 2 + 0.15, 0.98, 0));
    g.add(m(B(0.18, 0.16, 0.26), dark, long / 2 + 0.38, 0.92, 0));
    g.add(m(B(0.05, 0.06, 0.38), eye, long / 2 + 0.36, 1.06, 0));
    for (const [x, z] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ] as const)
      g.add(m(B(0.12, 0.5, 0.12), fur, x * (long / 2 - 0.1), 0.25, z * 0.15));
    if (kind === 'cat' || kind === 'rat' || kind === 'dog') {
      const tail = m(
        B(0.06, 0.06, kind === 'rat' ? 0.9 : 0.5),
        kind === 'rat' ? mat('#d9a0a0') : fur,
        -long / 2 - 0.2,
        0.9,
        0,
      );
      tail.rotation.y = Math.PI / 2;
      tail.rotation.x = 0.4;
      g.add(tail);
    }
    if (kind === 'cat' || kind === 'dog' || kind === 'rat') {
      const ear = (z: number) =>
        m(new THREE.ConeGeometry(0.08, 0.16, 4), fur, long / 2 + 0.12, 1.22, z);
      g.add(ear(-0.12), ear(0.12));
    }
    if (kind === 'cow') {
      g.add(
        m(C(0.03, 0.04, 0.18, 4), mat('#e8e0c8'), long / 2 + 0.15, 1.22, -0.16),
        m(C(0.03, 0.04, 0.18, 4), mat('#e8e0c8'), long / 2 + 0.15, 1.22, 0.16),
      );
      g.add(m(B(0.2, 0.12, 0.2), mat('#e3a3a0'), 0, 0.45, 0));
    }
  }
  g.scale.setScalar(scale);
  g.rotation.y = -Math.PI / 2;
  return {
    object: group(g),
    placement: kind === 'fish' || kind === 'bird' ? 'float' : 'ground',
    size: 1.4 * scale,
  };
}

/** Builds a prop. `text` is used by signs. */
export function makeProp(id: PropId, text = ''): Prop {
  switch (id) {
    case 'phone':
      return {
        object: group(
          m(B(0.08, 0.16, 0.012), mat('#18191c')),
          m(B(0.07, 0.14, 0.002), screen('#4a90d9'), 0, 0, 0.007),
        ),
        placement: 'hand',
        size: 0.25,
      };
    case 'money': {
      const bill = mat('#ffffff', { map: texture('money', [32, 16], SURFACES.money()) });
      const g = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const b = m(B(0.16, 0.012, 0.07), bill, (i % 2) * 0.02, i * 0.013, 0);
        b.rotation.y = i * 0.2;
        g.add(b);
      }
      return { object: g, placement: 'hand', size: 0.3 };
    }
    case 'cup':
      return {
        object: group(
          m(C(0.045, 0.038, 0.11, 8), mat('#e8e2d6')),
          m(C(0.04, 0.04, 0.005, 8), mat('#5a3a20'), 0, 0.054, 0),
        ),
        placement: 'hand',
        size: 0.2,
      };
    case 'pill':
      return {
        object: group(
          m(B(0.05, 0.02, 0.02), mat('#d94a4a')),
          m(B(0.05, 0.02, 0.02), mat('#f2f0ea'), 0.045, 0, 0),
        ),
        placement: 'hand',
        size: 0.12,
      };
    case 'syringe': {
      const g = group(
        m(C(0.012, 0.012, 0.16, 6), mat('#e6f0f5', { transparent: true, opacity: 0.7 })),
        m(C(0.002, 0.002, 0.07, 4), mat('#c0c4c8'), 0, -0.11, 0),
        m(C(0.02, 0.02, 0.01, 6), mat('#d0d4d8'), 0, 0.09, 0),
      );
      return { object: g, placement: 'hand', size: 0.25 };
    }
    case 'glasses': {
      const frame = mat('#161616');
      return {
        object: group(
          m(B(0.07, 0.04, 0.01), frame, -0.045, 0, 0),
          m(B(0.07, 0.04, 0.01), frame, 0.045, 0, 0),
          m(B(0.03, 0.008, 0.01), frame),
        ),
        placement: 'hand',
        size: 0.15,
      };
    }
    case 'clock': {
      const face = texture('clock', [32, 32], (g) => {
        g.fillStyle = '#f2eee2';
        g.fillRect(0, 0, 32, 32);
        g.fillStyle = '#1c1c1c';
        for (let i = 0; i < 12; i++)
          g.fillRect(
            15 + Math.round(Math.sin((i / 12) * 6.28) * 12),
            15 - Math.round(Math.cos((i / 12) * 6.28) * 12),
            2,
            2,
          );
      });
      const hand = m(B(0.02, 0.2, 0.01), mat('#111111'), 0, 0.08, 0.06);
      const g = group(
        m(C(0.25, 0.25, 0.08, 12), mat('#8a1f24')).rotateX(Math.PI / 2),
        m(C(0.22, 0.22, 0.09, 12), mat('#ffffff', { map: face })).rotateX(Math.PI / 2),
        hand,
      );
      return {
        object: g,
        placement: 'float',
        size: 0.6,
        update: (t) => {
          hand.rotation.z = -t * 3;
        },
      };
    }
    case 'lightbulb': {
      const glass = mat('#fff3b0', { emissive: '#ffe066', emissiveIntensity: 1.2 });
      return {
        object: group(
          m(I(0.12, 1), glass, 0, 0.12, 0),
          m(C(0.05, 0.05, 0.08, 8), mat('#9a9a9a'), 0, -0.02, 0),
        ),
        placement: 'float',
        size: 0.35,
      };
    }
    case 'laser': {
      const beam = m(C(0.008, 0.008, 6, 4), flat('#ff2020', { additive: true }), 0, 0, 3);
      beam.rotation.x = Math.PI / 2;
      return {
        object: group(m(C(0.02, 0.02, 0.15, 6), mat('#2a2a2e')).rotateX(Math.PI / 2), beam),
        placement: 'hand',
        size: 0.3,
      };
    }
    case 'book': {
      const cover = mat('#7a2a2a');
      return {
        object: group(
          m(B(0.16, 0.22, 0.04), cover),
          m(B(0.15, 0.21, 0.035), mat('#efe9d8'), 0.008, 0, 0),
        ),
        placement: 'hand',
        size: 0.3,
      };
    }
    case 'briefcase':
      return {
        object: group(
          m(B(0.45, 0.32, 0.12), mat('#2a2522')),
          m(B(0.12, 0.04, 0.03), mat('#8a8a8a'), 0, 0.18, 0),
        ),
        placement: 'hand',
        size: 0.5,
      };
    case 'computer':
      return {
        object: group(
          m(B(0.5, 0.35, 0.05), mat('#d9d6cf'), 0, 0.45, 0),
          m(B(0.44, 0.29, 0.01), screen('#2f7bd0'), 0, 0.45, 0.03),
          m(B(0.08, 0.2, 0.08), mat('#c9c6bf'), 0, 0.18, 0),
          m(B(0.45, 0.02, 0.15), mat('#c9c6bf'), 0, 0.01, 0.2),
        ),
        placement: 'ground',
        size: 0.7,
      };
    case 'tv':
      return {
        object: group(
          m(B(1.2, 0.72, 0.08), mat('#151515'), 0, 1.1, 0),
          m(B(1.1, 0.62, 0.01), screen('#3a8a5a'), 0, 1.1, 0.045),
          m(B(1.0, 0.7, 0.4), mat('#6b4a2f'), 0, 0.35, 0),
        ),
        placement: 'ground',
        size: 1.5,
      };
    case 'car': {
      const paint = mat('#a3342a');
      const glass = mat('#ffffff', { map: texture('glass', [16, 16], SURFACES.glass()) });
      const g = group(
        m(B(1.8, 0.6, 4), paint, 0, 0.55, 0),
        m(B(1.6, 0.55, 2), glass, 0, 1.1, -0.2),
        m(B(1.62, 0.06, 2.02), paint, 0, 1.39, -0.2),
      );
      for (const [x, z] of [
        [-0.9, 1.3],
        [0.9, 1.3],
        [-0.9, -1.3],
        [0.9, -1.3],
      ] as const) {
        const w = m(C(0.33, 0.33, 0.22, 8), mat('#1a1a1a'), x, 0.33, z);
        w.rotation.z = Math.PI / 2;
        g.add(w);
      }
      g.add(
        m(B(0.3, 0.12, 0.02), flat('#fff2c0'), -0.6, 0.65, 2.01),
        m(B(0.3, 0.12, 0.02), flat('#fff2c0'), 0.6, 0.65, 2.01),
      );
      return { object: g, placement: 'big', size: 4 };
    }
    case 'plane': {
      const body = mat('#e8e8ea');
      const g = group(
        m(C(1.2, 1.2, 14, 8), body).rotateX(Math.PI / 2),
        m(B(16, 0.25, 2.8), body, 0, -0.3, 0.5),
        m(B(5, 0.2, 1.4), body, 0, 0.4, -6.2),
        m(B(0.2, 2.4, 1.6), mat('#2f5aa0'), 0, 1.6, -6.4),
      );
      const nose = m(new THREE.ConeGeometry(1.2, 2, 8), body, 0, 0, 8);
      nose.rotation.x = Math.PI / 2;
      g.add(nose, m(B(2.45, 0.35, 10), mat('#2f5aa0'), 0, 0.2, 0));
      for (let i = 0; i < 10; i++)
        g.add(m(B(2.46, 0.22, 0.3), flat('#1b2b44'), 0, 0.55, -4 + i * 0.9));
      return { object: g, placement: 'big', size: 16 };
    }
    case 'rocket': {
      const flameMat = flat('#ffb030', { additive: true });
      const flame = m(new THREE.ConeGeometry(0.4, 1.6, 6), flameMat, 0, -0.9, 0);
      flame.rotation.x = Math.PI;
      const g = group(
        m(C(0.5, 0.5, 4, 8), mat('#eeeeee'), 0, 2, 0),
        m(new THREE.ConeGeometry(0.5, 1.2, 8), mat('#c0302a'), 0, 4.6, 0),
        m(B(1.6, 0.8, 0.08), mat('#c0302a'), 0, 0.4, 0),
        m(B(0.08, 0.8, 1.6), mat('#c0302a'), 0, 0.4, 0),
        flame,
      );
      return {
        object: g,
        placement: 'big',
        size: 5,
        update: (t) => flame.scale.set(1, 0.8 + Math.sin(t * 40) * 0.2, 1),
      };
    }
    case 'house':
      return { object: house('#d9d2c0', '#5a3b32'), placement: 'big', size: 7 };
    case 'tree':
      return { object: tree(1), placement: 'big', size: 5 };
    case 'toilet': {
      const p = mat('#f2f2ee', { flat: false });
      return {
        object: group(
          m(C(0.22, 0.18, 0.4, 8), p, 0, 0.2, 0.05),
          m(B(0.4, 0.4, 0.18), p, 0, 0.55, -0.2),
          m(C(0.24, 0.24, 0.04, 8), p, 0, 0.42, 0.05),
        ),
        placement: 'ground',
        size: 0.9,
      };
    }
    case 'fridge':
      return {
        object: group(
          m(B(0.8, 1.8, 0.7), mat('#e9e9e6'), 0, 0.9, 0),
          m(B(0.04, 0.4, 0.04), mat('#9a9a9a'), -0.3, 1.2, 0.37),
          m(B(0.8, 0.01, 0.71), mat('#9a9a9a'), 0, 1.2, 0),
        ),
        placement: 'ground',
        size: 2,
      };
    case 'bed': {
      const sheet = mat('#e8e4f0');
      return {
        object: group(
          m(B(1.2, 0.4, 2.1), mat('#6b4a2f'), 0, 0.2, 0),
          m(B(1.15, 0.15, 2.0), sheet, 0, 0.47, 0),
          m(B(0.8, 0.1, 0.35), mat('#ffffff'), 0, 0.58, -0.75),
          m(B(1.17, 0.12, 1.2), mat('#5a7ab0'), 0, 0.52, 0.35),
          m(B(1.2, 0.8, 0.08), mat('#6b4a2f'), 0, 0.6, -1.05),
        ),
        placement: 'ground',
        size: 2.2,
      };
    }
    case 'chair':
      return {
        object: group(
          m(B(0.48, 0.05, 0.48), mat('#7a5232'), 0, 0.46, 0),
          m(B(0.48, 0.5, 0.05), mat('#7a5232'), 0, 0.72, -0.22),
          ...[-0.2, 0.2].flatMap((x) => [
            m(B(0.05, 0.46, 0.05), mat('#5a3a22'), x, 0.23, -0.2),
            m(B(0.05, 0.46, 0.05), mat('#5a3a22'), x, 0.23, 0.2),
          ]),
        ),
        placement: 'ground',
        size: 1,
      };
    case 'table': {
      const wood = mat('#ffffff', {
        map: texture('wood:table', [32, 32], SURFACES.wood('#8a5a34')),
      });
      return {
        object: group(
          m(B(1.4, 0.06, 0.9), wood, 0, 0.75, 0),
          ...[-0.6, 0.6].flatMap((x) => [
            m(B(0.06, 0.72, 0.06), wood, x, 0.36, -0.38),
            m(B(0.06, 0.72, 0.06), wood, x, 0.36, 0.38),
          ]),
        ),
        placement: 'ground',
        size: 1.5,
      };
    }
    case 'door':
      return {
        object: group(
          m(
            B(1.0, 2.1, 0.08),
            mat('#ffffff', { map: texture('wood:door', [32, 64], SURFACES.wood('#7a4a2a')) }),
            0,
            1.05,
            0,
          ),
          m(I(0.04, 0), mat('#d9b53a'), 0.4, 1.0, 0.06),
        ),
        placement: 'ground',
        size: 2.2,
      };
    case 'sign':
      return { object: sign(text || '!'), placement: 'ground', size: 2 };
    case 'brain': {
      const tex = texture('brain', [32, 32], (g, w, h, r) => {
        noise(g, w, h, r, '#e3a0a6', 0.08);
        g.strokeStyle = '#b8707a';
        for (let i = 0; i < 14; i++) {
          g.beginPath();
          g.moveTo(r() * w, r() * h);
          g.bezierCurveTo(r() * w, r() * h, r() * w, r() * h, r() * w, r() * h);
          g.stroke();
        }
      });
      const pink = mat('#ffffff', { map: tex });
      const g = group(
        sized(m(I(0.28, 1), pink, -0.14, 0, 0), 1, 0.8, 1.3),
        sized(m(I(0.28, 1), pink, 0.14, 0, 0), 1, 0.8, 1.3),
        m(C(0.06, 0.04, 0.25, 6), pink, 0, -0.25, -0.05),
      );
      return {
        object: g,
        placement: 'float',
        size: 0.8,
        update: (t) => {
          g.rotation.y = t * 0.6;
        },
      };
    }
    case 'heart': {
      const red = mat('#ffffff', {
        map: texture('flesh:heart', [32, 32], SURFACES.flesh('#b8323a')),
      });
      const g = group(
        m(I(0.2, 0), red, -0.1, 0.06, 0),
        m(I(0.2, 0), red, 0.1, 0.06, 0),
        m(new THREE.ConeGeometry(0.27, 0.4, 6), red, 0, -0.17, 0).rotateX(Math.PI),
        m(C(0.05, 0.05, 0.2, 6), mat('#8a3a8a'), 0.05, 0.3, 0),
      );
      return {
        object: g,
        placement: 'float',
        size: 0.7,
        update: (t) => g.scale.setScalar(1 + Math.max(0, Math.sin(t * 7)) * 0.08),
      };
    }
    case 'eye': {
      const tex = texture('eyeball', [32, 32], (g) => {
        g.fillStyle = '#f2eee6';
        g.fillRect(0, 0, 32, 32);
        g.fillStyle = '#3f6f9a';
        g.beginPath();
        g.arc(24, 16, 6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#080808';
        g.beginPath();
        g.arc(24, 16, 3, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#c84040';
        for (let i = 0; i < 6; i++) {
          g.beginPath();
          g.moveTo(2, 4 + i * 5);
          g.lineTo(14, 10 + i * 2);
          g.stroke();
        }
      });
      const ball = m(
        new THREE.SphereGeometry(0.3, 10, 8),
        mat('#ffffff', { map: tex, flat: false }),
      );
      ball.rotation.y = -Math.PI / 2;
      return {
        object: group(ball),
        placement: 'float',
        size: 0.7,
        update: (t) => {
          ball.rotation.x = Math.sin(t * 1.4) * 0.3;
        },
      };
    }
    case 'skull': {
      const bone = mat('#e8e2d0');
      return {
        object: group(
          m(I(0.2, 1), bone, 0, 0.05, 0),
          m(B(0.2, 0.12, 0.18), bone, 0, -0.12, 0.04),
          m(B(0.06, 0.06, 0.02), flat('#111111'), -0.07, 0.04, 0.19),
          m(B(0.06, 0.06, 0.02), flat('#111111'), 0.07, 0.04, 0.19),
        ),
        placement: 'float',
        size: 0.6,
      };
    }
    case 'dna': {
      const g = new THREE.Group();
      for (let i = 0; i < 14; i++) {
        const a = i * 0.55;
        const y = i * 0.1 - 0.7;
        g.add(
          m(
            I(0.05, 0),
            mat('#3a7ad9', { emissive: '#1a3a7a' }),
            Math.cos(a) * 0.25,
            y,
            Math.sin(a) * 0.25,
          ),
          m(
            I(0.05, 0),
            mat('#d94a8a', { emissive: '#7a1a3a' }),
            -Math.cos(a) * 0.25,
            y,
            -Math.sin(a) * 0.25,
          ),
        );
        const rung = m(B(0.5, 0.02, 0.02), mat('#e8e8e8'), 0, y, 0);
        rung.rotation.y = -a;
        g.add(rung);
      }
      return {
        object: g,
        placement: 'float',
        size: 1.6,
        update: (t) => {
          g.rotation.y = t * 0.9;
        },
      };
    }
    case 'virus': {
      const g = group(m(I(0.25, 0), mat('#6ab04a', { emissive: '#1a3a10' })));
      const spikes = new THREE.IcosahedronGeometry(0.25, 0).attributes.position!;
      for (let i = 0; i < spikes.count; i += 3) {
        const v = new THREE.Vector3().fromBufferAttribute(spikes, i).normalize();
        const s = m(B(0.04, 0.04, 0.16), mat('#d94a4a'), v.x * 0.3, v.y * 0.3, v.z * 0.3);
        s.lookAt(v.multiplyScalar(2));
        g.add(s);
      }
      return {
        object: g,
        placement: 'float',
        size: 0.8,
        update: (t) => {
          g.rotation.set(t * 0.4, t * 0.7, 0);
        },
      };
    }
    case 'atom': {
      const g = group(m(I(0.12, 0), mat('#d94a4a', { emissive: '#5a1010' })));
      const electrons: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const ring = m(
          new THREE.TorusGeometry(0.4, 0.008, 4, 24),
          flat('#9fd0ff', { additive: true }),
        );
        ring.rotation.set(i * 1.05, i * 0.6, 0);
        const e = m(I(0.04, 0), flat('#bfe0ff'));
        ring.add(e);
        electrons.push(e);
        g.add(ring);
      }
      return {
        object: g,
        placement: 'float',
        size: 1,
        update: (t) =>
          electrons.forEach((e, i) =>
            e.position.set(Math.cos(t * 3 + i * 2) * 0.4, Math.sin(t * 3 + i * 2) * 0.4, 0),
          ),
      };
    }
    case 'planet': {
      const s = m(
        new THREE.SphereGeometry(1, 16, 12),
        mat('#ffffff', { map: texture('earth', [128, 64], SURFACES.earth()), flat: false }),
      );
      return {
        object: group(s),
        placement: 'float',
        size: 2.4,
        update: (t) => {
          s.rotation.y = t * 0.15;
        },
      };
    }
    case 'sun':
      return {
        object: group(
          m(I(1, 1), flat('#ffffff', { map: texture('sun', [32, 32], SURFACES.sun()) })),
          m(I(1.35, 1), flat('#ff9a20', { additive: true, opacity: 0.35 })),
        ),
        placement: 'float',
        size: 3,
      };
    case 'moon': {
      const s = m(I(0.8, 1), mat('#ffffff', { map: texture('moon', [32, 32], SURFACES.moon()) }));
      return {
        object: group(s),
        placement: 'float',
        size: 2,
        update: (t) => {
          s.rotation.y = t * 0.1;
        },
      };
    }
    case 'dog':
    case 'cat':
    case 'cow':
    case 'fish':
    case 'bird':
    case 'rat':
      return animal(id);
    case 'box':
      return {
        object: group(
          m(
            B(0.6, 0.45, 0.45),
            mat('#ffffff', {
              map: texture('cardboard', [16, 16], (g, w, h, r) => {
                noise(g, w, h, r, '#b88a5a', 0.08);
                g.fillStyle = '#d9c9a0';
                g.fillRect(0, 7, w, 2);
              }),
            }),
            0,
            0.23,
            0,
          ),
        ),
        placement: 'ground',
        size: 0.8,
      };
    case 'trophy': {
      const gold = mat('#d9b53a', { emissive: '#5a4210' });
      return {
        object: group(
          m(C(0.18, 0.08, 0.25, 8), gold, 0, 0.32, 0),
          m(C(0.04, 0.04, 0.12, 6), gold, 0, 0.14, 0),
          m(B(0.2, 0.06, 0.2), mat('#3a2a1a'), 0, 0.04, 0),
        ),
        placement: 'hand',
        size: 0.5,
      };
    }
  }
}

// ---- Scenery shared by sets and props ----------------------------------------------------------

export function tree(scale = 1, seed = 1): THREE.Group {
  const bark = mat('#ffffff', { map: texture('bark', [16, 32], SURFACES.bark()) });
  const leaves = mat('#ffffff', {
    map: texture(
      `leaves:${seed % 3}`,
      [32, 32],
      SURFACES.leaves(['#3f7a32', '#4a8a3a', '#356a2c'][seed % 3]),
    ),
  });
  const g = group(m(C(0.14, 0.22, 2.2, 6), bark, 0, 1.1, 0));
  for (let i = 0; i < 3; i++) {
    const blob = m(
      I(1.1 - i * 0.2, 0),
      leaves,
      (i - 1) * 0.35,
      2.6 + i * 0.6,
      ((i * 7) % 3) * 0.2 - 0.2,
    );
    blob.rotation.set(i, i * 2, 0);
    g.add(blob);
  }
  g.scale.setScalar(scale);
  return g;
}

export function house(wall: string, roof: string, lit = false): THREE.Group {
  const walls = mat('#ffffff', {
    map: texture(`siding:${wall}`, [32, 32], SURFACES.siding(wall), [2, 1]),
  });
  const roofs = mat('#ffffff', {
    map: texture(`roof:${roof}`, [32, 32], SURFACES.roof(roof), [2, 2]),
  });
  const win = lit
    ? flat('#f2d58a')
    : mat('#ffffff', { map: texture('glass', [16, 16], SURFACES.glass()) });
  const g = group(m(B(7, 3, 6), walls, 0, 1.5, 0));
  const r = m(new THREE.ConeGeometry(5.2, 2.2, 4), roofs, 0, 4.1, 0);
  r.rotation.y = Math.PI / 4;
  r.scale.set(1, 1, 0.85);
  g.add(r, m(B(1, 2, 0.1), mat('#6b3a2a'), 0, 1, 3.02));
  for (const x of [-2.2, 2.2])
    g.add(
      m(B(1.3, 1, 0.08), win, x, 1.7, 3.02),
      m(B(1.5, 0.12, 0.14), mat('#f2f0ea'), x, 1.15, 3.04),
    );
  return g;
}

export function cloud(r: () => number): THREE.Group {
  const white = flat('#f6f8fb');
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++)
    g.add(m(I(1 + r(), 0), white, (r() - 0.5) * 4, (r() - 0.5) * 0.8, (r() - 0.5) * 2));
  return g;
}
