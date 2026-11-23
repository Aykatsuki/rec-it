// Runs the live Claude evals (ADR-045) through Claude Code. Usage:
//   pnpm eval:claude [filter]     e.g. pnpm eval:claude duck, pnpm eval:claude safety
// Uses the Claude plan Claude Code is signed in with (about one short session per scenario).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const filter = process.argv[2];
const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'apps/desktop/src/backend/claude-evals/live.test.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RECIT_LIVE_EVALS: '1',
      ...(filter ? { RECIT_EVAL_FILTER: filter } : {}),
    },
  },
);
process.exit(result.status ?? 1);
