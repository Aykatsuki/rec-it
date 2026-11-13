import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// JASSUB asks for "desynchronized" canvases. On Windows with a hardware GPU, Chromium shows those
// as overlays without transparency, so the caption layer covered the preview in black (ADR-032).
// patches/jassub@*.patch turns it off; this fails if an upgrade drops the patch.
describe('JASSUB patch', () => {
  it('draws captions on normal (transparent) canvases', () => {
    const require = createRequire(join(__dirname, '../../package.json'));
    const root = dirname(require.resolve('jassub/package.json'));
    for (const file of ['2d-renderer.js', 'webgl1-renderer.js', 'webgl2-renderer.js']) {
      const source = readFileSync(join(root, 'dist/worker/renderers', file), 'utf8');
      expect(source, file).not.toMatch(/desynchronized:\s*true/);
    }
  });
});
