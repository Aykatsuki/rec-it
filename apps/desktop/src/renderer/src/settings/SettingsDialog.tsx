import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { SecretName } from '@rec-it/ipc-contract';
import { Badge, Button, Dialog, StatusDot, Tabs, TextField, type DotState } from '@rec-it/ui';
import { AI_PROVIDERS, type AiProvider } from '@rec-it/ai';
import { backend, shell, RecitError } from '../api';
import { useApp } from '../store';
import { useBackendLatency, useSettings, useSystemStatus } from '../hooks';

export type SettingsTab = 'system' | 'secrets' | 'general' | 'ai';

const TABS = [
  { id: 'system', label: 'System' },
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'secrets', label: 'Keys' },
] as const;

export function SettingsDialog({
  tab,
  onTabChange,
  onClose,
}: {
  tab: SettingsTab | null;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={tab !== null} onClose={onClose} title="Settings" closeIcon={<X size={16} />}>
      <Tabs
        items={TABS}
        value={tab ?? 'system'}
        onChange={onTabChange}
        label="Settings sections"
        className="settings__tabs"
      />
      {tab === 'system' && <SystemTab />}
      {tab === 'general' && <GeneralTab />}
      {tab === 'secrets' && <SecretsTab />}
      {tab === 'ai' && <AiTab />}
    </Dialog>
  );
}

function Row({ label, state, children }: { label: string; state?: DotState; children: ReactNode }) {
  return (
    <div className="settings__row">
      <div className="settings__label">
        {state && <StatusDot state={state} />}
        {label}
      </div>
      <div className="settings__value">{children}</div>
    </div>
  );
}

function SystemTab() {
  const { status, refresh, refreshing } = useSystemStatus();
  const latency = useBackendLatency();
  if (!status) return <p className="settings__muted">Connecting to the backend…</p>;
  const { ffmpeg, sidecar, backend, database } = status;
  const encoders = Object.entries(ffmpeg.encoders)
    .filter(([, ok]) => ok)
    .map(([name]) => name);

  return (
    <div className="settings__section" data-testid="system-status">
      <div className="settings__toolbar">
        <Button
          size="sm"
          icon={<RefreshCw size={13} />}
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? 'Checking…' : 'Run checks again'}
        </Button>
      </div>
      <Row label="Backend" state="ok">
        v{backend.version} · Node {backend.nodeVersion} · {backend.platform}-{backend.arch}
        {latency !== null && <> · {latency.toFixed(1)} ms round trip</>}
      </Row>
      <Row label="Database" state="ok">
        <code>{database.path}</code> · schema v{database.schemaVersion}
      </Row>
      <Row label="FFmpeg" state={ffmpeg.state === 'ok' && ffmpeg.message ? 'warn' : ffmpeg.state}>
        {ffmpeg.state === 'ok' ? (
          <>
            {ffmpeg.version}{' '}
            <Badge tone={ffmpeg.licence === 'gpl' ? 'accent' : 'neutral'}>{ffmpeg.licence}</Badge>{' '}
            <span className="settings__muted">({ffmpeg.source})</span>
            <div className="settings__detail">
              Encoders: {encoders.join(', ') || 'none of interest'}
            </div>
            <div className="settings__detail" data-testid="nvenc-status">
              NVENC test encode:{' '}
              {ffmpeg.nvencUsable === null
                ? 'not compiled in'
                : ffmpeg.nvencUsable
                  ? 'working'
                  : 'failed (no supported NVIDIA GPU/driver)'}
            </div>
            <div className="settings__detail">
              Hardware decoding: {ffmpeg.hwaccels.join(', ') || 'none'}
            </div>
          </>
        ) : ffmpeg.state === 'checking' ? (
          'Checking…'
        ) : null}
        {ffmpeg.message && <div className="settings__warning">{ffmpeg.message}</div>}
      </Row>
      <Row label="Media AI (Python)" state={sidecar.state}>
        {sidecar.state === 'ok' ? (
          <>
            v{sidecar.version} · Python {sidecar.python}
            <div className="settings__detail">
              GPU:{' '}
              {sidecar.gpus.length
                ? sidecar.gpus
                    .map(
                      (g) =>
                        `${g.name} (${Math.round(g.memoryMb / 1024)} GB, driver ${g.driverVersion})`,
                    )
                    .join('; ')
                : 'none detected (transcription will use the CPU)'}
            </div>
            <div className="settings__detail">
              CUDA:{' '}
              {sidecar.cuda?.available
                ? `available (${sidecar.cuda.deviceCount} device, via ${sidecar.cuda.via})`
                : 'not available'}
            </div>
          </>
        ) : sidecar.state === 'checking' ? (
          'Starting… the first start creates the Python environment and can take a minute.'
        ) : null}
        {sidecar.message && <div className="settings__warning">{sidecar.message}</div>}
      </Row>
    </div>
  );
}

function GeneralTab() {
  const { settings, update } = useSettings();
  if (!settings) return null;
  return (
    <div className="settings__section">
      <Row label="Claude connector">
        <label className="settings__check">
          <input
            type="checkbox"
            checked={settings.aiEnabled}
            onChange={(e) => void update({ aiEnabled: e.target.checked })}
          />
          Allow Claude to read and edit projects through your Claude app
        </label>
      </Row>
      <Row label="Motion">
        <label className="settings__check">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => void update({ reduceMotion: e.target.checked })}
          />
          Reduce interface animation
        </label>
      </Row>
      <Row label="Transcription device">
        <select
          className="ui-input settings__select"
          value={settings.transcriptionDevice}
          onChange={(e) =>
            void update({
              transcriptionDevice: e.target.value as typeof settings.transcriptionDevice,
            })
          }
        >
          <option value="auto">Automatic (GPU when available)</option>
          <option value="cuda">NVIDIA GPU (CUDA)</option>
          <option value="cpu">CPU only</option>
        </select>
      </Row>
    </div>
  );
}

const SECRET_LABELS: Record<SecretName, { label: string; help: string }> = {
  youtubeApiKey: {
    label: 'YouTube Data API key',
    help: 'Used for research from Phase 8. Free from Google Cloud.',
  },
  aiApiKey: {
    label: 'AI API key',
    help: 'For Kimi (platform.kimi.ai) or another hosted AI. Not needed for Ollama.',
  },
  testSecret: {
    label: 'Test secret',
    help: 'Used to check that secure storage works on this computer.',
  },
};

function SecretsTab() {
  const { status } = useSystemStatus();
  const [info, setInfo] = useState<{ encryptionAvailable: boolean } | null>(null);
  useEffect(() => {
    void shell.invoke('secrets.status', {}).then(setInfo);
  }, []);

  return (
    <div className="settings__section">
      <p className="settings__muted">
        Keys are encrypted with your operating system's secure storage and are never shown again
        after saving. Rec-It does not need a Claude key: Claude connects through your own Claude
        app.
      </p>
      {info && !info.encryptionAvailable && (
        <div className="settings__warning">
          Secure storage is not available on this system, so keys cannot be saved.
        </div>
      )}
      {(Object.keys(SECRET_LABELS) as SecretName[])
        .filter((name) => name !== 'aiApiKey')
        .map((name) => (
          <SecretRow
            key={name}
            name={name}
            fingerprint={status?.secrets[name]?.fingerprint}
            isSet={status?.secrets[name]?.set ?? false}
          />
        ))}
    </div>
  );
}

function SecretRow({
  name,
  isSet,
  fingerprint,
}: {
  name: SecretName;
  isSet: boolean;
  fingerprint?: string | undefined;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { label, help } = SECRET_LABELS[name];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setValue('');
    } catch (e) {
      setError(e instanceof RecitError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row label={label} state={isSet ? 'ok' : undefined}>
      <form
        className="settings__secret"
        data-testid={`secret-${name}`}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => shell.invoke('secrets.set', { name, value }));
        }}
      >
        <TextField
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={isSet ? 'Saved — enter a new value to replace' : 'Paste value'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={label}
        />
        <Button type="submit" size="sm" disabled={!value || busy}>
          Save
        </Button>
        {isSet && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => shell.invoke('secrets.clear', { name }))}
          >
            Remove
          </Button>
        )}
      </form>
      <div className="settings__detail">
        {help}
        {isSet && fingerprint && (
          <>
            {' '}
            Fingerprint <code data-testid={`fingerprint-${name}`}>{fingerprint}</code>
          </>
        )}
      </div>
      {error && <div className="settings__warning">{error}</div>}
    </Row>
  );
}

/** Where one-click AI features get their text (ADR-046), and the AI voice. */
function AiTab() {
  const { settings, update } = useSettings();
  const { status } = useSystemStatus();
  const voice = useApp((s) => s.voice);
  const [models, setModels] = useState<string[] | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const provider = settings.aiProvider;
  const preset = AI_PROVIDERS[provider];
  const loadModels = async () => {
    setBusy(true);
    try {
      setModels((await backend.invoke('ai.models', {})).models);
      setCheck(null);
    } catch (e) {
      setModels(null);
      setCheck({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setCheck(null);
    try {
      const r = await backend.invoke('ai.test', {});
      setCheck({ ok: true, text: `${r.model} answered: “${r.reply}”` });
    } catch (e) {
      setCheck({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings__section" data-testid="ai-settings">
      <p className="settings__muted">
        Writing stories, titles and hooks uses this AI. Ollama runs on your PC and is free; Kimi
        uses your own Moonshot API key. Claude in your Claude app works separately (Claude tab).
      </p>
      <Row label="AI provider">
        <select
          className="ui-input settings__select"
          value={provider}
          aria-label="AI provider"
          onChange={(e) => {
            setModels(null);
            setCheck(null);
            void update({ aiProvider: e.target.value as AiProvider, aiBaseUrl: null, aiModel: '' });
          }}
        >
          {(Object.keys(AI_PROVIDERS) as AiProvider[]).map((p) => (
            <option key={p} value={p}>
              {AI_PROVIDERS[p].label}
            </option>
          ))}
        </select>
        <div className="settings__detail">{preset.help}</div>
      </Row>
      <Row label="Server address">
        <TextField
          key={`${provider}-url`}
          defaultValue={settings.aiBaseUrl ?? ''}
          placeholder={preset.baseUrl || 'http://localhost:1234/v1'}
          spellCheck={false}
          aria-label="Server address"
          onBlur={(e) => void update({ aiBaseUrl: e.target.value.trim() || null })}
        />
      </Row>
      <Row label="Model">
        <div className="settings__secret">
          {models ? (
            <select
              className="ui-input settings__select"
              value={settings.aiModel}
              aria-label="Model"
              onChange={(e) => void update({ aiModel: e.target.value })}
            >
              <option value="">{preset.defaultModel || 'First available'}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <TextField
              key={`${provider}-model`}
              defaultValue={settings.aiModel}
              placeholder={preset.defaultModel || 'First available model'}
              spellCheck={false}
              aria-label="Model"
              onBlur={(e) => void update({ aiModel: e.target.value.trim() })}
            />
          )}
          <Button size="sm" disabled={busy} onClick={() => void loadModels()}>
            List models
          </Button>
        </div>
      </Row>
      {(preset.needsKey || provider === 'custom') && (
        <SecretRow
          name="aiApiKey"
          isSet={status?.secrets.aiApiKey?.set ?? false}
          fingerprint={status?.secrets.aiApiKey?.fingerprint}
        />
      )}
      <Row label="Check">
        <Button size="sm" disabled={busy} onClick={() => void test()} data-testid="ai-test">
          {busy ? 'Asking…' : 'Test the AI'}
        </Button>
        {check && (
          <div
            className={check.ok ? 'settings__detail' : 'settings__warning'}
            data-testid="ai-check"
          >
            {check.text}
          </div>
        )}
      </Row>
      <Row label="AI voice" state={voice?.available ? 'ok' : undefined}>
        {voice?.available ? (
          <>Installed ({voice.engine}). Runs on this PC; nothing is sent anywhere.</>
        ) : voice?.install.state === 'running' ? (
          <>Installing… {voice.install.message}</>
        ) : (
          <>
            <Button
              size="sm"
              disabled={!!voice?.blocked}
              onClick={() => void backend.invoke('voice.install', {})}
            >
              Install AI voice
            </Button>
            <div className="settings__detail">
              Kokoro, a natural-sounding voice that runs on your PC (about 300 MB with its model).
            </div>
          </>
        )}
        {voice?.install.state === 'failed' && (
          <div className="settings__warning">{voice.install.message}</div>
        )}
        {voice?.blocked && <div className="settings__warning">{voice.blocked}</div>}
      </Row>
    </div>
  );
}
