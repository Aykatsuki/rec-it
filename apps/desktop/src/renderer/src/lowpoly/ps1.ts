// The PlayStation look (ADR-054): vertices snap to a coarse screen grid (the wobble of a PS1
// without sub-pixel precision), textures are mapped partly affine (the PS1's swimming textures),
// the scene is drawn small and enlarged with hard pixels, and colours are cut to 15-bit with an
// ordered dither.
import * as THREE from 'three';
import { blocky } from './style';

const shared = {
  uSnap: { value: new THREE.Vector2(160, 284) },
  uAffine: { value: 0.55 },
};

/** Sets the vertex grid for a drawing size (half the pixels: a PS1 snaps to whole pixels). */
export function setGrid(width: number, height: number): void {
  shared.uSnap.value.set(width / 2, height / 2);
}

/** Makes a Lambert material wobble and swim like a PS1 one. */
export function ps1<M extends THREE.MeshLambertMaterial>(m: M): M {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSnap = shared.uSnap;
    sh.uniforms.uAffine = shared.uAffine;
    sh.vertexShader =
      'uniform vec2 uSnap;\nvarying vec3 vAffine;\n' +
      sh.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        if (gl_Position.w > 0.0) {
          vec2 ndc = gl_Position.xy / gl_Position.w;
          ndc = floor(ndc * uSnap + 0.5) / uSnap;
          gl_Position.xy = ndc * gl_Position.w;
        }
        #ifdef USE_MAP
          vAffine = vec3(vMapUv * gl_Position.w, gl_Position.w);
        #else
          vAffine = vec3(0.0, 0.0, 1.0);
        #endif`,
      );
    sh.fragmentShader =
      'uniform float uAffine;\nvarying vec3 vAffine;\n' +
      sh.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec2 affineUv = mix(vMapUv, vAffine.xy / vAffine.z, uAffine);
          diffuseColor *= texture2D(map, affineUv);
        #endif`,
      );
  };
  m.customProgramCacheKey = () => 'ps1';
  return m;
}

export interface MatOptions {
  map?: THREE.Texture;
  emissive?: string;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  flat?: boolean;
  fog?: boolean;
}

/**
 * A PS1 material: a colour, a texture, or both. In the blocky look (ADR-055) it is smooth
 * plastic instead (a standard material with the same colour, texture and glow); it shares every
 * property the kit touches, so callers treat both alike.
 */
export function mat(colour: string, o: MatOptions = {}): THREE.MeshLambertMaterial {
  if (blocky())
    return new THREE.MeshStandardMaterial({
      color: colour,
      roughness: 0.62,
      metalness: 0,
      flatShading: false,
      ...(o.map ? { map: o.map } : {}),
      ...(o.emissive ? { emissive: o.emissive, emissiveIntensity: o.emissiveIntensity ?? 1 } : {}),
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      side: o.side ?? THREE.FrontSide,
      fog: o.fog ?? true,
    }) as unknown as THREE.MeshLambertMaterial;
  return ps1(
    new THREE.MeshLambertMaterial({
      color: colour,
      flatShading: o.flat ?? true,
      ...(o.map ? { map: o.map } : {}),
      ...(o.emissive ? { emissive: o.emissive, emissiveIntensity: o.emissiveIntensity ?? 1 } : {}),
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      side: o.side ?? THREE.FrontSide,
      fog: o.fog ?? true,
    }),
  );
}

/** Unlit (for skies, glows and screens). */
export function flat(
  colour: string,
  o: {
    map?: THREE.Texture;
    transparent?: boolean;
    opacity?: number;
    additive?: boolean;
    side?: THREE.Side;
    fog?: boolean;
  } = {},
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: colour,
    ...(o.map ? { map: o.map } : {}),
    transparent: o.transparent ?? o.additive ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    fog: o.fog ?? true,
    ...(o.additive ? { blending: THREE.AdditiveBlending, depthWrite: false } : {}),
  });
}

/** The enlarging pass: hard pixels, 15-bit colour with a 4×4 ordered dither, tint, vignette. */
export class Ps1Post {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly uniforms = {
    tScene: { value: null as THREE.Texture | null },
    uLow: { value: new THREE.Vector2() },
    uTint: { value: new THREE.Color('#ffffff') },
    uTintAmount: { value: 0 },
    uFlash: { value: 0 },
    uGrain: { value: 0 },
  };

  constructor(lowWidth: number, lowHeight: number) {
    this.target = new THREE.WebGLRenderTarget(lowWidth, lowHeight, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      // Linear light in half floats: no banding in dark scenes before the 15-bit cut.
      type: THREE.HalfFloatType,
    });
    this.uniforms.tScene.value = this.target.texture;
    this.uniforms.uLow.value.set(lowWidth, lowHeight);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        uniform sampler2D tScene; uniform vec2 uLow; uniform vec3 uTint; uniform float uTintAmount;
        uniform float uFlash; uniform float uGrain;
        varying vec2 vUv;
        float bayer(vec2 p) {
          int x = int(mod(p.x, 4.0)); int y = int(mod(p.y, 4.0));
          int i = x + y * 4;
          int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
          return float(m[i]) / 16.0 - 0.5;
        }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 px = floor(vUv * uLow);
          vec3 c = sRGBTransferOETF(vec4(texture2D(tScene, (px + 0.5) / uLow).rgb, 1.0)).rgb;
          c = mix(c, c * uTint * 1.25, uTintAmount);
          c += (hash(px + uGrain) - 0.5) * 0.035 * step(0.001, uGrain);
          c = floor(c * 31.0 + 0.5 + bayer(px) * 0.9) / 31.0;
          vec2 d = vUv - 0.5;
          c *= 1.0 - dot(d, d) * 0.55;
          c = mix(c, vec3(1.0), uFlash);
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target.dispose();
  }
}
