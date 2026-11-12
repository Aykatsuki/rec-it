import { describe, expect, it } from 'vitest';
import { cleanFileName } from './app';

describe('cleanFileName', () => {
  it('keeps normal names and adds the extension once', () => {
    expect(cleanFileName('My Short', '.mp4')).toBe('My Short.mp4');
    expect(cleanFileName('My Short.MP4', '.mp4')).toBe('My Short.mp4');
  });
  it('removes characters Windows does not allow and reserved names', () => {
    expect(cleanFileName('a<b>c:d"e/f\\g|h?i*j', '.mp4')).toBe('abcdefghij.mp4');
    expect(cleanFileName('trailing dots...  ', '.mp4')).toBe('trailing dots.mp4');
    expect(cleanFileName('CON', '.mp4')).toBe('Export.mp4');
    expect(cleanFileName('???', '.mp4')).toBe('Export.mp4');
  });
});
