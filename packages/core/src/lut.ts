// 3D colour lookup tables in the .cube format (Adobe/Resolve), ADR-040. Pure: parsed here, stored
// in the project file, drawn by the preview (a 3D texture) and the export (FFmpeg's lut3d).

export interface Lut3D {
  /** Points per axis (2–65). */
  size: number;
  /** size³ RGB triplets, red changing fastest, then green, then blue (the .cube order). */
  data: Float32Array;
  title?: string;
}

export class LutError extends Error {
  override name = 'LutError';
}

/** Parses a .cube file. Only 3D tables with the default 0–1 domain are accepted. */
export function parseCube(text: string): Lut3D {
  let size = 0;
  let title: string | undefined;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'TITLE') {
      title = line.slice(5).trim().replace(/^"|"$/g, '');
    } else if (key === 'LUT_3D_SIZE') {
      size = Number(rest[0]);
    } else if (key === 'LUT_1D_SIZE') {
      throw new LutError('This is a 1D LUT; Rec-It uses 3D LUTs (.cube with LUT_3D_SIZE).');
    } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const want = key === 'DOMAIN_MIN' ? 0 : 1;
      if (rest.slice(0, 3).some((v) => Math.abs(Number(v) - want) > 1e-6))
        throw new LutError('LUTs with a domain other than 0–1 are not supported.');
    } else if (key === 'LUT_3D_INPUT_RANGE' || key === 'LUT_1D_INPUT_RANGE') {
      if (Math.abs(Number(rest[0])) > 1e-6 || Math.abs(Number(rest[1]) - 1) > 1e-6)
        throw new LutError('LUTs with an input range other than 0–1 are not supported.');
    } else if (/^[-+.\d]/.test(key!)) {
      if (rest.length < 2) throw new LutError('A LUT line has fewer than three numbers.');
      values.push(Number(key), Number(rest[0]), Number(rest[1]));
    }
    // Other keywords (e.g. from other tools) are ignored.
  }
  if (!Number.isInteger(size) || size < 2 || size > 65)
    throw new LutError('The LUT has no valid LUT_3D_SIZE (2–65).');
  if (values.length !== size ** 3 * 3)
    throw new LutError(`The LUT should have ${size ** 3} entries but has ${values.length / 3}.`);
  if (values.some((v) => !Number.isFinite(v)))
    throw new LutError('The LUT has a value that is not a number.');
  return { size, data: Float32Array.from(values), ...(title ? { title } : {}) };
}

/**
 * The table blended with "no change" by `strength` (0–1). With trilinear interpolation this is
 * exactly mix(colour, lut(colour), strength), so the export can use a single table.
 */
export function mixLut(lut: Lut3D, strength: number): Lut3D {
  const s = Math.min(1, Math.max(0, strength));
  const n = lut.size;
  const data = new Float32Array(lut.data.length);
  let i = 0;
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const id = [r / (n - 1), g / (n - 1), b / (n - 1)];
        for (let c = 0; c < 3; c++, i++) data[i] = id[c]! + (lut.data[i]! - id[c]!) * s;
      }
  return { size: n, data };
}

/** Writes a table as .cube text (what FFmpeg's lut3d reads). */
export function formatCube(lut: Lut3D): string {
  const lines = [`LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3)
    lines.push(
      `${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`,
    );
  return `${lines.join('\n')}\n`;
}

/** Trilinear lookup (the same interpolation as the preview's 3D texture and lut3d=trilinear). */
export function applyLut(lut: Lut3D, rgb: [number, number, number]): [number, number, number] {
  const n = lut.size;
  const p = rgb.map((v) => Math.min(1, Math.max(0, v)) * (n - 1));
  const i0 = p.map((v) => Math.min(n - 2, Math.floor(v)));
  const f = p.map((v, k) => v - i0[k]!);
  const at = (r: number, g: number, b: number, c: number) =>
    lut.data[((b * n + g) * n + r) * 3 + c]!;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const dr = k & 1;
      const dg = (k >> 1) & 1;
      const db = (k >> 2) & 1;
      const w = (dr ? f[0]! : 1 - f[0]!) * (dg ? f[1]! : 1 - f[1]!) * (db ? f[2]! : 1 - f[2]!);
      v += w * at(i0[0]! + dr, i0[1]! + dg, i0[2]! + db, c);
    }
    out[c] = v;
  }
  return out;
}
