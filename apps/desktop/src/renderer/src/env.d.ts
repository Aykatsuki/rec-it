import type { RecitBridge } from '../../shared/bridge';

declare global {
  interface Window {
    recit: RecitBridge;
  }
}
