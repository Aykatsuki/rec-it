import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import {
  computeLayout,
  sourceTimeAt,
  volumeAt,
  type Sequence,
  type TimelineItem,
  type Track,
  type Transform,
} from '@rec-it/core';
import { AudioEngine, audibleClips } from '../engine/audio-engine';
import {
  PreviewEngine,
  describeError,
  gpuPreviewSupported,
  type EngineLayer,
} from '../engine/preview-engine';
import { notify } from '../notifications';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { IconButton } from '@rec-it/ui';
import { itemEndSec, sequenceSeconds, toFlicks, toSeconds } from '../edit';
import { useApp } from '../store';
import { openContextMenu } from '../ui/ContextMenu';
import { clipMenu, programMenu } from './menus';
import { TransformOverlay, transformFor, type VisibleLayer } from './TransformOverlay';
import { CaptionsLayer } from '../engine/captions-layer';

interface Mounted {
  item: TimelineItem;
  track: Track;
  asset: MediaAsset;
  /** Index from the bottom layer up, for stacking order. */
  layer: number;
}

export function timecode(seconds: number): string {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Toggles timeline playback; starts again from the beginning when at the end. */
export function togglePlay(seq: Sequence | null): void {
  const { playing, playhead, setPlaying, setPlayhead } = useApp.getState();
  if (!seq) return;
  if (!playing && playhead >= sequenceSeconds(seq) - 0.01) setPlayhead(0);
  useApp.setState({ rate: 1 });
  setPlaying(!playing);
}

/**
 * J/K/L shuttle: L plays forward and speeds up on repeated presses (1×, 2×, 4×, 8×), J does the
 * same backwards, K stops.
 */
export function shuttle(seq: Sequence, key: 'j' | 'k' | 'l'): void {
  const { playing, rate, setPlaying } = useApp.getState();
  if (key === 'k') {
    setPlaying(false);
    return;
  }
  const dir = key === 'l' ? 1 : -1;
  const same = playing && Math.sign(rate) === dir;
  const next = same ? Math.min(8, Math.abs(rate) * 2) * dir : dir;
  if (!playing && dir > 0 && useApp.getState().playhead >= sequenceSeconds(seq) - 0.01)
    useApp.getState().setPlayhead(0);
  useApp.setState({ rate: next });
  setPlaying(true);
}

export function stepFrames(seq: Sequence, frames: number): void {
  const { playhead, setPlayhead, setPlaying } = useApp.getState();
  const frame = seq.fps.den / seq.fps.num;
  setPlaying(false);
  setPlayhead(Math.max(0, Math.round(playhead / frame + frames) * frame));
}

/**
 * Timeline preview. The GPU engine (ADR-029) decodes proxies with WebCodecs and composites with
 * WebGL2, frame-accurately; sound still plays through media elements kept in sync with the
 * playhead. The compatible engine (ADR-025) uses one media element per clip and is the fallback.
 */
export function ProgramMonitor({ seq }: { seq: Sequence }) {
  const assets = useApp((s) => s.assets);
  const playhead = useApp((s) => s.playhead);
  const playing = useApp((s) => s.playing);
  const rate = useApp((s) => s.rate);
  const draft = useApp((s) => s.draftTransform);
  const engineChoice = useApp((s) => s.previewEngine);
  const gpuFailed = useApp((s) => s.gpuFailed);
  const gpu = engineChoice === 'gpu' && !gpuFailed && gpuSupported;
  const well = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLMediaElement>());
  /** Clips that were on screen at the last sync, to spot ones that have just appeared. */
  const shown = useRef(new Set<string>());
  const [box, setBox] = useState({ w: 0, h: 0 });
  const total = sequenceSeconds(seq);

  useLayoutEffect(() => {
    const el = well.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      const scale = Math.min(width / seq.width, height / seq.height);
      setBox({ w: Math.floor(seq.width * scale), h: Math.floor(seq.height * scale) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [seq.width, seq.height]);

  // Sound for the GPU engine: Web Audio, whose clock drives the playhead (ADR-030).
  const audio = useRef<AudioEngine | null>(null);
  useEffect(() => {
    audio.current = new AudioEngine();
    return () => {
      audio.current?.dispose();
      audio.current = null;
    };
  }, []);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const clips = useMemo(
    () =>
      audibleClips(seq, (item) => {
        const a = byId.get(item.assetId);
        if (!a?.urls.proxy) return undefined;
        return a.kind === 'audio' || (a.kind === 'video' && a.probe?.audio)
          ? a.urls.proxy
          : undefined;
      }),
    [seq, byId],
  );
  const webAudio = gpu && rate === 1;

  // Debug/test hook: render the preview's audio offline (compared with the export in tests).
  useEffect(() => {
    (window as unknown as { recitDebug?: unknown }).recitDebug = {
      renderAudio: async (from: number, duration: number) => {
        const buffer = await audio.current!.renderOffline(clips, from, duration);
        const window = 480; // 10 ms at 48 kHz
        const a = buffer.getChannelData(0);
        const b = buffer.getChannelData(1);
        const out: number[] = [];
        for (let i = 0; i + window <= a.length; i += window) {
          let sum = 0;
          for (let j = i; j < i + window; j++) sum += ((a[j]! + b[j]!) / 2) ** 2;
          out.push(Math.sqrt(sum / window));
        }
        return out;
      },
    };
  }, [clips]);

  // Playback clock: Web Audio's clock in the GPU engine at normal speed, otherwise the wall
  // clock (the compatible engine, and J/K/L at other speeds, which play without sound).
  useEffect(() => {
    if (!playing) return;
    const t0 = useApp.getState().playhead;
    const started = performance.now();
    const engine = audio.current;
    if (webAudio && engine) void engine.play(clips, t0);
    let raf = 0;
    const tick = () => {
      const t =
        webAudio && engine?.playing
          ? engine.now()
          : t0 + ((performance.now() - started) / 1000) * rate;
      // (t <= 0 only ends reverse playback: the audio clock reads 0 until sound starts.)
      if (t >= total || (rate < 0 && t <= 0)) {
        useApp.getState().setPlayhead(Math.min(total, Math.max(0, t)));
        useApp.getState().setPlaying(false);
        return;
      }
      useApp.getState().setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      engine?.stop();
    };
    // `clips`: an edit while playing restarts the sound from the current position.
  }, [playing, total, rate, webAudio, clips]);

  // Clips near the playhead are mounted ahead of time so they are ready to play.
  const mounted = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a]));
    const list: Mounted[] = [];
    const videoTracks = seq.tracks.filter((t) => t.kind === 'video').reverse();
    const audioTracks = seq.tracks.filter((t) => t.kind === 'audio');
    [...videoTracks, ...audioTracks].forEach((track, layer) => {
      for (const item of track.items) {
        const asset = byId.get(item.assetId);
        if (!asset) continue;
        if (playhead >= toSeconds(item.start) - 2 && playhead <= itemEndSec(item) + 0.5)
          list.push({ item, track, asset, layer });
      }
    });
    return list;
  }, [assets, seq, playhead]);

  // Keep every media element in step with the playhead.
  useEffect(() => {
    for (const m of mounted) {
      const el = elements.current.get(m.item.id);
      if (!el) continue;
      const start = toSeconds(m.item.start);
      const active = playhead >= start && playhead < itemEndSec(m.item);
      const local = toSeconds(m.item.sourceIn) + Math.max(0, playhead - start);
      // Paused seeks aim a quarter-frame into the frame: a frame's timestamp often rounds to just
      // under its nominal time, and seeking exactly onto it shows the previous frame.
      const fps = m.asset.probe?.video?.fps;
      const still = local + (fps && fps.num > 0 ? (0.25 * fps.den) / fps.num : 0.008);
      el.volume = Math.min(1, volumeAt(m.item, toFlicks(playhead)));
      el.muted =
        m.item.muted || m.track.muted || (m.asset.kind === 'video' && !m.asset.probe?.audio);
      if (!active) {
        shown.current.delete(m.item.id);
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - still) > 0.05 && el.readyState > 0) el.currentTime = still;
        continue;
      }
      const appeared = !shown.current.has(m.item.id);
      shown.current.add(m.item.id);
      if (playing && rate > 0) {
        if (el.playbackRate !== rate) el.playbackRate = rate;
        if (el.paused) {
          el.currentTime = local;
          void el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - local) > 0.25) {
          el.currentTime = local;
        }
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - still) > 0.005) el.currentTime = still;
        if (appeared && el instanceof HTMLVideoElement) {
          // A paused video that was seeked while invisible can keep showing an old frame when it
          // appears. Seeking once more after it is on screen makes Chromium paint the right one.
          // (A seek to the current time is ignored, so aim 1 ms further, still inside the frame.)
          const again = () =>
            requestAnimationFrame(() => {
              if (el.paused) el.currentTime = still + 0.001;
            });
          if (el.seeking) el.addEventListener('seeked', again, { once: true });
          else again();
        }
      }
    }
  }, [mounted, playhead, playing, rate]);

  const visibleLayers: VisibleLayer[] = mounted.flatMap((m) => {
    const v = m.asset.probe?.video;
    const start = toSeconds(m.item.start);
    const active = playhead >= start && playhead < itemEndSec(m.item);
    if (!v || !active || m.track.kind !== 'video' || m.track.hidden || m.asset.kind === 'audio')
      return [];
    return [
      { item: m.item, track: m.track, srcW: v.displayWidth, srcH: v.displayHeight, layer: m.layer },
    ];
  });

  const register = (id: string) => (el: HTMLMediaElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  };

  return (
    <>
      <div className="preview__well" ref={well}>
        <div
          className="program-stage"
          style={{ width: box.w, height: box.h }}
          data-testid="program-monitor"
          data-engine={gpu ? 'gpu' : 'compatible'}
        >
          <div className="program">
            {gpu && (
              <GpuCanvas
                seq={seq}
                mounted={mounted}
                playhead={playhead}
                playing={playing}
                draft={draft}
                box={box}
                onFail={(error) => {
                  const detail = describeError(error);
                  console.error('GPU preview failed', error);
                  useApp.setState({ gpuFailed: detail });
                  notify(
                    `The GPU preview stopped (${detail}). Using the compatible preview — right-click the preview → Preview engine to try the GPU again.`,
                    'warn',
                  );
                }}
              />
            )}
            {mounted.map((m) => {
              const start = toSeconds(m.item.start);
              const active = playhead >= start && playhead < itemEndSec(m.item);
              const visible = active && m.track.kind === 'video' && !m.track.hidden;
              const v = m.asset.probe?.video;
              const layout = v
                ? computeLayout(
                    v.displayWidth,
                    v.displayHeight,
                    seq.width,
                    seq.height,
                    transformFor(m.item, draft, playhead),
                  )
                : null;
              const style = layout
                ? {
                    left: `${(layout.left / seq.width) * 100}%`,
                    top: `${(layout.top / seq.height) * 100}%`,
                    width: `${(layout.width / seq.width) * 100}%`,
                    height: `${(layout.height / seq.height) * 100}%`,
                    zIndex: m.layer,
                    transform: layout.rotation ? `rotate(${layout.rotation}deg)` : undefined,
                    // Opacity, not visibility: Chromium does not repaint a hidden video after a seek.
                    opacity: visible ? 1 : 0,
                  }
                : undefined;
              // The GPU engine draws pictures and Web Audio plays the sound.
              if (gpu) return null;
              if (m.asset.kind === 'image') {
                const src = m.asset.urls.still ?? m.asset.urls.poster;
                return src ? (
                  <img key={m.item.id} className="program__layer" src={src} alt="" style={style} />
                ) : null;
              }
              if (m.asset.kind === 'audio' || m.track.kind === 'audio') {
                return m.asset.urls.proxy ? (
                  <audio
                    key={m.item.id}
                    ref={register(m.item.id)}
                    src={m.asset.urls.proxy}
                    preload="auto"
                  />
                ) : null;
              }
              return m.asset.urls.proxy ? (
                <video
                  key={m.item.id}
                  ref={register(m.item.id)}
                  className="program__layer"
                  src={m.asset.urls.proxy}
                  preload="auto"
                  playsInline
                  style={style}
                />
              ) : null;
            })}
            <CaptionsLayer seq={seq} playhead={playhead} box={box} />
          </div>
          <TransformOverlay
            seq={seq}
            box={box}
            layers={visibleLayers}
            onContextMenu={(e, itemId) =>
              openContextMenu(
                e,
                itemId
                  ? [...clipMenu(seq, [itemId]), { separator: true }, ...programMenu(seq)]
                  : programMenu(seq),
              )
            }
          />
        </div>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(total, 0.01)}
        step={seq.fps.den / seq.fps.num}
        value={Math.min(playhead, total)}
        aria-label="Timeline position"
        onChange={(e) => {
          useApp.getState().setPlaying(false);
          useApp.getState().setPlayhead(Number(e.target.value));
        }}
        style={{ ['--pct' as string]: `${total ? (Math.min(playhead, total) / total) * 100 : 0}%` }}
      />
      <footer className="transport">
        <span className="transport__time" data-testid="program-time">
          <span className="transport__now">{timecode(playhead)}</span>
          <span className="transport__sep">/</span>
          {timecode(total)}
        </span>
        <div className="transport__controls">
          <IconButton
            label="Go to start (Home)"
            size="sm"
            onClick={() => useApp.getState().setPlayhead(0)}
          >
            <SkipBack size={15} />
          </IconButton>
          <IconButton label="Back one frame (←)" size="sm" onClick={() => stepFrames(seq, -1)}>
            <StepBack size={15} />
          </IconButton>
          <IconButton
            label={playing ? 'Pause (Space)' : 'Play (Space)'}
            onClick={() => togglePlay(seq)}
            disabled={total <= 0}
            data-testid="program-play"
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
          <IconButton label="Forward one frame (→)" size="sm" onClick={() => stepFrames(seq, 1)}>
            <StepForward size={15} />
          </IconButton>
          <IconButton
            label="Go to end (End)"
            size="sm"
            onClick={() => useApp.getState().setPlayhead(total)}
          >
            <SkipForward size={15} />
          </IconButton>
        </div>
        <IconButton
          label="Full screen"
          size="sm"
          onClick={() => void well.current?.requestFullscreen()}
        >
          <Maximize2 size={14} />
        </IconButton>
      </footer>
    </>
  );
}

const gpuSupported = gpuPreviewSupported();

function GpuCanvas({
  seq,
  mounted,
  playhead,
  playing,
  draft,
  box,
  onFail,
}: {
  seq: Sequence;
  mounted: Mounted[];
  playhead: number;
  playing: boolean;
  draft: { itemId: string; transform: Transform } | null;
  box: { w: number; h: number };
  onFail: (error: unknown) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<PreviewEngine | null>(null);
  const failed = useRef(false);
  // Bumped when the graphics context is restored, to draw again.
  const [restored, setRestored] = useState(0);
  const fail = (error: unknown) => {
    if (failed.current) return;
    failed.current = true;
    onFail(error);
  };

  useEffect(() => {
    try {
      engine.current = new PreviewEngine(canvas.current!, () => setRestored((n) => n + 1));
    } catch (error) {
      fail(error);
    }
    return () => {
      engine.current?.dispose();
      engine.current = null;
    };
    // The engine lives as long as the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const e = engine.current;
    if (!e || !box.w || !box.h) return;
    const now = toFlicks(playhead);
    const layers: EngineLayer[] = [];
    for (const m of [...mounted].sort((a, b) => a.layer - b.layer)) {
      const active = now >= m.item.start && now < m.item.start + m.item.duration;
      const v = m.asset.probe?.video;
      if (!active || m.track.kind !== 'video' || m.track.hidden || !v) continue;
      const transform = transformFor(m.item, draft, playhead);
      if (m.asset.kind === 'image') {
        const url = m.asset.urls.still ?? m.asset.urls.poster;
        if (url)
          layers.push({
            key: m.item.id,
            kind: 'image',
            url,
            sourceTime: 0,
            width: v.displayWidth,
            height: v.displayHeight,
            transform,
          });
      } else if (m.asset.kind === 'video' && m.asset.urls.proxy) {
        layers.push({
          key: m.item.id,
          kind: 'video',
          url: m.asset.urls.proxy,
          sourceTime: toSeconds(sourceTimeAt(m.item, now)),
          width: v.displayWidth,
          height: v.displayHeight,
          transform,
        });
      }
    }
    e.retain(new Set(mounted.map((m) => m.item.id)));
    const dpr = window.devicePixelRatio || 1;
    const at = playhead.toFixed(3);
    e.render(
      { width: seq.width, height: seq.height },
      layers,
      { w: Math.round(box.w * dpr), h: Math.round(box.h * dpr) },
      playing,
    )
      .then((drawn) => {
        if (drawn && canvas.current) canvas.current.dataset.time = at;
      })
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, mounted, playhead, playing, draft, box, restored]);

  return <canvas ref={canvas} className="program__canvas" data-testid="program-canvas" />;
}
