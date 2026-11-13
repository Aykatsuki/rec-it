// Captions in the preview (ADR-011, ADR-032): libass compiled to WebAssembly (JASSUB) draws the
// same ASS file, with the same bundled fonts, that FFmpeg's `ass` filter burns into the export.
import { useEffect, useMemo, useRef, useState } from 'react';
import JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import wasmWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url';
import modernWasmWorkerUrl from 'jassub/dist/wasm/jassub-worker-modern.js?url';
import { FONT_FILES, sequenceCaptionsAss } from '@rec-it/captions';
import type { Sequence } from '@rec-it/core';
import { useApp } from '../store';

// The bundled fonts (resources/fonts), as URLs the worker can fetch.
const fontUrls = import.meta.glob('../../../../../../resources/fonts/*.ttf', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const urlOf = (file: string) =>
  Object.entries(fontUrls).find(([path]) => path.endsWith(`/${file}`))?.[1];

/** An ASS file with no events: clears the canvas when captions are off. */
const EMPTY =
  '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

/**
 * The sequence's caption clips as ASS. While a caption is being dragged in the preview, its draft
 * transform is used, so the text follows the mouse.
 */
export function useCaptionsAss(seq: Sequence): string | null {
  const draft = useApp((s) => s.draftTransform);
  return useMemo(() => {
    const isCaption =
      draft &&
      seq.tracks.some((t) => t.kind === 'caption' && t.items.some((i) => i.id === draft.itemId));
    const shown = isCaption
      ? {
          ...seq,
          tracks: seq.tracks.map((t) => ({
            ...t,
            items: t.items.map((i) =>
              i.id === draft.itemId ? { ...i, transform: draft.transform } : i,
            ),
          })),
        }
      : seq;
    return sequenceCaptionsAss(shown);
  }, [seq, draft]);
}

export function CaptionsLayer({
  seq,
  ass,
  playhead,
  box,
}: {
  seq: Sequence;
  ass: string;
  playhead: number;
  box: { w: number; h: number };
}) {
  // JASSUB takes over its canvas (it moves it to a worker and removes it when destroyed), so
  // the canvas is created here, inside a container React owns, never by React itself. A canvas
  // can only be handed to a worker once, so each mount (StrictMode mounts twice) gets a new one.
  const container = useRef<HTMLDivElement>(null);
  const jassub = useRef<JASSUB | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // One renderer per canvas (a canvas can only be handed to a worker once).
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const el = document.createElement('canvas');
    el.className = 'program__captions-canvas';
    host.appendChild(el);
    let alive = true;
    const fonts = Object.values(FONT_FILES)
      .map(urlOf)
      .filter((u): u is string => !!u);
    const availableFonts = Object.fromEntries(
      Object.entries(FONT_FILES)
        .map(([family, file]) => [family.toLowerCase(), urlOf(file)] as const)
        .filter((e): e is readonly [string, string] => !!e[1]),
    );
    try {
      const instance = new JASSUB({
        canvas: el,
        subContent: EMPTY,
        workerUrl,
        wasmUrl,
        modernWasmUrl,
        wasmWorkerUrl,
        modernWasmWorkerUrl,
        fonts,
        availableFonts,
        defaultFont: 'montserrat extrabold',
        // Only the bundled fonts, so the preview matches the export on every computer.
        queryFonts: false,
        prescaleHeightLimit: 4096,
      });
      jassub.current = instance;
      instance.ready.then(
        () => alive && setReady(true),
        (e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)),
      );
    } catch (e) {
      // WebAssembly or OffscreenCanvas unavailable: the preview simply has no captions.
      console.error('Caption preview failed:', e);
    }
    return () => {
      alive = false;
      setReady(false);
      const j = jassub.current;
      jassub.current = null;
      if (j) void j.destroy().catch(() => {});
      el.remove();
    };
  }, []);

  useEffect(() => {
    if (failed) console.error('Caption preview failed:', failed);
  }, [failed]);

  // New captions file.
  useEffect(() => {
    const j = jassub.current;
    if (!ready || !j) return;
    void (async () => {
      await j.renderer.setTrack(ass);
      await j.manualRender(
        {
          mediaTime: useApp.getState().playhead,
          width: seq.width,
          height: seq.height,
          expectedDisplayTime: 0,
        },
        true,
      );
    })().catch((e: unknown) => console.error('Caption preview failed:', e));
  }, [ass, ready, seq.width, seq.height]);

  // Each new playhead position (playback, scrubbing) and size change redraws.
  useEffect(() => {
    const j = jassub.current;
    if (!ready || !j || !box.w) return;
    j.manualRender(
      { mediaTime: playhead, width: seq.width, height: seq.height, expectedDisplayTime: 0 },
      true,
    )
      .then(() => {
        if (container.current) container.current.dataset.time = playhead.toFixed(3);
      })
      .catch((e: unknown) => console.error('Caption preview failed:', e));
  }, [ready, playhead, box.w, box.h, seq.width, seq.height]);

  return (
    <div
      ref={container}
      className="program__captions"
      data-testid="captions-canvas"
      data-ready={ready ? 'true' : 'false'}
    />
  );
}
