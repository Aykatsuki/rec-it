// Text-based editing (Phase 4, ADR-031): maps word-timed transcripts (source seconds) onto the
// clips of a sequence, and turns a selection of words into cut commands.
import { FLICKS_PER_SECOND, frameDuration } from '../time';
import type { Command } from './commands';
import type { Sequence, TimelineItem } from './model';

/** One recognised word. Times are seconds in the media file. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  p?: number;
}

/** A word as it plays in the sequence. */
export interface SequenceWord {
  /** Stable key: item id + word index in the asset's transcript. */
  key: string;
  itemId: string;
  /** Index into the asset's word list. */
  index: number;
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  p?: number;
}

const sec = (f: number) => f / FLICKS_PER_SECOND;

/**
 * The words heard in a sequence, in timeline order. A word belongs to a clip when its middle is
 * inside the part of the media the clip shows. Linked clips (a video and its detached sound) and
 * identical copies on other tracks contribute their words once.
 */
export function sequenceWords(
  seq: Sequence,
  wordsOf: (assetId: string) => readonly TranscriptWord[] | undefined,
): SequenceWord[] {
  const out: SequenceWord[] = [];
  const seenLinks = new Set<string>();
  const seenCopies = new Set<string>();
  const tracks = [
    ...seq.tracks.filter((t) => t.kind === 'audio'),
    ...seq.tracks.filter((t) => t.kind === 'video'),
  ];
  for (const track of tracks) {
    if (track.muted) continue;
    for (const item of track.items) {
      const words = wordsOf(item.assetId);
      if (!words?.length) continue;
      if (item.linkId) {
        if (seenLinks.has(item.linkId)) continue;
        seenLinks.add(item.linkId);
      }
      const copy = `${item.assetId}:${item.start}:${item.sourceIn}`;
      if (seenCopies.has(copy)) continue;
      seenCopies.add(copy);
      out.push(...wordsInItem(item, words));
    }
  }
  return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

/** Words of one clip, in timeline seconds. */
export function wordsInItem(item: TimelineItem, words: readonly TranscriptWord[]): SequenceWord[] {
  const from = sec(item.sourceIn);
  const to = sec(item.sourceIn + item.duration);
  const offset = sec(item.start) - from;
  const out: SequenceWord[] = [];
  words.forEach((w, index) => {
    const mid = (w.start + w.end) / 2;
    if (mid < from || mid >= to) return;
    out.push({
      key: `${item.id}:${index}`,
      itemId: item.id,
      index,
      text: w.text,
      start: Math.max(w.start, from) + offset,
      end: Math.min(w.end, to) + offset,
      ...(w.p !== undefined ? { p: w.p } : {}),
    });
  });
  return out;
}

/**
 * Commands that cut the selected words out of their clips. Each run of neighbouring selected words
 * is cut from the first word's start to the next kept word's start, so the pause after them goes
 * too. Runs are cut from the end of the sequence backwards, so earlier positions stay valid.
 */
export function cutWordsCommands(
  seq: Sequence,
  words: readonly SequenceWord[],
  selected: ReadonlySet<string>,
  wordsOf: (assetId: string) => readonly TranscriptWord[] | undefined,
  ripple = true,
): Extract<Command, { type: 'item.cutRange' }>[] {
  const frame = sec(frameDuration(seq.fps));
  const runs: { itemId: string; from: number; to: number; at: number }[] = [];
  const byItem = new Map<string, SequenceWord[]>();
  for (const w of words) {
    const list = byItem.get(w.itemId) ?? [];
    list.push(w);
    byItem.set(w.itemId, list);
  }
  const items = new Map(seq.tracks.flatMap((t) => t.items.map((i) => [i.id, i] as const)));
  for (const [itemId, list] of byItem) {
    const item = items.get(itemId);
    const source = item && wordsOf(item.assetId);
    if (!item || !source) continue;
    const end = sec(item.sourceIn + item.duration);
    for (let i = 0; i < list.length; i++) {
      if (!selected.has(list[i]!.key)) continue;
      let j = i;
      while (j + 1 < list.length && selected.has(list[j + 1]!.key)) j++;
      const first = source[list[i]!.index]!;
      const next = list[j + 1];
      const from = Math.max(first.start, sec(item.sourceIn));
      const to = next ? source[next.index]!.start : Math.min(end, source[list[j]!.index]!.end);
      if (to - from >= frame) runs.push({ itemId, from, to, at: list[i]!.start });
      i = j;
    }
  }
  runs.sort((a, b) => b.at - a.at);
  return runs.map((r) => ({
    type: 'item.cutRange' as const,
    sequenceId: seq.id,
    itemId: r.itemId,
    from: Math.round(r.from * FLICKS_PER_SECOND),
    to: Math.round(r.to * FLICKS_PER_SECOND),
    ripple,
  }));
}

/** The word playing at `t` (timeline seconds), if any. */
export function wordAt(words: readonly SequenceWord[], t: number): SequenceWord | undefined {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid]!;
    if (t < w.start) hi = mid - 1;
    else if (t >= w.end) lo = mid + 1;
    else return w;
  }
  return undefined;
}
