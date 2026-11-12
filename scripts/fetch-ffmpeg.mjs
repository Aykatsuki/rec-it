#!/usr/bin/env node
// Downloads a checksum-verified GPL FFmpeg build into resources/ffmpeg/<platform>-<arch>/.
// Usage: pnpm fetch-ffmpeg [--series 8.1] [--platform win32] [--arch x64] [--force]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_SERIES, RELEASE_BASE, assetFor, parseChecksums } from './ffmpeg-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    series: { type: 'string', default: DEFAULT_SERIES },
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
    force: { type: 'boolean', default: false },
  },
});

const asset = assetFor(opts.platform, opts.arch, opts.series);
if (!asset) {
  console.log(`No prebuilt FFmpeg for ${opts.platform}-${opts.arch}.`);
  if (opts.platform === 'darwin')
    console.log('On macOS run: brew install ffmpeg  (Rec-It will use it from PATH)');
  process.exit(0);
}

const dest = join(root, 'resources', 'ffmpeg', `${opts.platform}-${opts.arch}`);
if (
  !opts.force &&
  existsSync(join(dest, `ffmpeg${asset.exe}`)) &&
  existsSync(join(dest, 'BUILD-INFO.json'))
) {
  console.log(`FFmpeg already present in ${dest} (use --force to replace).`);
  process.exit(0);
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastLog = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    if (total && Date.now() - lastLog > 1000) {
      lastLog = Date.now();
      process.stdout.write(
        `\r  ${((done / total) * 100).toFixed(0)}% of ${(total / 1048576).toFixed(0)} MB`,
      );
    }
  });
  await pipeline(body, createWriteStream(file));
  if (total) process.stdout.write('\n');
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

const work = await mkdtemp(join(tmpdir(), 'recit-ffmpeg-'));
try {
  console.log(`Fetching checksums from ${RELEASE_BASE}/checksums.sha256`);
  const sums = await fetch(`${RELEASE_BASE}/checksums.sha256`, { redirect: 'follow' });
  if (!sums.ok) throw new Error(`Could not download checksums (${sums.status})`);
  const expected = parseChecksums(await sums.text()).get(asset.file);
  if (!expected)
    throw new Error(
      `${asset.file} is not listed in checksums.sha256. Try --series with another version.`,
    );

  const archive = join(work, asset.file);
  console.log(`Downloading ${asset.file}`);
  await download(asset.url, archive);
  const actual = await sha256(archive);
  if (actual !== expected)
    throw new Error(`Checksum mismatch for ${asset.file}: expected ${expected}, got ${actual}`);
  console.log('Checksum verified.');

  // bsdtar (bundled with Windows 10+ and macOS) and GNU tar both extract these archives.
  const extracted = spawnSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error('Extraction failed (is "tar" available?)');

  const bin = join(work, asset.folder, 'bin');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe']) {
    await copyFile(join(bin, `${name}${asset.exe}`), join(dest, `${name}${asset.exe}`));
    if (!asset.exe) await chmod(join(dest, name), 0o755);
  }
  const licence = (await readdir(join(work, asset.folder))).find((f) => /^licen[cs]e/i.test(f));
  if (licence) await copyFile(join(work, asset.folder, licence), join(dest, 'LICENSE.txt'));
  await writeFile(
    join(dest, 'BUILD-INFO.json'),
    JSON.stringify(
      {
        source: 'BtbN/FFmpeg-Builds',
        series: opts.series,
        file: asset.file,
        url: asset.url,
        sha256: actual,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`FFmpeg ${opts.series} (GPL) installed in ${dest}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
