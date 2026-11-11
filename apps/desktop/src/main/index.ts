import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/bridge';
import { BackendHost } from './backend-host';
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
// namespaces). Test-only escape hatch; the renderer stays sandboxed at the Electron level
// and Windows/macOS always run with the full sandbox.
const osSandbox = !(process.env.RECIT_E2E === '1' && process.env.RECIT_NO_OS_SANDBOX === '1');
if (!osSandbox) app.commandLine.appendSwitch('no-sandbox');

applyGlobalSecurity({ osSandbox });

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let backend: BackendHost | null = null;

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
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

  win.once('ready-to-show', () => win.show());

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
  backend = new BackendHost(
    {
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      ffmpeg: { envPath: process.env.RECIT_FFMPEG_PATH, bundledDir: bundledFfmpegDir() },
      sidecar: process.env.RECIT_DISABLE_SIDECAR === '1' ? null : sidecarCommand(),
    },
    secrets,
  );
  backend.start();

  registerShellIpc(secrets, async () => {
    await backend?.pushSecrets();
  });
  ipcMain.on(IPC.requestBackendPort, (event) => {
    if (event.senderFrame && isAppUrl(event.senderFrame.url)) backend?.connect(event.sender);
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

app.on('before-quit', () => backend?.stop());
