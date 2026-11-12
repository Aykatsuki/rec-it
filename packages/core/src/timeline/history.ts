import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { applyCommand, checkInvariants, type Command } from './commands';
import type { AssetLookup, ProjectDocument } from './model';

enablePatches();

interface Entry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
}

/** Applies commands immutably and keeps exact undo/redo using Immer patches (ARCHITECTURE §7). */
export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  version = 0;

  constructor(
    public doc: ProjectDocument,
    private readonly limit = 200,
  ) {}

  execute(command: Command, assets: AssetLookup): ProjectDocument {
    const [next, patches, inverse] = produceWithPatches(this.doc, (draft) => {
      applyCommand(draft as ProjectDocument, command, assets);
    });
    if (!patches.length) return this.doc;
    checkInvariants(next);
    this.doc = next;
    this.undoStack.push({ label: command.type, patches, inverse });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.version++;
    return next;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): ProjectDocument {
    const entry = this.undoStack.pop();
    if (!entry) return this.doc;
    this.doc = applyPatches(this.doc, entry.inverse);
    this.redoStack.push(entry);
    this.version++;
    return this.doc;
  }

  redo(): ProjectDocument {
    const entry = this.redoStack.pop();
    if (!entry) return this.doc;
    this.doc = applyPatches(this.doc, entry.patches);
    this.undoStack.push(entry);
    this.version++;
    return this.doc;
  }
}
