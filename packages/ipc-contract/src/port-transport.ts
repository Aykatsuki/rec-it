import type { Envelope, Transport } from './envelope';

/**
 * Structural type covering the DOM MessagePort, Node's worker_threads MessagePort
 * and Electron's MessagePortMain, without depending on any of their type packages.
 */
// The listener parameter is `any` because the DOM types it as a generic Event listener.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (event: any) => void;

export interface PortLike {
  postMessage(message: unknown): void;
  start?(): void;
  addEventListener?(type: 'message', listener: Listener): void;
  removeEventListener?(type: 'message', listener: Listener): void;
  on?(type: 'message', listener: Listener): unknown;
  off?(type: 'message', listener: Listener): unknown;
}

export function portTransport(port: PortLike): Transport {
  return {
    send(message: Envelope) {
      port.postMessage(message);
    },
    subscribe(listener) {
      const handler: Listener = (event: { data: unknown }) => listener(event.data);
      if (port.addEventListener) {
        port.addEventListener('message', handler);
        port.start?.();
        return () => port.removeEventListener?.('message', handler);
      }
      port.on?.('message', handler);
      port.start?.();
      return () => port.off?.('message', handler);
    },
  };
}
