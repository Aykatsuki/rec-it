// The .mcpb manifest (Claude Desktop's one-click install), generated from the tool catalogue so
// the two can never disagree. ADR-044.
import { PROMPTS, TOOLS } from '@rec-it/tools';
import { VERSION } from './connection';

export const manifest = {
  manifest_version: '0.3',
  name: 'rec-it',
  display_name: 'Rec-It',
  version: VERSION,
  description:
    'Edit the video project open in Rec-It: cut silences, caption, frame and export Shorts.',
  long_description:
    'Connects Claude to Rec-It, the free and open-source video editor for YouTube Shorts. Claude can read the open project (timeline, transcripts, frames) and make undoable edits that you watch happen live. Exports and transcriptions ask for your OK in Rec-It first. Rec-It must be running; it talks to this extension over a private local connection only.',
  author: { name: 'Rec-It contributors', url: 'https://github.com/Aykatsuki/rec-it' },
  repository: { type: 'git', url: 'https://github.com/Aykatsuki/rec-it' },
  homepage: 'https://github.com/Aykatsuki/rec-it',
  support: 'https://github.com/Aykatsuki/rec-it/issues',
  license: 'GPL-3.0-or-later',
  keywords: ['video', 'editor', 'youtube', 'shorts', 'captions'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
  },
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  prompts: PROMPTS.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments.map((a) => a.name),
    text: p.text(Object.fromEntries(p.arguments.map((a) => [a.name, `\${arguments.${a.name}}`]))),
  })),
  compatibility: {
    platforms: ['win32', 'darwin', 'linux'],
    runtimes: { node: '>=18.0.0' },
  },
};
