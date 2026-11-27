// Films low-poly 3D Shorts when the backend asks (ADR-054). Always mounted: the backend's job
// sends a spec, this films it frame by frame and streams JPEG frames back.
import { useEffect } from 'react';
import { backend } from '../api';
import { film } from './film';

let queue: Promise<void> = Promise.resolve();

export function LowPolyHost() {
  useEffect(
    () =>
      backend.on('lowpoly.render', ({ request, spec }) => {
        queue = queue.then(async () => {
          try {
            await film(spec, {
              onFrames: async (frames) =>
                (await backend.invoke('lowpoly.frames', { request, frames })).ok,
            });
            await backend.invoke('lowpoly.finished', { request });
          } catch (e) {
            await backend
              .invoke('lowpoly.finished', {
                request,
                error: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
              })
              .catch(() => undefined);
          }
        });
      }),
    [],
  );
  return null;
}
