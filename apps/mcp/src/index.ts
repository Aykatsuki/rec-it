// Rec-It's MCP connector (ARCHITECTURE §13, ADR-044). The user's Claude app (Claude Desktop,
// Claude Code) starts this over stdio. It lists Rec-It's tools and prompts itself, so they show
// up even while Rec-It is closed, and forwards tool calls to the running app over a local,
// token-protected pipe. It holds no state and needs no network access.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { INSTRUCTIONS, PROMPTS, TOOLS, annotations, inputJsonSchema } from '@rec-it/tools';
import { RecItConnection, VERSION } from './connection';

const connection = new RecItConnection({
  clientName: () => {
    const info = server.getClientVersion();
    return info ? `${info.name} ${info.version}` : 'Claude';
  },
});

const server = new Server(
  { name: 'rec-it', title: 'Rec-It', version: VERSION },
  { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: inputJsonSchema(t) as { type: 'object' },
    annotations: annotations(t),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  try {
    return (await connection.call(
      request.params.name,
      request.params.arguments ?? {},
    )) as CallToolResult;
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: PROMPTS.map((p) => ({
    name: p.name,
    title: p.title,
    description: p.description,
    arguments: p.arguments,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, (request) => {
  const prompt = PROMPTS.find((p) => p.name === request.params.name);
  if (!prompt) throw new Error(`Unknown prompt ${request.params.name}`);
  return {
    description: prompt.description,
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: prompt.text(request.params.arguments ?? {}) },
      },
    ],
  };
});

// Once the Claude app has introduced itself, connect so Rec-It can show who is connected;
// retried quietly while Rec-It is closed.
server.oninitialized = () => connection.keepAlive();
await server.connect(new StdioServerTransport());

const shutdown = () => {
  connection.close();
  void server.close().finally(() => process.exit(0));
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
