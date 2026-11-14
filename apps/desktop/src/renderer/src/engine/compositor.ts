// WebGL2 compositor for the preview (ADR-008, ADR-029). Each layer is one textured quad placed
// with the same layout maths as the export (computeLayout), so preview and export agree.
import { computeLayout, eqCodes, type PictureState, type Transform } from '@rec-it/core';

export interface Layer {
  /** Stable key (the timeline item id) so its texture is reused between frames. */
  key: string;
  source: TexImageSource;
  width: number;
  height: number;
  transform: Transform;
  /** Opacity × fade and colour effects (ADR-036). Missing means unchanged. */
  picture?: PictureState;
}

const VS = `#version 300 es
in vec2 pos; in vec2 uv; out vec2 v_uv;
void main() { v_uv = uv; gl_Position = vec4(pos, 0.0, 1.0); }`;
// Colour effects match FFmpeg's `eq` filter, which works on BT.709 TV-range YUV codes:
// out = gain·code + offset per plane, with the gains and offsets from eqCodes (ADR-036).
const FS = `#version 300 es
precision highp float;
in vec2 v_uv; uniform sampler2D tex; out vec4 color;
uniform float u_alpha; uniform vec4 u_eq; uniform bool u_color; uniform vec4 u_tint;
void main() {
  vec4 t = texture(tex, v_uv);
  vec3 c = t.rgb;
  if (u_color) {
    float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 codes = vec3(16.0 + 219.0 * Y, 128.0 + 224.0 * (c.b - Y) / 1.8556, 128.0 + 224.0 * (c.r - Y) / 1.5748);
    codes = floor(codes + 0.5);
    codes = clamp(floor(codes * vec3(u_eq.x, u_eq.z, u_eq.z)) + vec3(u_eq.y, u_eq.w, u_eq.w), 0.0, 255.0);
    Y = (codes.x - 16.0) / 219.0;
    float cb = (codes.y - 128.0) / 224.0;
    float cr = (codes.z - 128.0) / 224.0;
    float r = Y + 1.5748 * cr;
    float b = Y + 1.8556 * cb;
    float g = (Y - 0.2126 * r - 0.0722 * b) / 0.7152;
    c = clamp(vec3(r, g, b), 0.0, 1.0);
  }
  // Dip transitions (ADR-037): FFmpeg's fade moves the codes linearly towards the colour's.
  c = mix(c, u_tint.rgb, u_tint.a);
  color = vec4(c, t.a * u_alpha);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(`WebGL shader did not compile: ${gl.getShaderInfoLog(s) || 'no details'}`);
  return s;
}

export class Compositor {
  private readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private buffer!: WebGLBuffer;
  private readonly textures = new Map<string, WebGLTexture>();
  private lost = false;
  private readonly onLost = (e: Event) => {
    // Lets the browser restore the context later (driver reset, GPU switch, sleep).
    e.preventDefault();
    this.lost = true;
    this.textures.clear();
  };
  private readonly onRestored = () => {
    this.lost = false;
    this.setup();
    this.restored?.();
  };

  /**
   * `restored` is called after the graphics context comes back from being lost; every texture
   * is gone then, so the caller should render again.
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly restored?: () => void,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // screenshots and "save frame" read the canvas
    });
    if (!gl) throw new Error('WebGL2 is not available.');
    if (gl.isContextLost())
      throw new Error('The graphics context is lost (try again in a moment).');
    this.gl = gl;
    this.setup();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  private setup(): void {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(
        `WebGL program did not link: ${gl.getProgramInfoLog(program) || 'no details'}`,
      );
    this.program = program;
    this.buffer = gl.createBuffer()!;
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /** Uploads a new picture for a layer (frames are uploaded once and drawn until replaced). */
  upload(key: string, source: TexImageSource): void {
    if (this.isLost) return;
    const gl = this.gl;
    let tex = this.textures.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      this.textures.set(key, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Mipmaps keep large downscales (a 1280 px proxy in a small preview) smooth.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  has(key: string): boolean {
    return this.textures.has(key);
  }

  /** Forgets textures of layers that are no longer around. */
  retain(keys: Set<string>): void {
    for (const [key, tex] of this.textures)
      if (!keys.has(key)) {
        this.gl.deleteTexture(tex);
        this.textures.delete(key);
      }
  }

  /**
   * Draws layers (bottom first) into a frame of `frameW`×`frameH` sequence pixels. Layers without
   * an uploaded texture are skipped.
   */
  draw(
    frameW: number,
    frameH: number,
    layers: Omit<Layer, 'source'>[],
    pixelSize: { w: number; h: number },
  ): void {
    if (this.isLost) return;
    const gl = this.gl;
    if (this.canvas.width !== pixelSize.w || this.canvas.height !== pixelSize.h) {
      this.canvas.width = pixelSize.w;
      this.canvas.height = pixelSize.h;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const posLoc = gl.getAttribLocation(this.program, 'pos');
    const uvLoc = gl.getAttribLocation(this.program, 'uv');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(posLoc);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    const alphaLoc = gl.getUniformLocation(this.program, 'u_alpha');
    const eqLoc = gl.getUniformLocation(this.program, 'u_eq');
    const colorLoc = gl.getUniformLocation(this.program, 'u_color');
    const tintLoc = gl.getUniformLocation(this.program, 'u_tint');
    for (const layer of layers) {
      const tex = this.textures.get(layer.key);
      if (!tex) continue;
      const p = layer.picture;
      if (p && p.alpha <= 0) continue;
      gl.uniform1f(alphaLoc, p?.alpha ?? 1);
      const white = p?.tintColor === 'white' ? 1 : 0;
      gl.uniform4f(tintLoc, white, white, white, p?.tint ?? 0);
      const neutral = !p || (p.brightness === 0 && p.contrast === 1 && p.saturation === 1);
      gl.uniform1i(colorLoc, neutral ? 0 : 1);
      if (!neutral) {
        const { luma, chroma } = eqCodes(p);
        gl.uniform4f(eqLoc, luma.gain, luma.offset, chroma.gain, chroma.offset);
      }
      const l = computeLayout(layer.width, layer.height, frameW, frameH, layer.transform);
      const cx = l.left + l.width / 2;
      const cy = l.top + l.height / 2;
      const r = (l.rotation * Math.PI) / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      // Texture coordinates of the part that is kept (crop, ADR-034).
      const u0 = l.source.x / layer.width;
      const v0 = l.source.y / layer.height;
      const du = l.source.w / layer.width;
      const dv = l.source.h / layer.height;
      const corner = (u: number, v: number) => {
        const dx = (u - 0.5) * l.width;
        const dy = (v - 0.5) * l.height;
        const px = cx + dx * cos - dy * sin;
        const py = cy + dx * sin + dy * cos;
        return [(px / frameW) * 2 - 1, 1 - (py / frameH) * 2, u0 + u * du, v0 + v * dv];
      };
      // Two triangles: (0,0) (1,0) (0,1) and (1,0) (1,1) (0,1).
      const data = new Float32Array([
        ...corner(0, 0),
        ...corner(1, 0),
        ...corner(0, 1),
        ...corner(1, 0),
        ...corner(1, 1),
        ...corner(0, 1),
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /**
   * Frees GPU resources. The context itself is left alone: the same canvas can be given to a new
   * Compositor (React mounts effects twice in development), and a deliberately lost context would
   * come back lost.
   */
  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.isLost) return;
    this.retain(new Set());
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }
}
