// Blocky PS1 people (ADR-054): boxes with painted textures, a face painted on the front of the
// head (eyes, brows, nose, one of four mouth shapes, blinking), jointed arms and legs, and the
// actions a shot can ask for. Every pose is a pure function of time.
import * as THREE from 'three';
import type { Action, CastMember, Mood } from '@rec-it/lowpoly';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mat } from './ps1';
import { blocky, classicSkin } from './style';
import { noise, rng, shade, texture } from './textures';

const SKIN: Record<CastMember['skin'], string> = {
  pale: '#f0d2bd',
  light: '#ebc4a2',
  tan: '#d6a27a',
  brown: '#8d5a3b',
  dark: '#5a3826',
};

type Eyes = 'open' | 'closed' | 'wide' | 'tired';

/** The classic yellow of blocky avatars (ADR-055). */
const CLASSIC_YELLOW = '#f3c93a';

const skinOf = (c: CastMember): string => (classicSkin() ? CLASSIC_YELLOW : SKIN[c.skin]);

/**
 * The blocky look's face (ADR-055): a simple cartoon face on a clear background, laid over the
 * rounded head. Big black eyes, a smile or the mood, four mouth shapes for speech, blinking.
 */
function blockyFaceTexture(c: CastMember, eyes: Eyes, mouth: number, mood: Mood): THREE.Texture {
  const key = `bface:${c.id}:${c.extra}:${c.hairColor}:${c.age}:${eyes}:${mouth}:${mood}`;
  return texture(key, [128, 128], (g) => {
    g.clearRect(0, 0, 128, 128);
    const ink = '#1b1b1d';
    g.fillStyle = ink;
    g.strokeStyle = ink;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const ey = 50;
    for (const ex of [42, 86]) {
      if (eyes === 'closed') {
        g.lineWidth = 5;
        g.beginPath();
        g.arc(ex, ey - 2, 8, 0.15 * Math.PI, 0.85 * Math.PI);
        g.stroke();
        continue;
      }
      const ry = eyes === 'wide' ? 13 : eyes === 'tired' ? 6 : 10;
      const rx = eyes === 'wide' ? 9 : 6.5;
      g.beginPath();
      g.ellipse(ex, ey + (eyes === 'tired' ? 4 : 0), rx, ry, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(ex - rx * 0.3, ey - ry * 0.4, eyes === 'wide' ? 3.2 : 2.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ink;
      if (eyes === 'tired') {
        g.fillRect(ex - 10, ey - 8, 20, 6);
      }
    }
    // Brows only when they say something.
    const slant = ['sad', 'lonely', 'tired', 'scared'].includes(mood)
      ? -1
      : ['angry', 'determined'].includes(mood)
        ? 1
        : 0;
    const lift = mood === 'surprised' || mood === 'scared' || eyes === 'wide' ? -6 : 0;
    if (slant || lift || c.age === 'old') {
      g.lineWidth = 5;
      for (const [ex, side] of [
        [42, 1],
        [86, -1],
      ] as const) {
        g.beginPath();
        g.moveTo(ex - 10 * side, ey - 20 + lift - slant * 5);
        g.lineTo(ex + 10 * side, ey - 20 + lift + slant * 5);
        g.stroke();
      }
    }
    if (c.extra === 'beard' || c.extra === 'mustache') {
      g.fillStyle = c.age === 'old' ? '#d9d6cf' : shade(c.hairColor, 0.08);
      if (c.extra === 'beard') {
        // A short chin beard under the mouth, with sideburns along the jaw.
        g.beginPath();
        g.moveTo(22, 96);
        g.quadraticCurveTo(64, 140, 106, 96);
        g.lineTo(106, 112);
        g.quadraticCurveTo(64, 132, 22, 112);
        g.fill();
        g.beginPath();
        g.moveTo(42, 104);
        g.quadraticCurveTo(64, 128, 86, 104);
        g.lineTo(86, 118);
        g.quadraticCurveTo(64, 132, 42, 118);
        g.fill();
      }
      g.beginPath();
      g.ellipse(64, 79, 18, 5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ink;
    }
    // Mouth: 0 shut (the mood), 1 parted, 2 open, 3 round.
    const my = 90;
    g.lineWidth = 5;
    if (mouth === 0) {
      g.beginPath();
      if (mood === 'sad' || mood === 'lonely' || mood === 'tired' || mood === 'scared')
        g.arc(64, my + 16, 16, 1.2 * Math.PI, 1.8 * Math.PI);
      else if (mood === 'angry' || mood === 'determined') {
        g.moveTo(50, my);
        g.lineTo(78, my);
      } else if (mood === 'surprised') {
        g.ellipse(64, my, 7, 9, 0, 0, Math.PI * 2);
        g.fill();
      } else if (mood === 'confused') {
        g.moveTo(48, my + 2);
        g.quadraticCurveTo(58, my - 6, 66, my);
        g.quadraticCurveTo(72, my + 5, 80, my - 3);
      } else if (mood === 'happy' || mood === 'proud') {
        g.moveTo(44, my - 6);
        g.quadraticCurveTo(64, my + 18, 84, my - 6);
        g.closePath();
        g.fill();
        g.fillStyle = '#ffffff';
        g.fillRect(52, my - 5, 24, 4);
        g.fillStyle = ink;
      } else g.arc(64, my - 12, 18, 0.25 * Math.PI, 0.75 * Math.PI);
      g.stroke();
    } else if (mouth === 1) {
      g.beginPath();
      g.ellipse(64, my, 12, 4, 0, 0, Math.PI * 2);
      g.fill();
    } else if (mouth === 2) {
      g.beginPath();
      g.moveTo(46, my - 6);
      g.quadraticCurveTo(64, my + 22, 82, my - 6);
      g.closePath();
      g.fill();
      g.fillStyle = '#d9575b';
      g.beginPath();
      g.ellipse(64, my + 5, 8, 3.5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ink;
    } else {
      g.beginPath();
      g.ellipse(64, my + 2, 8, 10, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (c.extra === 'glasses' || c.extra === 'sunglasses') {
      g.lineWidth = 4;
      for (const ex of [42, 86]) {
        g.beginPath();
        g.roundRect(ex - 15, ey - 13, 30, 26, 7);
        if (c.extra === 'sunglasses') g.fill();
        g.stroke();
      }
      g.beginPath();
      g.moveTo(57, ey - 4);
      g.lineTo(71, ey - 4);
      g.stroke();
    }
  });
}

function px(g: CanvasRenderingContext2D, c: string, x: number, y: number, w: number, h: number) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

/** The face painted on the front of the head: 64×64, for one eye state and mouth shape. */
function faceTexture(c: CastMember, eyes: Eyes, mouth: number, mood: Mood): THREE.Texture {
  const key = `face:${c.id}:${c.skin}:${c.hairColor}:${c.age}:${c.gender}:${c.extra}:${eyes}:${mouth}:${mood}`;
  return texture(key, [64, 64], (g, w, h, r) => {
    const skin = SKIN[c.skin];
    noise(g, w, h, r, skin, 0.05);
    // Shading at the sides and under the brow, like a baked PS1 face.
    px(g, shade(skin, -0.12), 0, 0, 5, h);
    px(g, shade(skin, -0.12), w - 5, 0, 5, h);
    px(g, shade(skin, -0.06), 5, 0, 3, h);
    px(g, shade(skin, -0.06), w - 8, 0, 3, h);
    const old = c.age === 'old';
    const brow = old ? '#b9b4ab' : shade(c.hairColor, -0.1);
    const ey = 25;
    // Eyes.
    for (const ex of [14, 39]) {
      if (eyes === 'closed') {
        px(g, shade(skin, -0.35), ex, ey + 3, 11, 2);
        continue;
      }
      const tall = eyes === 'wide' ? 8 : eyes === 'tired' ? 4 : 6;
      const top = eyes === 'wide' ? ey : eyes === 'tired' ? ey + 3 : ey + 1;
      px(g, '#f4f1ea', ex, top, 11, tall);
      px(g, c.id.length % 3 === 0 ? '#3f6f9a' : '#4a3020', ex + 3, top + 1, 5, tall - 1);
      px(g, '#0e0a08', ex + 4, top + 2, 3, tall - 3);
      px(g, '#ffffff', ex + 4, top + 2, 1, 1);
      px(g, shade(skin, -0.45), ex - 1, top - 1, 13, 1);
      if (c.gender === 'female') px(g, '#1a1210', ex - 1, top - 1, 13, 2);
    }
    // Brows.
    // Brows tell the feeling: inner ends up (sad), down (angry), both raised (scared).
    const lift =
      eyes === 'wide' || mood === 'scared' || mood === 'surprised' ? -3 : mood === 'happy' ? -1 : 0;
    const slant = ['sad', 'lonely', 'tired', 'scared'].includes(mood)
      ? -2
      : ['angry', 'determined'].includes(mood)
        ? 2
        : 0;
    const bh = c.gender === 'female' ? 2 : 3;
    for (let k = 0; k < 13; k++) {
      // Left brow: inner end at k = 12; right brow: inner end at k = 0.
      const dl = Math.round((slant * k) / 12);
      const dr = Math.round((slant * (12 - k)) / 12);
      px(g, brow, 13 + k, ey - 5 + lift + dl, 1, bh);
      px(g, brow, 38 + k, ey - 5 + lift + dr + (mood === 'confused' ? -2 : 0), 1, bh);
    }
    // Nose.
    px(g, shade(skin, -0.2), 31, 31, 2, 10);
    px(g, shade(skin, -0.35), 28, 41, 3, 2);
    px(g, shade(skin, -0.35), 33, 41, 3, 2);
    // Wrinkles.
    if (old) {
      for (const y of [14, 17]) px(g, shade(skin, -0.2), 18, y, 28, 1);
      px(g, shade(skin, -0.22), 12, 34, 9, 1);
      px(g, shade(skin, -0.22), 43, 34, 9, 1);
      px(g, shade(skin, -0.22), 20, 46, 1, 7);
      px(g, shade(skin, -0.22), 43, 46, 1, 7);
    }
    // Beard and moustache.
    const hair = old ? '#c9c5bd' : c.hairColor;
    if (c.extra === 'beard')
      for (let y = 40; y < h; y++)
        for (let x = 6; x < w - 6; x++)
          if (r() < 0.85 && (y > 44 || x < 18 || x > 46))
            px(g, shade(hair, (r() - 0.5) * 0.3), x, y, 1, 1);
    const lips = c.gender === 'female' ? '#a8434a' : shade(skin, -0.38);
    // Mouth: 0 shut, 1 parted, 2 open, 3 round.
    const my = 49;
    if (mouth === 0) {
      // A closed mouth shows the feeling: a smile, a frown, a tight line, a twist.
      if (mood === 'happy' || mood === 'proud') {
        px(g, lips, 26, my + 1, 12, 2);
        px(g, lips, 23, my - 1, 3, 2);
        px(g, lips, 38, my - 1, 3, 2);
      } else if (mood === 'sad' || mood === 'lonely' || mood === 'tired') {
        px(g, lips, 26, my - 1, 12, 2);
        px(g, lips, 23, my + 1, 3, 2);
        px(g, lips, 38, my + 1, 3, 2);
      } else if (mood === 'angry' || mood === 'determined') px(g, lips, 25, my, 14, 3);
      else if (mood === 'scared') {
        px(g, lips, 26, my - 1, 12, 4);
        px(g, '#3a1512', 28, my, 8, 2);
      } else if (mood === 'surprised') {
        px(g, lips, 29, my - 2, 6, 6);
        px(g, '#2a0d0b', 30, my - 1, 4, 4);
      } else if (mood === 'confused') {
        px(g, lips, 24, my + 1, 8, 2);
        px(g, lips, 32, my, 8, 2);
      } else px(g, lips, 24, my, 16, 2);
    } else if (mouth === 1) {
      px(g, lips, 24, my - 1, 16, 4);
      px(g, '#3a1512', 26, my, 12, 2);
    } else if (mouth === 2) {
      px(g, lips, 23, my - 3, 18, 9);
      px(g, '#2a0d0b', 25, my - 2, 14, 7);
      px(g, '#e9e4da', 26, my - 2, 12, 1);
      px(g, '#9c3a3a', 27, my + 3, 10, 2);
    } else {
      px(g, lips, 27, my - 3, 10, 9);
      px(g, '#2a0d0b', 29, my - 2, 6, 7);
    }
    if (c.extra === 'mustache' || c.extra === 'beard') px(g, hair, 22, my - 5, 20, 3);
    if (c.extra === 'glasses') {
      g.strokeStyle = '#151515';
      g.lineWidth = 1;
      g.strokeRect(11.5, ey - 1.5, 17, 10);
      g.strokeRect(35.5, ey - 1.5, 17, 10);
      px(g, '#151515', 28, ey + 2, 8, 1);
    }
    if (c.extra === 'sunglasses') {
      px(g, '#0c0c0e', 11, ey - 1, 18, 9);
      px(g, '#0c0c0e', 35, ey - 1, 18, 9);
      px(g, '#0c0c0e', 28, ey + 1, 8, 2);
      px(g, '#5a6a7a', 13, ey, 4, 2);
      px(g, '#5a6a7a', 37, ey, 4, 2);
    }
  });
}

/** The front of the top: jacket, suit, lab coat… painted on 32×40. */
function topTexture(c: CastMember): THREE.Texture {
  return texture(`top:${c.top}:${c.topColor}`, [32, 40], (g, w, h, r) => {
    const col = c.top === 'labcoat' ? '#ecebe6' : c.top === 'prison' ? '#e07a2c' : c.topColor;
    noise(g, w, h, r, col, c.top === 'sweater' ? 0.14 : 0.07);
    switch (c.top) {
      case 'jacket':
        px(g, '#24262b', 12, 0, 8, h);
        px(g, shade(col, -0.3), 11, 0, 1, h);
        px(g, shade(col, -0.3), 20, 0, 1, h);
        px(g, shade(col, -0.25), 0, h - 4, w, 4);
        px(g, shade(col, -0.25), 3, 22, 6, 1);
        px(g, shade(col, -0.25), 23, 22, 6, 1);
        break;
      case 'suit':
        px(g, '#f1efe9', 11, 0, 10, 16);
        px(g, '#8a1f24', 15, 2, 2, 16);
        px(g, shade(col, -0.35), 10, 0, 1, 22);
        px(g, shade(col, -0.35), 21, 0, 1, 22);
        px(g, '#d9d5cc', 15, 26, 2, 2);
        px(g, '#d9d5cc', 15, 32, 2, 2);
        break;
      case 'labcoat':
        px(g, c.topColor, 12, 0, 8, 10);
        px(g, '#c9c8c2', 15, 0, 1, h);
        px(g, '#c9c8c2', 4, 24, 7, 6);
        px(g, '#3a6fc0', 6, 23, 1, 4);
        break;
      case 'hoodie':
        px(g, shade(col, -0.2), 9, 0, 14, 4);
        px(g, '#e9e6de', 13, 4, 1, 8);
        px(g, '#e9e6de', 18, 4, 1, 8);
        px(g, shade(col, -0.18), 7, 24, 18, 9);
        break;
      case 'uniform':
        px(g, shade(col, -0.3), 15, 0, 2, h);
        px(g, '#d9b53a', 22, 8, 4, 5);
        for (const y of [8, 16, 24, 32]) px(g, '#d9b53a', 13, y, 2, 2);
        px(g, '#1c1c1f', 0, h - 4, w, 3);
        break;
      case 'prison':
        px(g, '#f2f0ea', 4, 8, 12, 5);
        for (let x = 5; x < 15; x += 2) px(g, '#1c1c1f', x, 9, 1, 3);
        break;
      case 'dress':
        px(g, shade(col, -0.2), 0, 22, w, 2);
        break;
      case 'sweater':
        for (let y = 0; y < h; y += 4) px(g, shade(col, -0.12), 0, y, w, 1);
        px(g, shade(col, -0.25), 9, 0, 14, 3);
        break;
      default:
        px(g, shade(col, -0.25), 10, 0, 12, 3);
    }
  });
}

function pantsTexture(colour: string): THREE.Texture {
  return texture(`pants:${colour}`, [16, 32], (g, w, h, r) => {
    noise(g, w, h, r, colour, 0.12);
    px(g, shade(colour, 0.25), 3, 0, 1, h);
    px(g, shade(colour, -0.3), 0, 0, 16, 2);
  });
}

function hairTexture(colour: string): THREE.Texture {
  return texture(`hair:${colour}`, [16, 16], (g, w, h, r) => {
    noise(g, w, h, r, colour, 0.2);
    for (let x = 0; x < w; x += 2) px(g, shade(colour, -0.25), x, 0, 1, h);
  });
}

function box(
  w: number,
  h: number,
  d: number,
  m: THREE.Material | THREE.Material[],
  y = 0,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, y, 0);
  return new THREE.Mesh(geo, m);
}

/** A built person: the root (feet at the origin, facing +z) and its joints. */
export class Person {
  readonly root = new THREE.Group();
  readonly hips = new THREE.Group();
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly shoulderL = new THREE.Group();
  readonly shoulderR = new THREE.Group();
  readonly elbowL = new THREE.Group();
  readonly elbowR = new THREE.Group();
  readonly hipL = new THREE.Group();
  readonly hipR = new THREE.Group();
  readonly kneeL = new THREE.Group();
  readonly kneeR = new THREE.Group();
  /** Where things are held. */
  readonly handR = new THREE.Group();
  readonly handL = new THREE.Group();
  readonly skeleton = new THREE.Group();
  readonly height: number;
  private readonly face: THREE.MeshLambertMaterial;
  /** Height of the hip joints standing (poses scale from it). */
  private readonly hipY: number;
  private readonly faces = new Map<string, THREE.Texture>();
  private readonly blinkSeed: number;

  constructor(
    readonly c: CastMember,
    seed = 1,
  ) {
    this.blinkSeed = seed;
    const k = c.age === 'child' ? 0.66 : 1;
    if (blocky()) {
      this.hipY = 0.68;
      this.face = this.blockyBody(c);
      this.root.scale.setScalar(c.age === 'child' ? 0.72 : 1);
      if (c.age === 'child') this.head.scale.setScalar(1.2);
      this.height = 1.78 * (c.age === 'child' ? 0.72 : 1);
      this.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.userData.person = c.id;
      });
      return;
    }
    this.hipY = 0.92;
    const skin = SKIN[c.skin];
    const skinMat = mat(skin, { flat: false });
    const topCol = c.top === 'labcoat' ? '#ecebe6' : c.top === 'prison' ? '#e07a2c' : c.topColor;
    const sleeve = mat(topCol);
    const legs = mat('#ffffff', {
      map: pantsTexture(c.top === 'prison' ? '#e07a2c' : c.bottomColor),
    });
    const shoe = mat('#262321');
    const hairCol = c.age === 'old' ? '#c9c5bd' : c.hairColor;
    const hairMat = mat('#ffffff', { map: hairTexture(hairCol) });
    const fem = c.gender === 'female';
    const sw = fem ? 0.42 : 0.48;

    this.root.rotation.order = 'YXZ';
    this.root.add(this.hips);
    this.hips.position.y = this.hipY;
    // Legs.
    for (const [hip, knee, x] of [
      [this.hipL, this.kneeL, -0.11],
      [this.hipR, this.kneeR, 0.11],
    ] as const) {
      hip.position.set(x, 0, 0);
      this.hips.add(hip);
      const dressLegs = c.top === 'dress' ? skinMat : legs;
      hip.add(box(0.17, 0.46, 0.18, legs, -0.23));
      knee.position.y = -0.46;
      hip.add(knee);
      knee.add(box(0.15, 0.42, 0.16, dressLegs, -0.21));
      knee.add(box(0.16, 0.08, 0.28, shoe, -0.44).translateZ(0.05));
    }
    // Torso and arms.
    this.hips.add(this.torso);
    const front = mat('#ffffff', { map: topTexture(c) });
    const chest = box(sw, 0.62, 0.26, [sleeve, sleeve, sleeve, sleeve, front, sleeve], 0.31);
    this.torso.add(chest);
    this.torso.add(box(sw * 0.9, 0.12, 0.24, legs, -0.02));
    if (c.top === 'dress') {
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 0.5, 6), sleeve);
      skirt.position.y = -0.22;
      this.torso.add(skirt);
    }
    if (c.top === 'labcoat') {
      const tail = box(sw + 0.02, 0.38, 0.27, front, -0.18);
      this.torso.add(tail);
    }
    for (const [shoulder, elbow, x] of [
      [this.shoulderL, this.elbowL, -(sw / 2 + 0.07)],
      [this.shoulderR, this.elbowR, sw / 2 + 0.07],
    ] as const) {
      shoulder.position.set(x, 0.56, 0);
      this.torso.add(shoulder);
      shoulder.add(box(0.13, 0.34, 0.14, sleeve, -0.15));
      elbow.position.y = -0.31;
      shoulder.add(elbow);
      elbow.add(box(0.12, 0.3, 0.13, c.top === 'tshirt' ? skinMat : sleeve, -0.14));
      elbow.add(box(0.11, 0.12, 0.12, skinMat, -0.34));
    }
    this.handR.position.set(0, -0.38, 0.06);
    this.elbowR.add(this.handR);
    this.handL.position.set(0, -0.38, 0.06);
    this.elbowL.add(this.handL);
    // Neck and head.
    this.torso.add(box(0.13, 0.1, 0.13, skinMat, 0.66));
    this.head.position.y = 0.7;
    this.torso.add(this.head);
    const faceTex = this.faceTex('open', 0);
    this.face = mat('#ffffff', { map: faceTex, flat: false });
    const side = mat('#ffffff', {
      map: texture(`side3:${skin}:${hairCol}:${c.hair}`, [16, 16], (g, w, h, r) => {
        // The side of the head: darker skin, hair over the top half and the back, a small ear.
        // (A plain skin side read as a second face when the head turned.)
        noise(g, w, h, r, shade(skin, -0.14), 0.05);
        if (c.hair !== 'bald') {
          const long = !(c.hair === 'short' || c.hair === 'spiky');
          noise(g, w, 8, r, hairCol, 0.2);
          px(g, hairCol, 0, 0, 6, long ? h : 12);
          px(g, hairCol, w - 6, 0, 6, long ? h : 12);
        }
        px(g, shade(skin, -0.3), 7, 8, 2, 4);
      }),
    });
    const back = c.hair === 'bald' ? skinMat : hairMat;
    const head = box(
      0.32,
      0.38,
      0.34,
      [side, side, c.hair === 'bald' ? skinMat : hairMat, skinMat, this.face, back],
      0.2,
    );
    this.head.add(head);
    // Hair.
    if (c.hair !== 'bald') {
      this.head.add(box(0.35, 0.08, 0.37, hairMat, 0.41));
      if (c.hair === 'long' || c.hair === 'ponytail')
        this.head.add(
          box(
            0.36,
            c.hair === 'long' ? 0.5 : 0.25,
            0.08,
            hairMat,
            c.hair === 'long' ? 0.12 : 0.26,
          ).translateZ(-0.16),
        );
      if (c.hair === 'long') {
        this.head.add(box(0.05, 0.42, 0.3, hairMat, 0.16).translateX(-0.18));
        this.head.add(box(0.05, 0.42, 0.3, hairMat, 0.16).translateX(0.18));
      }
      if (c.hair === 'ponytail') this.head.add(box(0.1, 0.3, 0.1, hairMat, 0.08).translateZ(-0.24));
      if (c.hair === 'curly')
        this.head.add(
          new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 0), hairMat).translateY(0.4),
        );
      if (c.hair === 'spiky')
        for (let i = 0; i < 5; i++) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), hairMat);
          cone.position.set(-0.12 + i * 0.06, 0.48, -0.02 + (i % 2) * 0.05);
          this.head.add(cone);
        }
      this.head.add(box(0.36, 0.06, 0.06, hairMat, 0.36).translateZ(0.16));
    }
    // Headwear.
    if (c.extra === 'hat') {
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.18, 0.16, 8), mat('#2a2522'));
      hat.position.y = 0.5;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 8), mat('#2a2522'));
      brim.position.y = 0.42;
      this.head.add(hat, brim);
    }
    if (c.extra === 'cap') {
      this.head.add(box(0.36, 0.1, 0.38, mat(c.topColor), 0.45));
      this.head.add(box(0.3, 0.03, 0.18, mat(c.topColor), 0.41).translateZ(0.25));
    }
    if (c.extra === 'helmet')
      this.head.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(0.24, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
          mat('#4a5a3a'),
        ).translateY(0.38),
      );
    // A bare skeleton for x-ray shots (hidden unless asked for).
    const bone = mat('#f2efe4', { emissive: '#dfe8ff', emissiveIntensity: 0.9 });
    const sk = this.skeleton;
    sk.visible = false;
    this.head.add(
      Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.26), bone), {
        name: 'skull',
      }).translateY(0.22),
    );
    sk.add(box(0.04, 0.6, 0.04, bone, 0.3));
    for (let i = 0; i < 5; i++) sk.add(box(sw * 0.75, 0.025, 0.2, bone, 0.48 - i * 0.07));
    sk.add(box(0.3, 0.1, 0.12, bone, -0.02));
    this.torso.add(sk);
    this.head.children.find((m) => m.name === 'skull')!.visible = false;
    for (const part of [
      this.shoulderL,
      this.shoulderR,
      this.elbowL,
      this.elbowR,
      this.hipL,
      this.hipR,
      this.kneeL,
      this.kneeR,
    ]) {
      const b = box(0.04, 0.3, 0.04, bone, -0.17);
      b.name = 'bone';
      b.visible = false;
      part.add(b);
    }
    this.root.scale.setScalar(k);
    if (c.age === 'child') this.head.scale.setScalar(1.25);
    this.height = 1.78 * k;
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.userData.person = c.id;
    });
  }

  /**
   * The blocky-avatar body (ADR-055): legs, torso and arms as chunky boxes (two blocks per limb
   * so knees and elbows still bend), a rounded head with a cartoon face laid over it, blocky hair
   * and hats. Same joints and the same height as the low-poly person, so every pose and every
   * camera works unchanged. Returns the face material.
   */
  private blockyBody(c: CastMember): THREE.MeshLambertMaterial {
    const skinCol = skinOf(c);
    const skinMat = mat(skinCol);
    const topCol = c.top === 'labcoat' ? '#f2f1ec' : c.top === 'prison' ? '#e8822f' : c.topColor;
    const sleeve = mat(topCol);
    const legCol = c.top === 'prison' ? '#e8822f' : c.bottomColor;
    const legs = mat(legCol);
    const shoe = mat(shade(legCol, -0.45));
    const hairCol = c.age === 'old' ? '#d2cec6' : c.hairColor;
    const hairMat = mat(hairCol);
    const rbox = (w: number, h: number, d: number, m: THREE.Material | THREE.Material[], y = 0) => {
      const geo = new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.12);
      geo.translate(0, y, 0);
      return new THREE.Mesh(geo, m);
    };
    this.root.rotation.order = 'YXZ';
    this.root.add(this.hips);
    this.hips.position.y = 0.68;
    for (const [hip, knee, x] of [
      [this.hipL, this.kneeL, -0.165],
      [this.hipR, this.kneeR, 0.165],
    ] as const) {
      hip.position.set(x, 0, 0);
      this.hips.add(hip);
      const thigh = c.top === 'dress' ? sleeve : legs;
      hip.add(rbox(0.32, 0.37, 0.33, thigh, -0.17));
      knee.position.y = -0.34;
      hip.add(knee);
      knee.add(rbox(0.31, 0.3, 0.32, c.top === 'dress' ? skinMat : legs, -0.13));
      knee.add(rbox(0.32, 0.07, 0.34, shoe, -0.305));
    }
    this.hips.add(this.torso);
    const front = mat('#ffffff', { map: topTexture(c) });
    this.torso.add(rbox(0.66, 0.68, 0.33, [sleeve, sleeve, sleeve, sleeve, front, sleeve], 0.34));
    if (c.top === 'dress')
      this.torso.add(
        new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.46, 0.42, 16), sleeve).translateY(-0.12),
      );
    for (const [shoulder, elbow, x] of [
      [this.shoulderL, this.elbowL, -0.495],
      [this.shoulderR, this.elbowR, 0.495],
    ] as const) {
      shoulder.position.set(x, 0.6, 0);
      this.torso.add(shoulder);
      shoulder.add(rbox(0.31, 0.39, 0.31, sleeve, -0.11));
      elbow.position.y = -0.3;
      shoulder.add(elbow);
      elbow.add(
        rbox(0.3, 0.32, 0.3, c.top === 'tshirt' || c.top === 'dress' ? skinMat : sleeve, -0.14),
      );
      elbow.add(rbox(0.29, 0.07, 0.29, skinMat, -0.31));
    }
    this.handR.position.set(0, -0.36, 0.08);
    this.elbowR.add(this.handR);
    this.handL.position.set(0, -0.36, 0.08);
    this.elbowL.add(this.handL);
    // Head: a rounded block a little wider than deep, the face laid just in front.
    this.head.position.y = 0.68;
    this.torso.add(this.head);
    this.head.add(rbox(0.2, 0.06, 0.2, skinMat, 0.02));
    this.head.add(rbox(0.42, 0.4, 0.4, skinMat, 0.24));
    const face = mat('#ffffff', { map: this.faceTex('open', 0), transparent: true });
    face.depthWrite = false;
    face.polygonOffset = true;
    face.polygonOffsetFactor = -2;
    this.head.add(
      new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.38), face).translateY(0.24).translateZ(0.203),
    );
    // Hair: a cap of blocks over the top and the back.
    if (c.hair !== 'bald' && c.extra !== 'hat' && c.extra !== 'helmet') {
      this.head.add(rbox(0.46, 0.13, 0.45, hairMat, 0.47));
      this.head.add(
        rbox(
          0.46,
          c.hair === 'long' ? 0.62 : 0.3,
          0.1,
          hairMat,
          c.hair === 'long' ? 0.2 : 0.33,
        ).translateZ(-0.19),
      );
      this.head.add(rbox(0.07, 0.2, 0.42, hairMat, 0.36).translateX(-0.215));
      this.head.add(rbox(0.07, 0.2, 0.42, hairMat, 0.36).translateX(0.215));
      if (c.hair === 'long') {
        this.head.add(rbox(0.08, 0.5, 0.3, hairMat, 0.16).translateX(-0.23).translateZ(-0.04));
        this.head.add(rbox(0.08, 0.5, 0.3, hairMat, 0.16).translateX(0.23).translateZ(-0.04));
      }
      if (c.hair === 'ponytail')
        this.head.add(rbox(0.14, 0.34, 0.14, hairMat, 0.24).translateZ(-0.3));
      if (c.hair === 'curly')
        for (const [x, z] of [
          [-0.14, 0.06],
          [0.14, 0.06],
          [0, -0.1],
          [-0.12, -0.14],
          [0.12, -0.14],
        ] as const)
          this.head.add(
            new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), hairMat)
              .translateY(0.5)
              .translateX(x)
              .translateZ(z),
          );
      if (c.hair === 'spiky')
        for (let i = 0; i < 5; i++) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 6), hairMat);
          cone.position.set(-0.16 + i * 0.08, 0.6, -0.02 + (i % 2) * 0.08);
          this.head.add(cone);
        }
      // A fringe over the forehead.
      this.head.add(rbox(0.44, 0.08, 0.06, hairMat, 0.43).translateZ(0.2));
    }
    if (c.extra === 'hat') {
      const dark = mat('#2b2724');
      this.head.add(
        new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.23, 0.2, 20), dark).translateY(0.54),
      );
      this.head.add(
        new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.03, 24), dark).translateY(0.45),
      );
    }
    if (c.extra === 'cap') {
      const cap = mat(c.topColor);
      this.head.add(rbox(0.46, 0.13, 0.45, cap, 0.48));
      this.head.add(rbox(0.38, 0.03, 0.2, cap, 0.44).translateZ(0.28));
    }
    if (c.extra === 'helmet')
      this.head.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
          mat('#55663f'),
        ).translateY(0.4),
      );
    return face;
  }

  private faceTex(eyes: Eyes, mouth: number, mood: Mood = 'neutral'): THREE.Texture {
    const key = `${eyes}${mouth}${mood}`;
    let t = this.faces.get(key);
    if (!t) {
      t = blocky()
        ? blockyFaceTexture(this.c, eyes, mouth, mood)
        : faceTexture(this.c, eyes, mouth, mood);
      this.faces.set(key, t);
    }
    return t;
  }

  /** World position of the eyes, the chest, or the middle of the body. */
  point(where: 'eyes' | 'chest' | 'body' | 'hand'): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    if (where === 'hand') return this.handR.getWorldPosition(new THREE.Vector3());
    const b = blocky();
    if (where === 'eyes')
      return this.head.localToWorld(new THREE.Vector3(0, b ? 0.27 : 0.22, b ? 0.2 : 0.17));
    if (where === 'chest')
      return this.torso.localToWorld(new THREE.Vector3(0, b ? 0.46 : 0.4, b ? 0.17 : 0.13));
    return this.hips.localToWorld(new THREE.Vector3(0, 0.1, 0));
  }

  /** Shows the skeleton and fades everything else (x-ray). */
  xray(on: boolean): void {
    this.skeleton.visible = on;
    this.root.traverse((o) => {
      if (o.name === 'bone' || o.name === 'skull') o.visible = on;
      const m = (o as THREE.Mesh).material;
      if (!m || o.name === 'bone' || o.name === 'skull' || this.skeleton.children.includes(o))
        return;
      for (const x of Array.isArray(m) ? m : [m]) {
        x.transparent = on;
        x.opacity = on ? 0.2 : 1;
        x.depthWrite = !on;
        const lit = x as THREE.MeshLambertMaterial;
        if (on && lit.emissive) {
          lit.emissive.set('#1f5aa8');
          lit.emissiveIntensity = 0.8;
        }
      }
    });
  }

  /** Poses the person for an action at time t (seconds into the shot). */
  pose(
    action: Action,
    t: number,
    mouth: number,
    start = new THREE.Vector3(),
    facing = 0,
    mood: Mood = 'neutral',
  ): void {
    const s = Math.sin;
    const reset = [
      this.hips,
      this.torso,
      this.head,
      this.shoulderL,
      this.shoulderR,
      this.elbowL,
      this.elbowR,
      this.hipL,
      this.hipR,
      this.kneeL,
      this.kneeR,
    ];
    for (const j of reset) j.rotation.set(0, 0, 0);
    this.hips.position.set(0, this.hipY, 0);
    this.root.rotation.set(0, facing, 0);
    this.root.position.copy(start);
    let eyes: Eyes =
      mood === 'tired' ? 'tired' : mood === 'scared' || mood === 'surprised' ? 'wide' : 'open';
    // Sad, lonely and tired people move slowly.
    if (['sad', 'lonely', 'tired'].includes(mood) && !['fall', 'shock', 'pickUp'].includes(action))
      t *= 0.65;
    // Blink every few seconds.
    const r = rng(this.blinkSeed);
    const period = 2.6 + r() * 2;
    if ((t + r() * period) % period < 0.12) eyes = 'closed';
    const arms = (l: number, rr: number) => {
      this.shoulderL.rotation.z = -l;
      this.shoulderR.rotation.z = rr;
    };
    const forward = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
    switch (action) {
      case 'idle':
      case 'talk': {
        arms(0.08, 0.08);
        this.torso.scale.y = 1 + s(t * 2.2) * 0.006;
        this.head.rotation.y = s(t * 0.8) * 0.12;
        if (action === 'talk') {
          this.head.rotation.x = s(t * 5.3) * 0.05;
          this.shoulderR.rotation.x = -0.35 + s(t * 2.1) * 0.12;
          this.elbowR.rotation.x = -0.9 + s(t * 3.1) * 0.2;
        }
        break;
      }
      case 'walk':
      case 'run': {
        const run = action === 'run';
        const ph = t * (run ? 11 : 6.5);
        const a = run ? 0.9 : 0.5;
        this.hipL.rotation.x = s(ph) * a;
        this.hipR.rotation.x = -s(ph) * a;
        this.kneeL.rotation.x = Math.max(0, -s(ph)) * a * 1.4;
        this.kneeR.rotation.x = Math.max(0, s(ph)) * a * 1.4;
        this.shoulderL.rotation.x = -s(ph) * a * 0.8;
        this.shoulderR.rotation.x = s(ph) * a * 0.8;
        this.elbowL.rotation.x = this.elbowR.rotation.x = run ? -1.3 : -0.25;
        arms(0.06, 0.06);
        this.torso.rotation.x = run ? 0.25 : 0.04;
        this.hips.position.y = this.hipY + Math.abs(s(ph)) * (run ? 0.06 : 0.025);
        this.root.position.addScaledVector(forward, t * (run ? 4 : 1.25));
        break;
      }
      case 'fall': {
        const k = Math.min(1, Math.max(0, (t - 0.25) / 0.55));
        const e = k * k;
        this.root.rotation.x = -e * (Math.PI / 2);
        this.root.position.y +=
          e * 0.12 + (k >= 1 ? Math.abs(s((t - 0.8) * 14)) * 0.04 * Math.exp(-(t - 0.8) * 5) : 0);
        arms(0.4 + e * 1.2, 0.5 + e * 1.0);
        this.shoulderL.rotation.x = -e * 1.6;
        this.shoulderR.rotation.x = -e * 1.2;
        this.hipL.rotation.x = -e * 0.4;
        this.hipR.rotation.x = e * 0.2;
        this.kneeL.rotation.x = e * 0.6;
        this.head.rotation.x = -e * 0.3;
        if (k > 0 && k < 1) eyes = 'wide';
        break;
      }
      case 'point': {
        arms(0.06, 0.05);
        this.shoulderR.rotation.x = -1.45;
        this.head.rotation.y = 0.1;
        break;
      }
      case 'shock': {
        const k = Math.min(1, t / 0.25);
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -2.4 * k;
        arms(0.5 * k, 0.5 * k);
        this.elbowL.rotation.x = this.elbowR.rotation.x = -1.2 * k;
        this.torso.rotation.x = -0.15 * k;
        this.root.position.x += s(t * 60) * 0.008 * Math.max(0, 1 - t);
        eyes = 'wide';
        mouth = Math.max(mouth, 2);
        break;
      }
      case 'sit': {
        this.hips.position.y = this.hipY * 0.54;
        this.hipL.rotation.x = this.hipR.rotation.x = -1.5;
        this.kneeL.rotation.x = this.kneeR.rotation.x = 1.5;
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -0.4;
        this.elbowL.rotation.x = this.elbowR.rotation.x = -0.5;
        this.head.rotation.y = s(t * 0.7) * 0.1;
        break;
      }
      case 'sleep': {
        this.root.rotation.x = -Math.PI / 2;
        this.root.position.y += 0.15;
        arms(0.1, 0.1);
        this.torso.scale.z = 1 + s(t * 1.4) * 0.03;
        eyes = 'closed';
        break;
      }
      case 'float': {
        this.root.position.y += 0.9 + s(t * 1.3) * 0.12;
        this.root.rotation.z = s(t * 0.6) * 0.15;
        arms(1.1 + s(t * 1.1) * 0.15, 1.2 + s(t * 0.9) * 0.15);
        this.hipL.rotation.z = -0.15;
        this.hipR.rotation.z = 0.2;
        this.kneeL.rotation.x = 0.3 + s(t) * 0.1;
        break;
      }
      case 'shiver': {
        this.root.position.x += s(t * 70) * 0.012;
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -0.7;
        arms(-0.5, -0.5);
        this.elbowL.rotation.x = this.elbowR.rotation.x = -1.8;
        this.head.rotation.x = 0.15;
        break;
      }
      case 'celebrate': {
        arms(2.6, 2.6);
        this.elbowL.rotation.z = -0.3;
        this.elbowR.rotation.z = 0.3;
        this.root.position.y += Math.abs(s(t * 7)) * 0.18;
        mouth = Math.max(mouth, 2);
        break;
      }
      case 'think': {
        arms(0.05, 0.05);
        this.shoulderR.rotation.x = -1.0;
        this.shoulderR.rotation.z = -0.35;
        this.elbowR.rotation.x = -2.1;
        this.head.rotation.z = 0.12;
        this.head.rotation.x = s(t * 0.9) * 0.04 - 0.05;
        break;
      }
      case 'crouch': {
        this.hips.position.y = this.hipY * 0.6;
        this.hipL.rotation.x = -1.3;
        this.hipR.rotation.x = -0.5;
        this.kneeL.rotation.x = 1.9;
        this.kneeR.rotation.x = 1.7;
        this.torso.rotation.x = 0.35;
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -0.6;
        this.elbowL.rotation.x = this.elbowR.rotation.x = -0.9;
        this.head.rotation.y = s(t * 1.6) * 0.45;
        this.head.rotation.x = -0.25;
        break;
      }
      case 'eat': {
        arms(0.05, 0.05);
        const bite = (Math.sin(t * 3) + 1) / 2;
        this.shoulderR.rotation.x = -1.2 - bite * 0.3;
        this.elbowR.rotation.x = -1.6 - bite * 0.4;
        this.shoulderR.rotation.z = -0.2;
        mouth = bite > 0.6 ? 2 : 0;
        break;
      }
      case 'salute': {
        arms(0.05, 0.05);
        const k = Math.min(1, t / 0.4);
        this.shoulderR.rotation.x = -1.3 * k;
        this.shoulderR.rotation.z = 0.9 * k;
        this.elbowR.rotation.x = -2.2 * k;
        this.head.rotation.x = -0.05;
        break;
      }
      case 'read': {
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -1.0;
        this.elbowL.rotation.x = this.elbowR.rotation.x = -1.0;
        this.shoulderL.rotation.z = -0.25;
        this.shoulderR.rotation.z = 0.25;
        this.head.rotation.x = 0.35 + s(t * 0.8) * 0.03;
        break;
      }
      case 'wave': {
        arms(0.05, 2.5);
        this.elbowR.rotation.z = s(t * 8) * 0.5;
        this.head.rotation.y = 0.1;
        break;
      }
      case 'lookUp': {
        arms(0.06, 0.05);
        const k = Math.min(1, t / 0.5);
        this.head.rotation.x = -0.65 * k;
        this.torso.rotation.x = -0.12 * k;
        this.shoulderR.rotation.x = -2.2 * k;
        this.shoulderR.rotation.z = 0.35 * k;
        this.elbowR.rotation.x = -1.5 * k;
        this.head.rotation.y = s(t * 0.6) * 0.18;
        break;
      }
      case 'patrol': {
        const ph = t * 5;
        this.hipL.rotation.x = s(ph) * 0.38;
        this.hipR.rotation.x = -s(ph) * 0.38;
        this.kneeL.rotation.x = Math.max(0, -s(ph)) * 0.5;
        this.kneeR.rotation.x = Math.max(0, s(ph)) * 0.5;
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -0.55;
        this.elbowL.rotation.x = this.elbowR.rotation.x = -0.9;
        this.torso.rotation.x = 0.12;
        this.head.rotation.y = s(t * 1.2) * 0.35;
        this.hips.position.y = this.hipY - 0.02 + Math.abs(s(ph)) * 0.02;
        this.root.position.addScaledVector(forward, t * 0.55);
        break;
      }
      case 'pickUp': {
        const down = Math.min(1, t / 0.6) * (1 - Math.min(1, Math.max(0, (t - 1.0) / 0.6)));
        this.torso.rotation.x = 0.95 * down;
        this.hips.position.y = this.hipY * (1 - 0.3 * down);
        this.hipL.rotation.x = this.hipR.rotation.x = -0.9 * down;
        this.kneeL.rotation.x = this.kneeR.rotation.x = 1.3 * down;
        const up = Math.min(1, Math.max(0, (t - 1.0) / 0.6));
        this.shoulderR.rotation.x = -0.4 * down - 1.1 * up;
        this.elbowR.rotation.x = -0.7 * up;
        this.shoulderL.rotation.x = -0.3 * up;
        this.head.rotation.x = 0.35 * up + 0.2 * down;
        break;
      }
      case 'shakeHead': {
        this.shoulderL.rotation.x = this.shoulderR.rotation.x = -0.7;
        arms(-0.5, -0.5);
        this.elbowL.rotation.x = this.elbowR.rotation.x = -1.8;
        this.head.rotation.y = s(t * 8) * 0.4 * Math.max(0.15, 1 - t / 2);
        break;
      }
      case 'nod': {
        arms(0.06, 0.06);
        this.head.rotation.x = s(t * 7) * 0.18 * Math.max(0.15, 1 - t / 2);
        break;
      }
      case 'work': {
        this.shoulderL.rotation.x = -0.8 + s(t * 7) * 0.08;
        this.shoulderR.rotation.x = -0.75 + s(t * 9) * 0.14;
        this.elbowL.rotation.x = this.elbowR.rotation.x = -1.1;
        this.shoulderL.rotation.z = 0.2;
        this.shoulderR.rotation.z = -0.2;
        this.head.rotation.x = 0.28;
        this.torso.rotation.x = 0.1;
        break;
      }
    }
    // The feeling shapes the whole body.
    if (!['fall', 'sleep', 'float'].includes(action)) {
      switch (mood) {
        case 'sad':
        case 'lonely':
        case 'tired':
          this.torso.rotation.x += 0.15;
          this.head.rotation.x += action === 'lookUp' ? 0 : 0.28;
          this.shoulderL.rotation.z *= 0.5;
          this.shoulderR.rotation.z *= 0.5;
          break;
        case 'scared':
          this.torso.rotation.x += 0.12;
          if (['idle', 'talk', 'crouch', 'patrol'].includes(action)) {
            this.shoulderL.rotation.x -= 0.35;
            this.shoulderR.rotation.x -= 0.35;
            this.elbowL.rotation.x -= 0.8;
            this.elbowR.rotation.x -= 0.8;
          }
          this.head.rotation.y += s(t * 3.1) * 0.3;
          this.root.position.x += s(t * 41) * 0.004;
          break;
        case 'angry':
          this.torso.rotation.x += 0.07;
          this.head.rotation.x += 0.08;
          if (action === 'idle' || action === 'talk') {
            arms(0.25, 0.25);
            this.elbowR.rotation.x -= 0.7 * Math.max(0, s(t * 2.5));
          }
          break;
        case 'determined':
        case 'proud':
          this.torso.rotation.x -= 0.06;
          this.head.rotation.x -= 0.08;
          break;
        case 'happy':
          if (action === 'idle' || action === 'talk')
            this.root.position.y += Math.abs(s(t * 4)) * 0.025;
          this.head.rotation.z += s(t * 2) * 0.05;
          break;
        case 'confused':
          this.head.rotation.z += 0.2;
          if (action === 'idle' || action === 'think') {
            this.shoulderR.rotation.x = -2.5;
            this.shoulderR.rotation.z = 0.4;
            this.elbowR.rotation.x = -1.9 + s(t * 12) * 0.12;
          }
          break;
        case 'surprised':
          this.torso.rotation.x -= 0.08;
          this.head.rotation.x -= 0.1;
          break;
      }
    }
    this.face.map = this.faceTex(eyes, mouth, mood);
  }
}
