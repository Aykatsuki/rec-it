import { z } from 'zod';

/** One tool call Claude made (the activity feed, ADR-044). */
export const claudeActivitySchema = z.object({
  id: z.string(),
  /** Epoch milliseconds. */
  at: z.number(),
  tool: z.string(),
  title: z.string(),
  /** Short, human description of what happened (or why it failed). */
  detail: z.string(),
  status: z.enum(['ok', 'error', 'denied', 'pending']),
  /** The change card (undo group) an edit belongs to. */
  group: z.string().optional(),
});
export type ClaudeActivity = z.output<typeof claudeActivitySchema>;

/** A set of Claude's edits the user can undo in one step or keep. */
export const claudeChangeSchema = z.object({
  group: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  edits: z.array(z.string()),
  state: z.enum(['open', 'kept', 'undone']),
  /** Still the newest undo step (Undo all works only then). */
  canUndo: z.boolean(),
});
export type ClaudeChange = z.output<typeof claudeChangeSchema>;

/** A long-running or outward-facing tool waiting for the user's OK. */
export const claudeConfirmationSchema = z.object({
  id: z.string(),
  tool: z.string(),
  title: z.string(),
  detail: z.string(),
});
export type ClaudeConfirmation = z.output<typeof claudeConfirmationSchema>;

export const claudeStateSchema = z.object({
  /** The AI switch in Settings. */
  enabled: z.boolean(),
  /** The connector endpoint is listening. */
  listening: z.boolean(),
  /** Connected Claude apps (MCP bridges). */
  clients: z.array(z.object({ id: z.string(), name: z.string(), since: z.number() })),
  /** Setup details for the Claude tab: how to add Rec-It to Claude Desktop / Claude Code. */
  setup: z.object({
    bridgePath: z.string().nullable(),
    bridgeExists: z.boolean(),
    bundlePath: z.string().nullable(),
  }),
  error: z.string().optional(),
  activity: z.array(claudeActivitySchema),
  changes: z.array(claudeChangeSchema),
  confirmations: z.array(claudeConfirmationSchema),
});
export type ClaudeState = z.output<typeof claudeStateSchema>;
