import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ForgeEnv } from './env';
import { forgeRegistry } from './registry';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function run(env: ForgeEnv, name: string, input: Record<string, unknown>) {
  return text(await forgeRegistry.executeForAgent({ env }, name, input));
}

export function createForgeMcpServer(env: ForgeEnv) {
  const server = new McpServer({ name: 'devtools-forge', version: '0.3.0' });

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

  // Direct workspace tools are intentionally projected in addition to the
  // generic capability executor. Remote coding agents should not have to build
  // their own shell protocol just to interact with the ArtifactFS working tree.
  server.registerTool(
    'forge_workspace_open',
    {
      description: 'Open a mutable or read-only agent workspace. The repository is mounted lazily through ArtifactFS from Cloudflare Artifacts and the response includes the shared RepoContext.',
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        branch: z.string().optional(),
        workspaceId: z.string().optional(),
        agentName: z.string().optional(),
        accessMode: z.enum(['read-only', 'write-capable']).default('write-capable'),
        targetKind: z.enum(['issue', 'pull']).optional(),
        targetNumber: z.number().int().positive().optional(),
      },
    },
    async (input) => run(env, 'workspace.create', input),
  );

  server.registerTool(
    'forge_workspace_list',
    {
      description: 'List existing agent workspaces for a repository so a remote agent can resume one by workspaceId.',
      inputSchema: { owner: z.string(), repo: z.string() },
    },
    async (input) => run(env, 'workspace.list', input),
  );

  server.registerTool(
    'forge_workspace_context',
    {
      description: 'Refresh and return the authoritative context for one mounted agent workspace.',
      inputSchema: { owner: z.string(), repo: z.string(), workspaceId: z.string() },
    },
    async (input) => run(env, 'workspace.context', input),
  );

  server.registerTool(
    'forge_workspace_exec',
    {
      description: 'Run a normal command inside a write-capable ArtifactFS-backed POSIX workspace. Use for git, rg, tests, compilers, package managers and commands that genuinely need a working tree. Read-only sessions fail closed for arbitrary shell execution.',
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        workspaceId: z.string(),
        command: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000),
      },
    },
    async (input) => run(env, 'workspace.exec', input),
  );

  server.registerTool(
    'forge_workspace_file',
    {
      description: 'Use Cloudflare Sandbox native filesystem operations directly on the live ArtifactFS working tree. Writes change the workspace overlay only until committed/pushed with Git.',
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        workspaceId: z.string(),
        action: z.enum(['read', 'write', 'list', 'exists', 'mkdir', 'move', 'delete']),
        path: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        content: z.string().optional(),
        encoding: z.enum(['utf8', 'base64']).optional(),
        recursive: z.boolean().optional(),
        includeHidden: z.boolean().optional(),
        createParents: z.boolean().optional(),
      },
    },
    async (input) => {
      const base = { owner: input.owner, repo: input.repo, workspaceId: input.workspaceId };
      switch (input.action) {
        case 'read':
          if (input.path === undefined) throw new Error('path is required for read');
          return run(env, 'workspace.file.read', { ...base, path: input.path, encoding: input.encoding ?? 'utf8' });
        case 'write':
          if (input.path === undefined || input.content === undefined) throw new Error('path and content are required for write');
          return run(env, 'workspace.file.write', { ...base, path: input.path, content: input.content, encoding: input.encoding ?? 'utf8', createParents: input.createParents ?? true });
        case 'list':
          return run(env, 'workspace.file.list', { ...base, path: input.path ?? '', recursive: input.recursive ?? false, includeHidden: input.includeHidden ?? false });
        case 'exists':
          if (input.path === undefined) throw new Error('path is required for exists');
          return run(env, 'workspace.file.exists', { ...base, path: input.path });
        case 'mkdir':
          if (input.path === undefined) throw new Error('path is required for mkdir');
          return run(env, 'workspace.dir.create', { ...base, path: input.path, recursive: input.recursive ?? true });
        case 'move':
          if (input.from === undefined || input.to === undefined) throw new Error('from and to are required for move');
          return run(env, 'workspace.file.move', { ...base, from: input.from, to: input.to });
        case 'delete':
          if (input.path === undefined) throw new Error('path is required for delete');
          return run(env, 'workspace.file.delete', { ...base, path: input.path });
      }
    },
  );

  server.registerTool(
    'forge_workspace_git',
    {
      description: 'Operate on Git state inside the agent workspace while Cloudflare Artifacts remains the durable Git backend. Supports diff, commit, and push.',
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        workspaceId: z.string(),
        action: z.enum(['diff', 'commit', 'push']),
        message: z.string().optional(),
        authorName: z.string().optional(),
        authorEmail: z.string().email().optional(),
        ref: z.string().optional(),
      },
    },
    async (input) => {
      const base = { owner: input.owner, repo: input.repo, workspaceId: input.workspaceId };
      if (input.action === 'diff') return run(env, 'workspace.diff', base);
      if (input.action === 'commit') {
        if (!input.message) throw new Error('message is required for commit');
        return run(env, 'workspace.commit', { ...base, message: input.message, authorName: input.authorName, authorEmail: input.authorEmail });
      }
      if (!input.ref) throw new Error('ref is required for push');
      return run(env, 'workspace.push', { ...base, ref: input.ref });
    },
  );

  server.registerTool(
    'forge_workspace_process',
    {
      description: 'Manage long-running commands with Cloudflare Sandbox native process management inside the ArtifactFS workspace. Supports start/list/get/logs/kill without inventing a forge-side process scheduler.',
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        workspaceId: z.string(),
        action: z.enum(['start', 'list', 'get', 'logs', 'kill']),
        command: z.string().optional(),
        processId: z.string().optional(),
        timeoutMs: z.number().int().positive().max(86_400_000).optional(),
        autoCleanup: z.boolean().optional(),
        signal: z.string().optional(),
      },
    },
    async (input) => {
      const base = { owner: input.owner, repo: input.repo, workspaceId: input.workspaceId };
      if (input.action === 'start') {
        if (!input.command) throw new Error('command is required for start');
        return run(env, 'workspace.process.start', {
          ...base,
          command: input.command,
          processId: input.processId,
          timeoutMs: input.timeoutMs,
          autoCleanup: input.autoCleanup ?? false,
        });
      }
      if (input.action === 'list') return run(env, 'workspace.process.list', base);
      if (!input.processId) throw new Error('processId is required for get/logs/kill');
      if (input.action === 'get') return run(env, 'workspace.process.get', { ...base, processId: input.processId });
      if (input.action === 'logs') return run(env, 'workspace.process.logs', { ...base, processId: input.processId });
      return run(env, 'workspace.process.kill', { ...base, processId: input.processId, signal: input.signal ?? 'SIGTERM' });
    },
  );

  server.registerTool(
    'forge_workspace_close',
    {
      description: 'Destroy an agent Sandbox workspace after work has been committed/pushed. Destroying removes uncommitted workspace state but never deletes Git state already stored in Artifacts.',
      inputSchema: { owner: z.string(), repo: z.string(), workspaceId: z.string() },
    },
    async (input) => run(env, 'workspace.destroy', input),
  );

  return server;
}
