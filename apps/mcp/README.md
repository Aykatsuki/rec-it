# Rec-It MCP connector

Lets your own Claude app read and edit the project open in Rec-It (ADR-044). Claude's edits show
up live in Rec-It, form one undo step per request, and exports or transcriptions wait for your
OK in Rec-It.

Build it with `pnpm build:mcp`. That writes:

- `dist/recit-mcp.js`, the stdio MCP server in one file (Node 18+);
- `dist/rec-it.mcpb`, the same thing packed as a Claude Desktop extension.

## Connect

- **Claude Desktop**: open `rec-it.mcpb` (double-click it, or drag it onto Settings → Extensions)
  and choose Install.
- **Claude Code**: `claude mcp add rec-it -- node "<path to>/recit-mcp.js"`.
- **Manually**: add to `claude_desktop_config.json`:

  ```json
  { "mcpServers": { "rec-it": { "command": "node", "args": ["<path to>/recit-mcp.js"] } } }
  ```

Rec-It's Claude tab shows these with the real paths filled in, and copy buttons.

Rec-It must be running. The bridge finds it through `mcp-endpoint.json` in Rec-It's user-data
folder (set `RECIT_USER_DATA` if you moved it) and connects over a private named pipe or Unix
socket with a per-launch token. It opens no network port and keeps no data.
