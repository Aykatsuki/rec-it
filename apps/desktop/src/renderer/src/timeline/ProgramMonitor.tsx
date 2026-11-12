import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import { computeLayout, type Sequence, type TimelineItem, type Track } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { IconButton } from '@rec-it/ui';
import { itemEndSec, sequenceSeconds, toSeconds } from '../edit';
import { useApp } from '../store';
import { openContextMenu } from '../ui/ContextMenu';
import { clipMenu, programMenu } from './menus';
import { TransformOverlay, transformFor, type VisibleLayer } from './TransformOverlay';

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
 * Timeline preview (interim engine, ADR-025): one media element per clip near the playhead,
 * positioned with the same layout maths as export, kept in sync with a wall-clock playhead.
 * Frame-accurate WebCodecs compositing replaces this later in Phase 2.
 */
export function ProgramMonitor({ seq }: { seq: Sequence }) {
  const assets = useApp((s) => s.assets);
  const playhead = useApp((s) => s.playhead);
  const playing = useApp((s) => s.playing);
  const rate = useApp((s) => s.rate);
  const draft = useApp((s) => s.draftTransform);
  const well = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLMediaElement>());
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

  // Wall-clock playback.
  useEffect(() => {
    if (!playing) return;
    const t0 = useApp.getState().playhead;
    const started = performance.now();
    let raf = 0;
    const tick = () => {
      const t = t0 + ((performance.now() - started) / 1000) * rate;
      if (t >= total || t <= 0) {
        useApp.getState().setPlayhead(Math.min(total, Math.max(0, t)));
        useApp.getState().setPlaying(false);
        return;
      }
      useApp.getState().setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, rate]);

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
      el.volume = Math.min(1, m.item.volume);
      el.muted =
        m.item.muted || m.track.muted || (m.asset.kind === 'video' && !m.asset.probe?.audio);
      if (!active) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - local) > 0.05 && el.readyState > 0) el.currentTime = local;
        continue;
      }
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
        if (Math.abs(el.currentTime - local) > 0.01) el.currentTime = local;
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
        >
          <div className="program">
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
                    transformFor(m.item, draft),
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
                    visibility: visible ? ('visible' as const) : ('hidden' as const),
                  }
                : undefined;
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
          </div>
          <TransformOverlay
            seq={seq}
            box={box}
            layers={visibleLayers}
            onContextMenu={(e, itemId) =>
              openContextMenu(e, itemId ? clipMenu(seq, [itemId]) : programMenu(seq))
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
