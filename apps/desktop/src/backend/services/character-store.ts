// Remembered characters (ADR-053): every character an episode designs is kept in the project's
// media folder ("<project> media/characters/<id>/": character.json, sheet.png, face.png) and
// reused, look, pictures and voice, by every later episode, so a series keeps its cast.
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredCharacter } from '@rec-it/templates';

export interface CharacterFiles extends StoredCharacter {
  /** The full-body design sheet. */
  sheet: string;
  /** The face close-up, when one was drawn. */
  face?: string;
}

const ID = /^[a-z0-9_]{1,40}$/;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

export class CharacterStore {
  constructor(private readonly folder: () => Promise<string>) {}

  private async dir(): Promise<string> {
    return join(await this.folder(), 'characters');
  }

  /** Every remembered character that still has its design sheet. */
  async list(): Promise<CharacterFiles[]> {
    const dir = await this.dir();
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: CharacterFiles[] = [];
    for (const id of names.sort()) {
      if (!ID.test(id)) continue;
      const base = join(dir, id);
      try {
        const c = JSON.parse(
          await readFile(join(base, 'character.json'), 'utf8'),
        ) as StoredCharacter;
        const sheet = join(base, 'sheet.png');
        if (!(await exists(sheet)) || typeof c.name !== 'string' || typeof c.look !== 'string')
          continue;
        const face = join(base, 'face.png');
        out.push({
          id,
          name: c.name,
          gender: c.gender === 'female' ? 'female' : 'male',
          age: c.age === 'old' || c.age === 'young' ? c.age : 'adult',
          look: c.look,
          ...(typeof c.voice === 'string' ? { voice: c.voice } : {}),
          sheet,
          ...((await exists(face)) ? { face } : {}),
        });
      } catch {
        // A broken entry is skipped, never fatal.
      }
    }
    return out;
  }

  /** Keeps a newly designed character (copies its pictures into the store). */
  async save(
    c: StoredCharacter,
    pictures: { sheet: string; face?: string },
  ): Promise<CharacterFiles> {
    if (!ID.test(c.id)) throw new Error(`Bad character id: ${c.id}`);
    const base = join(await this.dir(), c.id);
    await mkdir(base, { recursive: true });
    const sheet = join(base, 'sheet.png');
    await copyFile(pictures.sheet, sheet);
    const face = pictures.face ? join(base, 'face.png') : undefined;
    if (pictures.face && face) await copyFile(pictures.face, face);
    const record: StoredCharacter = {
      id: c.id,
      name: c.name,
      gender: c.gender,
      age: c.age,
      look: c.look,
      ...(c.voice ? { voice: c.voice } : {}),
    };
    await writeFile(join(base, 'character.json'), `${JSON.stringify(record, null, 2)}\n`);
    return { ...record, sheet, ...(face ? { face } : {}) };
  }

  /** Forgets a character: the next episode designs it afresh. */
  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await rm(join(await this.dir(), id), { recursive: true, force: true });
  }
}
