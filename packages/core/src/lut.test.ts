import { describe, expect, it } from 'vitest';
import { applyLut, formatCube, LutError, mixLut, parseCube } from './lut';

const cube = (n: number, f: (r: number, g: number, b: number) => number[]) => {
  const lines = [
    'TITLE "Test"',
    '# comment',
    `LUT_3D_SIZE ${n}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
  ];
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) lines.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).join(' '));
  return lines.join('\r\n');
};

describe('3D LUTs', () => {
  it('parses .cube files, red fastest', () => {
    const lut = parseCube(cube(3, (r, g, b) => [b, g, r]));
    expect(lut.size).toBe(3);
    expect(lut.title).toBe('Test');
    // Entry 1 is r = 0.5, g = 0, b = 0 → (0, 0, 0.5).
    expect([...lut.data.slice(3, 6)]).toEqual([0, 0, 0.5]);
    expect(applyLut(lut, [0.25, 0.5, 1])).toEqual([1, 0.5, 0.25]);
    // Round trip.
    expect(parseCube(formatCube(lut)).data).toEqual(lut.data);
  });

  it('refuses tables it cannot use', () => {
    expect(() => parseCube('LUT_1D_SIZE 4\n0 0 0')).toThrow(LutError);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/8 entries/);
    expect(() => parseCube(`DOMAIN_MAX 2 2 2\n${cube(2, (r, g, b) => [r, g, b])}`)).toThrow(
      /domain/,
    );
    expect(() => parseCube('hello')).toThrow(/LUT_3D_SIZE/);
  });

  it('blends with no change by strength, exactly like mixing the result', () => {
    const lut = parseCube(cube(5, (r, g, b) => [1 - r, g * g, b * 0.5]));
    const half = mixLut(lut, 0.5);
    const c: [number, number, number] = [0.3, 0.7, 0.9];
    const full = applyLut(lut, c);
    applyLut(half, c).forEach((v, i) => expect(v).toBeCloseTo((c[i]! + full[i]!) / 2, 6));
  });
});
