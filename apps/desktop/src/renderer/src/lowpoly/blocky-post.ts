// The blocky look's camera (ADR-055): full resolution with multisampling, soft shadows, a
// filmic tone curve, depth of field that follows the shot's focus, and a light grade (warmth,
// vignette, the shot's tint and flashes). Replaces the PS1 enlarging pass for this look.
import * as THREE from 'three';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: new THREE.Color('#ffffff') },
    uTintAmount: { value: 0 },
    uFlash: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec3 uTint; uniform float uTintAmount; uniform float uFlash;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = mix(c, c * uTint * 1.25, uTintAmount);
      // A little saturation, as game captures have.
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.12);
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot(d, d) * 0.35;
      c = mix(c, vec3(1.0), uFlash);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

export class BlockyPost {
  private readonly composer: EffectComposer;
  private readonly render: RenderPass;
  private readonly bokeh: BokehPass;
  private readonly grade: ShaderPass;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
  ) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(1);
    this.composer.setSize(width, height);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    this.render = new RenderPass(scene, camera);
    this.bokeh = new BokehPass(scene, camera, { focus: 5, aperture: 0.002, maxblur: 0.006 });
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.render);
    this.composer.addPass(this.bokeh);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  /** Lights and objects of a freshly built shot cast and catch soft shadows. */
  prepare(scene: THREE.Scene): void {
    scene.traverse((o) => {
      const light = o as THREE.DirectionalLight;
      if (light.isDirectionalLight) {
        light.castShadow = true;
        light.shadow.mapSize.set(2048, 2048);
        const cam = light.shadow.camera;
        cam.left = cam.bottom = -14;
        cam.right = cam.top = 14;
        cam.near = 0.5;
        cam.far = 120;
        light.shadow.bias = -0.0004;
        light.shadow.normalBias = 0.02;
        light.shadow.radius = 4;
        // Aim the shadows at the action: the light keeps its direction but sits near the set.
        const dir = light.position.clone().normalize();
        light.target.position.set(0, 0, 0);
        light.position.copy(dir.multiplyScalar(40));
        scene.add(light.target);
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.Material & { transparent?: boolean };
      const unlit = (m as THREE.MeshBasicMaterial).isMeshBasicMaterial;
      mesh.castShadow = !unlit && !m.transparent;
      mesh.receiveShadow = !unlit;
    });
    // A soft fill so shaded sides stay friendly, as in game lighting.
    scene.add(new THREE.AmbientLight('#ffffff', 0.5));
  }

  draw(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    focusDistance: number,
    look: { tint: string; tintAmount: number; flash: number },
  ): void {
    this.render.scene = scene;
    this.render.camera = camera;
    const b = this.bokeh as unknown as {
      scene: THREE.Scene;
      camera: THREE.Camera;
      uniforms: Record<string, { value: number }>;
    };
    b.scene = scene;
    b.camera = camera;
    b.uniforms.focus!.value = focusDistance;
    // Close shots blur the background more; wide shots stay mostly sharp.
    b.uniforms.aperture!.value = 0.0045 / Math.max(1, focusDistance);
    b.uniforms.maxblur!.value = 0.006;
    b.uniforms.nearClip!.value = camera.near;
    b.uniforms.farClip!.value = camera.far;
    b.uniforms.aspect!.value = camera.aspect;
    const g = this.grade.uniforms as Record<string, { value: unknown }>;
    (g.uTint!.value as THREE.Color).set(look.tint);
    g.uTintAmount!.value = look.tintAmount;
    g.uFlash!.value = look.flash;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.shadowMap.enabled = false;
  }
}
