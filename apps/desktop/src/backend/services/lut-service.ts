// 3D LUTs (ADR-040): .cube files are read once, checked, and stored in the project file, so a
// project keeps working when the original file moves. Export writes them back out as .cube.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createId, formatCube, LutError, mixLut, parseCube, type Sequence } from '@rec-it/core';
import type { ProjectDatabase } from '@rec-it/db';
import type { LutInfo } from '@rec-it/ipc-contract';

/** Larger files are not LUTs (a 65-point table is about 8 MB of text). */
const MAX_BYTES = 20 * 1024 * 1024;

export async function importLut(db: ProjectDatabase, path: string): Promise<LutInfo> {
  if (extname(path).toLowerCase() !== '.cube') throw new Error('Choose a .cube LUT file.');
  if ((await stat(path)).size > MAX_BYTES) throw new Error('That file is too large to be a LUT.');
  let lut;
  try {
    lut = parseCube(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof LutError)
      throw new Error(`That LUT cannot be used: ${error.message}`, { cause: error });
    throw error;
  }
  const id = createId('lut');
  const name = (lut.title || basename(path, extname(path))).slice(0, 200);
  db.saveLut(id, name, lut.size, lut.data);
  return { id, name, size: lut.size };
}

/**
 * Writes the LUTs the sequence uses into `dir` (each blended by its effect's strength) and
 * returns the file name for each effect id.
 */
export async function writeLutFiles(
  db: ProjectDatabase,
  seq: Sequence,
  dir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let n = 0;
  for (const track of seq.tracks)
    for (const item of track.items)
      for (const e of item.effects ?? []) {
        if (e.kind !== 'lut' || !e.enabled || e.strength <= 0) continue;
        const lut = db.loadLut(e.lutId);
        if (!lut) throw new Error('A clip uses a LUT that is no longer in the project.');
        const name = `lut-${++n}.cube`;
        await writeFile(join(dir, name), formatCube(mixLut(lut, e.strength)));
        files[e.id] = name;
      }
  return files;
}
