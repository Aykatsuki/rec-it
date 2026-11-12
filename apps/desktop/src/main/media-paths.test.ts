import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRange, resolveMediaUrl } from './media-paths';

describe('recit-media URLs', () => {
  const root = join('/cache');
  it('resolves allowed files', () => {
    expect(resolveMediaUrl('recit-media://asset/project_1/asset_2/proxy.mp4?v=3', root)).toEqual({
      path: join(root, 'project_1', 'asset_2', 'proxy.mp4'),
      mime: 'video/mp4',
    });
  });

  it('refuses anything else', () => {
    for (const url of [
      'recit-media://asset/project_1/asset_2/../../../etc/passwd',
      'recit-media://asset/project_1/%2e%2e/proxy.mp4',
      'recit-media://asset/project_1/asset_2/secrets.json',
      'recit-media://asset/project_1/asset_2/constructor',
      'recit-media://other/project_1/asset_2/proxy.mp4',
      'recit-media://asset/project_1/asset_2',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(resolveMediaUrl(url, root), url).toBeNull();
    }
  });
});

describe('Range headers', () => {
  it('parses the forms browsers send', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-1', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});
