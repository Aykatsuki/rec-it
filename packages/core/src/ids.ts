declare const idBrand: unique symbol;
/** A branded string id, e.g. Id<'asset'>. */
export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

// Web Crypto exists in Node, Electron and the browser; typed locally to keep core free of DOM/Node types.
const webCrypto = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto;

/** Creates a random, URL-safe id with a readable prefix, e.g. "asset_3f9c…". */
export function createId<Kind extends string>(kind: Kind): Id<Kind> {
  return `${kind}_${webCrypto.randomUUID().replaceAll('-', '')}` as Id<Kind>;
}
