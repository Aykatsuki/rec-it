import { useState } from 'react';
import {
  Check,
  CircleAlert,
  CircleSlash,
  Copy,
  FolderOpen,
  LoaderCircle,
  Sparkles,
  Undo2,
} from 'lucide-react';
import type { ClaudeActivity, ClaudeChange, ClaudeState } from '@rec-it/ipc-contract';
import { Button, EmptyState, StatusDot } from '@rec-it/ui';
import { backend, shell } from '../api';
import { notify } from '../notifications';
import { useApp } from '../store';

/** One line saying whether Claude can reach Rec-It right now. */
export function claudeStatus(state: ClaudeState | null): {
  label: string;
  dot: 'ok' | 'warn' | 'error' | 'missing' | 'checking';
} {
  if (!state) return { label: 'Claude · starting', dot: 'checking' };
  if (!state.enabled) return { label: 'Claude · off', dot: 'missing' };
  if (!state.listening) return { label: 'Claude · unavailable', dot: 'error' };
  if (state.confirmations.length) return { label: 'Claude · needs your OK', dot: 'warn' };
  if (state.clients.length) return { label: 'Claude · connected', dot: 'ok' };
  return { label: 'Claude · not connected', dot: 'missing' };
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function run(channel: 'claude.undoChange' | 'claude.keepChange', group: string) {
  try {
    await backend.invoke(channel, { group });
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'warn');
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify('Copied.');
  } catch {
    notify('Could not copy; select the text instead.', 'warn');
  }
}

/** The Claude tab: connection, what Claude changed (undo in one step), activity and setup. */
export function ClaudePanel() {
  const state = useApp((s) => s.claude);
  const status = claudeStatus(state);
  if (!state) return null;
  const open = state.changes.filter((c) => c.state === 'open');
  const past = state.changes.filter((c) => c.state !== 'open');
  return (
    <div className="claude" data-testid="claude-panel">
      <div className="claude__status">
        <StatusDot state={status.dot} />
        <span>
          {state.clients.length
            ? `Connected: ${state.clients.map((c) => c.name).join(', ')}`
            : status.label.replace('Claude · ', 'Claude is ')}
        </span>
      </div>
      {state.error && <p className="claude__note claude__note--error">{state.error}</p>}
      {!state.enabled && (
        <p className="claude__note">Claude is turned off. Turn it on in Settings → Claude.</p>
      )}

      {state.confirmations.map((c) => (
        <div key={c.id} className="claude__card claude__card--confirm">
          <strong>Claude wants to: {c.title}</strong>
          <p>{c.detail}</p>
          <div className="claude__actions">
            <Button
              variant="primary"
              onClick={() => void backend.invoke('claude.respond', { id: c.id, allow: true })}
            >
              Allow
            </Button>
            <Button
              onClick={() => void backend.invoke('claude.respond', { id: c.id, allow: false })}
            >
              Decline
            </Button>
          </div>
        </div>
      ))}

      {open.map((c) => (
        <ChangeCard key={c.group} change={c} />
      ))}

      <section className="claude__section">
        <header className="claude__section-head">
          <h3>Activity</h3>
          {state.activity.length > 0 && (
            <Button variant="ghost" onClick={() => void backend.invoke('claude.clearActivity', {})}>
              Clear
            </Button>
          )}
        </header>
        {state.activity.length === 0 ? (
          <EmptyState icon={<Sparkles size={20} />} title="Nothing yet">
            Ask Claude in your Claude app to edit this project, e.g. “remove the silences”. Every
            step shows up here.
          </EmptyState>
        ) : (
          <ol className="claude__feed" data-testid="claude-activity">
            {state.activity.map((a) => (
              <ActivityRow key={a.id} activity={a} />
            ))}
          </ol>
        )}
        {past.length > 0 && (
          <p className="claude__note">
            {past.filter((c) => c.state === 'undone').length} change set(s) undone,{' '}
            {past.filter((c) => c.state === 'kept').length} kept.
          </p>
        )}
      </section>

      <Setup state={state} />
    </div>
  );
}

function ChangeCard({ change }: { change: ClaudeChange }) {
  return (
    <div className="claude__card" data-testid="claude-change">
      <strong>
        Claude made {change.edits.length} change{change.edits.length === 1 ? '' : 's'}
      </strong>
      <ul>
        {change.edits.slice(-6).map((e, i) => (
          <li key={i}>{e}</li>
        ))}
        {change.edits.length > 6 && <li>…and {change.edits.length - 6} earlier</li>}
      </ul>
      <div className="claude__actions">
        <Button
          icon={<Undo2 size={14} />}
          disabled={!change.canUndo}
          title={
            change.canUndo
              ? 'Undo all of these in one step'
              : 'Edits were made since; use Ctrl+Z to step back through them'
          }
          onClick={() => void run('claude.undoChange', change.group)}
        >
          Undo all
        </Button>
        <Button
          icon={<Check size={14} />}
          onClick={() => void run('claude.keepChange', change.group)}
        >
          Keep
        </Button>
      </div>
    </div>
  );
}

function ActivityRow({ activity: a }: { activity: ClaudeActivity }) {
  const icon =
    a.status === 'ok' ? (
      <Check size={13} />
    ) : a.status === 'pending' ? (
      <LoaderCircle size={13} />
    ) : a.status === 'denied' ? (
      <CircleSlash size={13} />
    ) : (
      <CircleAlert size={13} />
    );
  return (
    <li className="claude__row" data-status={a.status}>
      <span className="claude__row-icon">{icon}</span>
      <span className="claude__row-text">
        <span className="claude__row-title">{a.title}</span>
        <span className="claude__row-detail">{a.detail}</span>
      </span>
      <time className="claude__row-time">{time(a.at)}</time>
    </li>
  );
}

/** How to add Rec-It to Claude Desktop or Claude Code, and what Claude can see. */
function Setup({ state }: { state: ClaudeState }) {
  const [openByDefault] = useState(() => state.clients.length === 0);
  const { bridgePath, bundlePath, bridgeExists } = state.setup;
  const code = bridgePath ? `claude mcp add rec-it -- node "${bridgePath}"` : null;
  const json = bridgePath
    ? JSON.stringify({ mcpServers: { 'rec-it': { command: 'node', args: [bridgePath] } } }, null, 2)
    : null;
  return (
    <details className="claude__section claude__setup" open={openByDefault}>
      <summary>Connect Claude</summary>
      {!bridgeExists && (
        <p className="claude__note claude__note--error">
          The connector is not built in this copy of Rec-It (run “pnpm build:mcp”).
        </p>
      )}
      <h4>Claude Desktop</h4>
      <p>
        Open <b>rec-it.mcpb</b> (double-click it, or drag it onto Claude Desktop → Settings →
        Extensions) and choose Install.
      </p>
      {bundlePath && (
        <Button
          icon={<FolderOpen size={14} />}
          onClick={() => void shell.invoke('shell.showItemInFolder', { path: bundlePath })}
        >
          Show rec-it.mcpb
        </Button>
      )}
      <h4>Claude Code</h4>
      {code && <CopyBlock text={code} />}
      <details>
        <summary>Manual setup (needs Node.js)</summary>
        <p>Add this to Claude Desktop’s claude_desktop_config.json:</p>
        {json && <CopyBlock text={json} />}
      </details>
      <h4>What Claude can see</h4>
      <p className="claude__note">
        Claude reads only what it asks for through Rec-It’s tools: the project outline, clip
        settings, transcripts and, now and then, a small picture of a frame. That goes to Anthropic
        through your own Claude app and counts toward your Claude plan. Your media files stay on
        this computer. Every edit can be undone, and exports and transcriptions wait for your OK.
        Turn Claude off any time in Settings.
      </p>
    </details>
  );
}

function CopyBlock({ text }: { text: string }) {
  return (
    <div className="claude__copy">
      <pre>{text}</pre>
      <Button variant="ghost" icon={<Copy size={14} />} onClick={() => void copy(text)}>
        Copy
      </Button>
    </div>
  );
}
