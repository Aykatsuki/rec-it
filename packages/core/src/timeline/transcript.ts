// Text-based editing (Phase 4, ADR-031/032): maps word-timed transcripts (source seconds) onto
// the clips of a sequence, applies the user's corrections, and turns a selection of words into
// cut commands.
import { FLICKS_PER_SECOND, frameDuration } from '../time';
import type { Command } from './commands';
import type { Sequence, TimelineItem, TranscriptEdits } from './model';

/** One recognised word. Times are seconds in the media file. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  p?: number;
}

/** A transcript word after corrections. */
export interface EditedWord extends TranscriptWord {
  /** Index of the recognised word this comes from. */
  index: number;
  /** Position within a correction that turned one word into several. */
  part: number;
  /** Whisper's own text, when corrected. */
  original?: string;
  /** Corrected to nothing: kept in the transcript, left out of captions. */
  hidden?: boolean;
}

/** A word as it plays in the sequence. */
export interface SequenceWord {
  /** Stable key: item id, word index and part. */
  key: string;
  itemId: string;
  assetId: string;
  /** Index into the asset's recognised words. */
  index: number;
  part: number;
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  /** Source seconds (for cutting). */
  srcStart: number;
  srcEnd: number;
  p?: number;
  original?: string;
  hidden?: boolean;
}

const sec = (f: number) => f / FLICKS_PER_SECOND;

/**
 * Applies corrections to a transcript. A correction with several words shares the original
 * word's time between them by length; one whose `from` no longer matches (the media was
 * transcribed again) is ignored.
 */
export function applyTranscriptEdits(
  words: readonly TranscriptWord[],
  edits: TranscriptEdits[string] | undefined,
): EditedWord[] {
  const out: EditedWord[] = [];
  words.forEach((w, index) => {
    const edit = edits?.[index];
    if (!edit || edit.from !== w.text) {
      out.push({ ...w, index, part: 0 });
      return;
    }
    const parts = edit.to.split(' ').filter(Boolean);
    if (!parts.length) {
      out.push({ ...w, index, part: 0, original: w.text, hidden: true });
      return;
    }
    const total = parts.reduce((n, t) => n + t.length, 0);
    let t = w.start;
    parts.forEach((text, part) => {
      const end = part === parts.length - 1 ? w.end : t + ((w.end - w.start) * text.length) / total;
      out.push({ ...w, text, start: t, end, index, part, original: w.text });
      t = end;
    });
  });
  return out;
}

/**
 * The words heard in a sequence, in timeline order. A word belongs to a clip when its middle is
 * inside the part of the media the clip shows. Linked clips (a video and its detached sound) and
 * identical copies on other tracks contribute their words once.
 */
export function sequenceWords(
  seq: Sequence,
  wordsOf: (assetId: string) => readonly EditedWord[] | undefined,
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
      if (item.muted) continue;
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
export function wordsInItem(item: TimelineItem, words: readonly EditedWord[]): SequenceWord[] {
  const from = sec(item.sourceIn);
  const to = sec(item.sourceIn + item.duration);
  const offset = sec(item.start) - from;
  const out: SequenceWord[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (mid < from || mid >= to) continue;
    const srcStart = Math.max(w.start, from);
    const srcEnd = Math.min(w.end, to);
    out.push({
      key: `${item.id}:${w.index}.${w.part}`,
      itemId: item.id,
      assetId: item.assetId,
      index: w.index,
      part: w.part,
      text: w.text,
      start: srcStart + offset,
      end: srcEnd + offset,
      srcStart,
      srcEnd,
      ...(w.p !== undefined ? { p: w.p } : {}),
      ...(w.original !== undefined ? { original: w.original } : {}),
      ...(w.hidden ? { hidden: true } : {}),
    });
  }
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
  for (const [itemId, list] of byItem) {
    for (let i = 0; i < list.length; i++) {
      if (!selected.has(list[i]!.key)) continue;
      let j = i;
      while (j + 1 < list.length && selected.has(list[j + 1]!.key)) j++;
      const next = list[j + 1];
      const from = list[i]!.srcStart;
      const to = next ? next.srcStart : list[j]!.srcEnd;
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
