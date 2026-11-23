// Live evals (ADR-045): each scenario's request goes to a real Claude through Claude Code, which
// reaches an in-memory Rec-It through the real bridge (apps/mcp) and local endpoint. Uses the
// Claude plan Claude Code is signed in with, so it only runs when asked:
//   pnpm eval:claude                      (all scenarios)
//   RECIT_EVAL_FILTER=duck pnpm eval:claude
// Results go to apps/desktop/eval-results/claude-<date>.json. Exit criterion (ROADMAP Phase 7):
// ≥ 90% pass; every run leaves the document valid (the history checks invariants on every edit).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, type Scenario } from './scenarios';
import { World } from './world';

const LIVE = process.env.RECIT_LIVE_EVALS === '1';
const BRIDGE = resolve(__dirname, '../../../../mcp/dist/recit-mcp.js');
const CLAUDE = process.env.RECIT_CLAUDE_BIN ?? 'claude';
const TIMEOUT_MS = 4 * 60_000;

interface Outcome {
  id: string;
  category: string;
  passed: boolean;
  problems: string[];
  tools: string[];
  seconds: number;
  reply: string;
  costUsd?: number;
}

interface ClaudeRun {
  reply: string;
  cost?: number;
  /** Claude Code itself failed (signed out, network…), so the scenario says nothing. */
  broken: boolean;
}

function runClaude(prompt: string, cwd: string, config: string): Promise<ClaudeRun> {
  return new Promise((done, fail) => {
    const child = spawn(
      CLAUDE,
      [
        '-p',
        prompt,
        '--mcp-config',
        config,
        '--strict-mcp-config',
        '--tools',
        '',
        '--allowedTools',
        'mcp__rec-it',
        '--no-session-persistence',
        '--output-format',
        'json',
        ...(process.env.RECIT_EVAL_MODEL ? ['--model', process.env.RECIT_EVAL_MODEL] : []),
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as {
          result?: string;
          total_cost_usd?: number;
          is_error?: boolean;
          num_turns?: number;
        };
        done({
          reply: r.result ?? '',
          cost: r.total_cost_usd,
          broken: !!r.is_error && (r.num_turns ?? 0) <= 1,
        });
      } catch {
        done({
          reply: `(no JSON from Claude Code) ${out.slice(0, 300)} ${err.slice(0, 300)}`,
          broken: true,
        });
      }
    });
  });
}

async function runScenario(s: Scenario): Promise<Outcome & { broken: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'recit-eval-'));
  const ud = join(dir, 'ud');
  mkdirSync(ud);
  const w = new World(s.fixture(), ud);
  w.observe();
  await w.service.listen();
  const config = join(dir, 'mcp.json');
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        'rec-it': { command: process.execPath, args: [BRIDGE], env: { RECIT_USER_DATA: ud } },
      },
    }),
  );
  const t0 = Date.now();
  try {
    const { reply, cost, broken } = await runClaude(
      `${s.prompt}\n\n(My project is open in Rec-It. Do it without asking me questions first.)`,
      dir,
      config,
    );
    let problems: string[];
    try {
      problems = s.check(w);
    } catch (e) {
      problems = [`check threw: ${(e as Error).message}`];
    }
    return {
      broken: broken && !w.calls.length,
      id: s.id,
      category: s.category,
      passed: !problems.length,
      problems,
      tools: w.calls.map((c) => `${c.name}${c.result.isError ? ' ✗' : ''}`),
      seconds: Math.round((Date.now() - t0) / 1000),
      reply: reply.slice(0, 500),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    };
  } finally {
    await w.service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!LIVE)('Claude live evals (Claude Code + bridge)', () => {
  it(
    'passes at least 90% of scenarios',
    async () => {
      expect(existsSync(BRIDGE), 'build the bridge first: pnpm build:mcp').toBe(true);
      const filter = process.env.RECIT_EVAL_FILTER;
      const chosen = SCENARIOS.filter(
        (s) => !filter || s.id.includes(filter) || s.category === filter,
      );
      const outcomes: Outcome[] = [];
      for (const s of chosen) {
        const { broken, ...o } = await runScenario(s);
        if (broken)
          throw new Error(
            `Claude Code could not run (${o.reply}). Is it signed in? Try: claude -p hi`,
          );
        outcomes.push(o);
        console.info(
          `${o.passed ? 'PASS' : 'FAIL'} ${o.id.padEnd(22)} ${o.seconds}s  ${o.tools.join(', ')}${o.problems.length ? `\n     ${o.problems.join('; ')}` : ''}`,
        );
      }
      const passed = outcomes.filter((o) => o.passed).length;
      const out = resolve(__dirname, '../../../eval-results');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `claude-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`),
        JSON.stringify({ passed, total: outcomes.length, outcomes }, null, 2),
      );
      console.info(
        `\n${passed}/${outcomes.length} passed (${Math.round((100 * passed) / outcomes.length)}%)`,
      );
      expect(passed / outcomes.length).toBeGreaterThanOrEqual(0.9);
    },
    60 * 60_000,
  );
});
