import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { SecretName } from '@rec-it/ipc-contract';
import { Badge, Button, Dialog, StatusDot, Tabs, TextField, type DotState } from '@rec-it/ui';
import { shell, RecitError } from '../api';
import { useBackendLatency, useSettings, useSystemStatus } from '../hooks';

export type SettingsTab = 'system' | 'secrets' | 'general';

const TABS = [
  { id: 'system', label: 'System' },
  { id: 'general', label: 'General' },
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
          Allow Claude to use Rec-It's tools (takes effect from Phase 6)
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
      {(Object.keys(SECRET_LABELS) as SecretName[]).map((name) => (
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
