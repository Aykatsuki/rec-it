// LUT tables for the preview (ADR-040), fetched from the project once and kept by id.
import { backend } from '../api';

export interface LutTable {
  size: number;
  data: Float32Array;
}

const cache = new Map<string, Promise<LutTable | null>>();

/** The table of a project LUT (null when it is not in the project). */
export function lutTable(id: string): Promise<LutTable | null> {
  let p = cache.get(id);
  if (!p) {
    p = backend.invoke('luts.get', { id }).then((lut) => {
      if (!lut) return null;
      const bytes = Uint8Array.from(atob(lut.data), (c) => c.charCodeAt(0));
      return { size: lut.size, data: new Float32Array(bytes.buffer) };
    });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
