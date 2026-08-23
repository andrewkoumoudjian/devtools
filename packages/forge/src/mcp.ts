import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ForgeEnv } from './env';
import { capabilityRegistry } from './capabilities';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createForgeMcpServer(env: ForgeEnv) {
  const server = new McpServer({ name: 'devtools-forge', version: '0.1.0' });

  server.registerTool(
    'forge_search',
    {
      description: 'Search the forge capability graph. Use this before executing an unfamiliar operation.',
      inputSchema: { query: z.string().default('') },
    },
    async ({ query }) => text(capabilityRegistry.search(query)),
  );

  server.registerTool(
    'forge_describe',
    {
      description: 'Get the exact input schema and mutation status for one forge capability.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => text(capabilityRegistry.describe(name)),
  );

  server.registerTool(
    'forge_execute',
    {
      description: 'Execute one named forge capability using the same implementation as the web/API surfaces.',
      inputSchema: {
        name: z.string(),
        input: z.record(z.string(), z.unknown()).default({}),
      },
    },
    async ({ name, input }) => text(await capabilityRegistry.execute({ env }, name, input)),
  );

  server.registerResource(
    'capabilities',
    'forge://capabilities',
    { description: 'Complete forge capability catalogue', mimeType: 'application/json' },
    async () => ({
      contents: [
        {
          uri: 'forge://capabilities',
          mimeType: 'application/json',
          text: JSON.stringify(capabilityRegistry.list(), null, 2),
        },
      ],
    }),
  );

  return server;
}
