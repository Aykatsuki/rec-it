export interface VersionInfo {
  version: string;
  configuration: string[];
}

/** Parses `ffmpeg -version` output. */
export function parseVersion(output: string): VersionInfo | null {
  const first = output.match(/^ff(?:mpeg|probe) version (\S+)/m);
  if (!first?.[1]) return null;
  const config = output.match(/^configuration:(.*)$/m)?.[1] ?? '';
  return { version: first[1], configuration: config.trim().split(/\s+/).filter(Boolean) };
}

export type Licence = 'gpl' | 'lgpl' | 'nonfree' | 'unknown';

/** Derives the licence of a build from its configure flags (ADR-007). */
export function licenceFromConfiguration(configuration: readonly string[]): Licence {
  if (configuration.length === 0) return 'unknown';
  if (configuration.includes('--enable-nonfree')) return 'nonfree';
  if (configuration.includes('--enable-gpl')) return 'gpl';
  return 'lgpl';
}

/**
 * Parses `ffmpeg -encoders`. Lines look like " V....D libx264   libx264 H.264 ...".
 * Returns encoder names.
 */
export function parseEncoders(output: string): Set<string> {
  const names = new Set<string>();
  let inList = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*-{3,}\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const match = line.match(/^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** Parses `ffmpeg -hwaccels`. */
export function parseHwaccels(output: string): string[] {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => /^Hardware acceleration methods:/i.test(l));
  if (start === -1) return [];
  return lines.slice(start + 1).filter((l) => /^[a-z0-9_]+$/i.test(l));
}
