// Which look the kit builds (ADR-055): the low-poly PlayStation look, or the bright blocky-avatar
// game look. Set once per render before any shot is built; materials, textures and people read it.

export type Look = 'ps1' | 'blocky';

let current: Look = 'ps1';
let yellow = false;

export function setLook(look: Look, classicSkin = false): void {
  current = look;
  yellow = look === 'blocky' && classicSkin;
}

export const look = (): Look => current;
export const blocky = (): boolean => current === 'blocky';
/** Everyone has the classic yellow skin (blocky look only). */
export const classicSkin = (): boolean => yellow;
