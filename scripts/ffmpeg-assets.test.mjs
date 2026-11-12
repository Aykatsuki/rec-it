import { describe, expect, it } from 'vitest';
import { assetFor, parseChecksums } from './ffmpeg-assets.mjs';

describe('fetch-ffmpeg helpers', () => {
  it('names the Windows and Linux GPL builds', () => {
    expect(assetFor('win32', 'x64', '8.1')).toMatchObject({
      file: 'ffmpeg-n8.1-latest-win64-gpl-8.1.zip',
      folder: 'ffmpeg-n8.1-latest-win64-gpl-8.1',
      exe: '.exe',
    });
    expect(assetFor('linux', 'x64', '9.0')?.file).toBe('ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz');
  });

  it('has no build for macOS and rejects bad series', () => {
    expect(assetFor('darwin', 'arm64')).toBeNull();
    expect(() => assetFor('win32', 'x64', '8.1; rm -rf /')).toThrow();
  });

  it('parses checksum files', () => {
    const hash = 'a'.repeat(64);
    const map = parseChecksums(`${hash}  ffmpeg-n8.1-latest-win64-gpl-8.1.zip\r\n\ngarbage line\n`);
    expect(map.get('ffmpeg-n8.1-latest-win64-gpl-8.1.zip')).toBe(hash);
    expect(map.size).toBe(1);
  });
});
