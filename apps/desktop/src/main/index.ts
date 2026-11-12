import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/bridge';
import { BackendHost } from './backend-host';
import { handleMediaProtocol, registerMediaScheme } from './media-protocol';
import { bundledFfmpegDir, sidecarCommand } from './paths';
import { SecretStore } from './secrets';
import { applyGlobalSecurity, isAppUrl, setAllowedOrigin } from './security';
import { registerShellIpc } from './shell-ipc';

// Tests run with an isolated profile and a predictable secret store.
if (process.env.RECIT_USER_DATA) app.setPath('userData', process.env.RECIT_USER_DATA);
if (process.env.RECIT_E2E === '1' && process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'basic');
}
// Linux CI containers cannot use Chromium's OS-level sandbox (root user / restricted user
// namespaces). Test-only escape hatch (ADR-021); the renderer stays sandboxed at the
// Electron level and Windows/macOS always run with the full sandbox.
const osSandbox = !(process.env.RECIT_E2E === '1' && process.env.RECIT_NO_OS_SANDBOX === '1');
if (!osSandbox) app.commandLine.appendSwitch('no-sandbox');

applyGlobalSecurity({ osSandbox });
registerMediaScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let backend: BackendHost | null = null;

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  // Fit the window to the screen's usable area: with Windows display scaling a 1440p
  // screen may only have ~936 points of height.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1600, work.width - 32),
    height: Math.min(960, work.height - 32),
    minWidth: Math.min(1100, work.width),
    minHeight: Math.min(680, work.height),
    show: false,
    title: 'Rec-It',
    backgroundColor: '#0e0f12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    // On smaller screens start maximised, like most editors.
    if (process.env.RECIT_E2E !== '1' && (work.width < 1700 || work.height < 1000)) win.maximize();
    win.show();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    setAllowedOrigin(devUrl);
    void win.loadURL(devUrl);
  } else {
    const file = join(__dirname, '../renderer/index.html');
    setAllowedOrigin(`file://${file}`);
    void win.loadFile(file);
  }
  return win;
}

void app.whenReady().then(() => {
  const secrets = new SecretStore(app.getPath('userData'));
  const host = new BackendHost(
    {
      userDataDir: app.getPath('userData'),
      projectsDir:
        process.env.RECIT_PROJECTS_DIR ?? join(app.getPath('documents'), 'Rec-It Projects'),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      ffmpeg: { envPath: process.env.RECIT_FFMPEG_PATH, bundledDir: bundledFfmpegDir() },
      sidecar: process.env.RECIT_DISABLE_SIDECAR === '1' ? null : sidecarCommand(),
    },
    secrets,
  );
  backend = host;
  host.start();
  handleMediaProtocol(() => host.cacheRoot);

  registerShellIpc(secrets, async () => {
    await host.pushSecrets();
  });
  ipcMain.on(IPC.requestBackendPort, (event) => {
    if (event.senderFrame && isAppUrl(event.senderFrame.url)) host.connect(event.sender);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !backend) return;
  // Let the backend stop FFmpeg jobs and close the project cleanly before exiting.
  event.preventDefault();
  quitting = true;
  void backend.stop().finally(() => app.quit());
});
