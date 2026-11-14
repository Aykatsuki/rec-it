import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { applyCommand, checkInvariants, type Command } from './commands';
import type { AssetLookup, ProjectDocument } from './model';

enablePatches();

interface Entry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Edits sharing a group (e.g. one Claude request, ADR-044) are undone together. */
  group?: string;
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

  /**
   * Applies a command as one undo step. With `group`, it joins the previous step when that step
   * has the same group (so several edits of one Claude request are undone together).
   */
  execute(command: Command, assets: AssetLookup, group?: string): ProjectDocument {
    const [next, patches, inverse] = produceWithPatches(this.doc, (draft) => {
      applyCommand(draft as ProjectDocument, command, assets);
    });
    if (!patches.length) return this.doc;
    checkInvariants(next);
    this.doc = next;
    const top = this.undoStack.at(-1);
    if (group && top?.group === group && !this.redoStack.length) {
      top.patches = [...top.patches, ...patches];
      top.inverse = [...inverse, ...top.inverse];
      this.version++;
      return next;
    }
    this.undoStack.push({ label: command.type, patches, inverse, ...(group ? { group } : {}) });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.version++;
    return next;
  }

  /** The group of the step Undo would revert, if any. */
  get topGroup(): string | undefined {
    return this.undoStack.at(-1)?.group;
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
