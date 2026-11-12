import {
  CommandError,
  History,
  checkInvariants,
  emptyDocument,
  type AssetLookup,
  type Command,
  type ProjectDocument,
} from '@rec-it/core';
import type { ProjectDatabase } from '@rec-it/db';
import { projectDocumentSchema, type DocumentState } from '@rec-it/ipc-contract';

/**
 * The open project's timeline document. Every edit is a command applied through History
 * (exact undo/redo) and the whole document is written to the project file afterwards, so a
 * crash loses nothing that was done (ADR-025).
 */
export class DocumentService {
  private history: History;

  constructor(
    private readonly db: ProjectDatabase,
    private readonly assets: AssetLookup,
    private readonly onChange: (state: DocumentState) => void,
  ) {
    this.history = new History(this.load());
  }

  private load(): ProjectDocument {
    const raw = this.db.loadDocument();
    if (raw === null) return emptyDocument();
    const parsed = projectDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('the timeline in this project could not be read; starting with an empty one');
      return emptyDocument();
    }
    const doc = parsed.data as ProjectDocument;
    try {
      checkInvariants(doc);
    } catch (error) {
      console.error(`timeline invariant broken on load: ${String(error)}`);
    }
    return doc;
  }

  state(): DocumentState {
    return {
      doc: this.history.doc as DocumentState['doc'],
      version: this.history.version,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
  }

  execute(command: Command): DocumentState {
    const before = this.history.doc;
    this.history.execute(command, this.assets);
    if (this.history.doc !== before) this.persist();
    return this.state();
  }

  undo(): DocumentState {
    if (!this.history.canUndo) throw new CommandError('Nothing to undo.');
    this.history.undo();
    this.persist();
    return this.state();
  }

  redo(): DocumentState {
    if (!this.history.canRedo) throw new CommandError('Nothing to redo.');
    this.history.redo();
    this.persist();
    return this.state();
  }

  /** Names of sequences using any of these assets. */
  sequencesUsing(assetIds: string[]): string[] {
    const ids = new Set(assetIds);
    return this.history.doc.sequences
      .filter((s) => s.tracks.some((t) => t.items.some((i) => ids.has(i.assetId))))
      .map((s) => s.name);
  }

  private persist(): void {
    this.db.saveDocument(this.history.doc);
    this.onChange(this.state());
  }
}
