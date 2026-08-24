import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ForgeEnv } from './env';
import { forgeRegistry } from './registry';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createForgeMcpServer(env: ForgeEnv) {
  const server = new McpServer({ name: 'devtools-forge', version: '0.2.0' });

  server.registerTool(
    'forge_search',
    {
      description: 'Search the forge capability graph. Repo-scoped executions automatically return the same deterministic RepoContext used by every other agent.',
      inputSchema: { query: z.string().default('') },
    },
    async ({ query }) => text(forgeRegistry.search(query)),
  );

  server.registerTool(
    'forge_describe',
    {
      description: 'Get the exact input schema and mutation status for one forge capability.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => text(forgeRegistry.describe(name)),
  );

  server.registerTool(
    'forge_execute',
    {
      description: 'Execute one named forge capability. When owner/repo is present, the response also carries the current non-LLM RepoContext: authority, ref/head, repo instructions, CODEOWNERS, active work, target thread, CI and retrieval primitives.',
      inputSchema: {
        name: z.string(),
        input: z.record(z.string(), z.unknown()).default({}),
      },
    },
    async ({ name, input }) => text(await forgeRegistry.executeForAgent({ env }, name, input)),
  );

  return server;
}
