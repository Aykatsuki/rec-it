import { describe, expect, it } from 'vitest';
import { History, emptyDocument, secondsToFlicks, type AssetLookup } from '@rec-it/core';
import { ClaudeService, GROUP_WINDOW_MS } from './claude-service';
import { searchWords } from './claude-tools';

const assets: AssetLookup = () => ({
  kind: 'video',
  duration: secondsToFlicks(10),
  hasAudio: true,
});

function setup() {
  const history = new History(emptyDocument());
  let now = 1_000_000;
  const service = new ClaudeService({
    userDataDir: '/nowhere',
    appVersion: 'test',
    enabled: () => true,
    now: () => now,
    tools: () => ({
      projectName: () => 'Test',
      doc: () => ({ doc: history.doc, version: history.version }),
      media: () => [],
      transcript: () => undefined,
      transcribed: () => new Set(),
      transcriptionAvailable: () => null,
      jobs: () => [],
      frame: () => Promise.reject(new Error('no frames here')),
      startTranscription: () => {},
      exportRunning: () => false,
      exportPath: (n) => n,
      startExport: () => {},
    }),
    execute: (command, group) => {
      const before = history.version;
      history.execute(command, assets, group);
      return { version: history.version, changed: history.version !== before };
    },
    topGroup: () => history.topGroup,
    undoGroup: () => history.undo(),
    setup: { bridgePath: null, bridgeExists: false, bundlePath: null },
    onChange: () => {},
  });
  return { service, history, advance: (ms: number) => (now += ms) };
}

describe('Claude change cards', () => {
  it('groups edits within a minute and starts a new card after a pause', async () => {
    const { service, history, advance } = setup();
    await service.call('create_sequence', { name: 'A' });
    advance(GROUP_WINDOW_MS - 1);
    await service.call('create_sequence', { name: 'B' });
    expect(service.state().changes).toHaveLength(1);
    expect(history.canUndo).toBe(true);
    advance(GROUP_WINDOW_MS + 1);
    await service.call('create_sequence', { name: 'C' });
    const changes = service.state().changes;
    expect(changes.map((c) => c.edits.length)).toEqual([1, 2]);
    expect(changes.map((c) => c.canUndo)).toEqual([true, false]);
    // Undo all of the newest card removes only its sequence.
    service.undoChange(changes[0]!.group);
    expect(history.doc.sequences.map((s) => s.name)).toEqual(['A', 'B']);
    expect(service.state().changes[1]!.canUndo).toBe(true);
  });

  it('starts a new card after the user keeps the changes', async () => {
    const { service } = setup();
    await service.call('create_sequence', { name: 'A' });
    service.keepChange(service.state().changes[0]!.group);
    await service.call('create_sequence', { name: 'B' });
    expect(service.state().changes.map((c) => c.state)).toEqual(['open', 'kept']);
  });

  it('records failures in the activity feed', async () => {
    const { service } = setup();
    const r = await service.call('get_frame', { time: 1 });
    expect(r.isError).toBe(true);
    expect(service.state().activity[0]).toMatchObject({ tool: 'get_frame', status: 'error' });
  });
});

describe('transcript search', () => {
  const w = (text: string, start: number) => ({
    key: `${start}`,
    itemId: 'i',
    assetId: 'a',
    index: 0,
    part: 0,
    text,
    start,
    end: start + 0.4,
    srcStart: start,
    srcEnd: start + 0.4,
  });
  const words = [
    w('So,', 0),
    w('you', 0.5),
    w('KNOW', 1),
    w('what?', 1.5),
    w('You', 2),
    w('know.', 2.5),
  ];

  it('finds phrases regardless of case and punctuation', () => {
    const hits = searchWords(words, 'you know');
    expect(hits.map((h) => [h.start, h.end])).toEqual([
      [0.5, 1.4],
      [2, 2.9],
    ]);
    expect(hits[0]!.context).toBe('So, you KNOW what? You know.');
  });
});
