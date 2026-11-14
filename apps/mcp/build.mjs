// Bundles the bridge into one file (dist/recit-mcp.js) and packs dist/rec-it.mcpb for Claude
// Desktop. Run with `pnpm --filter @rec-it/mcp build`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const bundle = join(dist, 'bundle');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(bundle, 'server'), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  logLevel: 'warning',
};
// ESM bundles of CommonJS dependencies need require().
const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
};
await build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(dist, 'recit-mcp.js'),
  banner,
});
await build({
  ...common,
  entryPoints: [join(root, 'src/manifest.ts')],
  outfile: join(dist, 'manifest.mjs'),
});

const { manifest } = await import(pathToFileURL(join(dist, 'manifest.mjs')).href);
rmSync(join(dist, 'manifest.mjs'));
writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(dist, 'recit-mcp.js'), join(bundle, 'server', 'index.js'));
writeFileSync(join(bundle, 'package.json'), '{ "type": "module" }\n');
copyFileSync(join(root, '../../LICENSE'), join(bundle, 'LICENSE'));

// Validate and pack with the official CLI (never through a shell).
const cli = join(
  dirname(createRequire(import.meta.url).resolve('@anthropic-ai/mcpb')),
  'cli',
  'cli.js',
);
execFileSync(process.execPath, [cli, 'validate', join(bundle, 'manifest.json')], {
  stdio: 'inherit',
});
execFileSync(process.execPath, [cli, 'pack', bundle, join(dist, 'rec-it.mcpb')], {
  stdio: 'inherit',
});
