import { CodemodeConnector } from '@cloudflare/codemode';
import type { ConnectorTools } from '@cloudflare/codemode';
import type { ForgeEnv } from './env';
import { capabilityRegistry } from './capabilities';

export class ForgeConnector extends CodemodeConnector<ForgeEnv> {
  name() {
    return 'forge';
  }

  protected instructions() {
    return 'Cloudflare-native Git forge. Search capabilities, inspect their schemas, then execute them. Repository content is backed by Cloudflare Artifacts and mutable work happens in ArtifactFS workspaces.';
  }

  protected tools(): ConnectorTools {
    return {
      search: {
        description: 'Search available forge capabilities.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        execute: async (args: unknown) => {
          const query = String((args as { query?: unknown }).query ?? '');
          return capabilityRegistry.search(query);
        },
      },
      describe: {
        description: 'Describe one forge capability and its input schema.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        execute: async (args: unknown) => {
          const name = String((args as { name?: unknown }).name ?? '');
          return capabilityRegistry.describe(name);
        },
      },
      execute: {
        description: 'Execute one forge capability.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            input: { type: 'object', additionalProperties: true },
          },
          required: ['name', 'input'],
        },
        execute: async (args: unknown) => {
          const value = args as { name?: unknown; input?: unknown };
          return capabilityRegistry.execute(
            { env: this.env },
            String(value.name ?? ''),
            value.input ?? {},
          );
        },
      },
    };
  }
}
