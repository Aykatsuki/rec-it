import { app, session, type WebContents } from 'electron';

let allowedOrigin: string | null = null;

/** The renderer's own URL prefix; navigation anywhere else is blocked. */
export function setAllowedOrigin(url: string): void {
  const parsed = new URL(url);
  allowedOrigin = parsed.protocol === 'file:' ? 'file://' : parsed.origin;
}

export function isAppUrl(url: string): boolean {
  if (!allowedOrigin) return false;
  try {
    const parsed = new URL(url);
    return allowedOrigin === 'file://'
      ? parsed.protocol === 'file:'
      : parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

/**
 * Global hardening (ARCHITECTURE §21, Electron security checklist):
 * sandbox everywhere, no new windows, no navigation away from the app, no webviews,
 * and every permission request (camera, notifications, …) denied.
 */
export function applyGlobalSecurity({ osSandbox }: { osSandbox: boolean }): void {
  if (osSandbox) app.enableSandbox();

  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
  });
}
