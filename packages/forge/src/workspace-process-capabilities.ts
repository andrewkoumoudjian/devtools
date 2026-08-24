import { z } from 'zod';
import type { ForgeEnv } from './env';
import { getRepoRecord } from './db';
import {
  getWorkspaceProcess,
  getWorkspaceProcessLogs,
  killWorkspaceProcess,
  listWorkspaceProcesses,
  startWorkspaceProcess,
} from './workspace-process';

export type WorkspaceProcessCapability = {
  name: string;
  description: string;
  mutates: boolean;
  inputSchema: Record<string, unknown>;
  parse: (value: unknown) => unknown;
  execute: (ctx: { env: ForgeEnv }, input: never) => Promise<unknown>;
};

function cap<T extends z.ZodType>(
  name: string,
  description: string,
  mutates: boolean,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: (ctx: { env: ForgeEnv }, input: z.infer<T>) => Promise<unknown>,
): WorkspaceProcessCapability {
  return { name, description, mutates, inputSchema, parse: (value) => parser.parse(value), execute: execute as WorkspaceProcessCapability['execute'] };
}

const workspace = z.object({ owner: z.string(), repo: z.string(), workspaceId: z.string() });
const baseSchema = {
  type: 'object',
  properties: { owner: { type: 'string' }, repo: { type: 'string' }, workspaceId: { type: 'string' } },
  required: ['owner', 'repo', 'workspaceId'],
};

async function repo(env: ForgeEnv, input: { owner: string; repo: string }) {
  return getRepoRecord(env, input.owner, input.repo);
}

export const workspaceProcessCapabilities: WorkspaceProcessCapability[] = [
  cap(
    'workspace.process.start',
    'Start a long-running process through Cloudflare Sandbox native process management inside the ArtifactFS workspace. Intended for dev servers, watchers, compilers, and coding-agent runtimes.',
    true,
    workspace.extend({
      command: z.string().min(1),
      processId: z.string().optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      autoCleanup: z.boolean().default(false),
    }),
    {
      type: 'object',
      properties: { ...baseSchema.properties, command: { type: 'string' }, processId: { type: 'string' }, timeoutMs: { type: 'integer' }, autoCleanup: { type: 'boolean' } },
      required: [...baseSchema.required, 'command'],
    },
    async ({ env }, input) => startWorkspaceProcess(env, input.workspaceId, await repo(env, input), input.command, input),
  ),
  cap(
    'workspace.process.list',
    'List Sandbox-owned background processes in one agent workspace.',
    false,
    workspace,
    baseSchema,
    async ({ env }, input) => listWorkspaceProcesses(env, input.workspaceId, await repo(env, input)),
  ),
  cap(
    'workspace.process.get',
    'Get the current status and metadata for a Sandbox-owned workspace process.',
    false,
    workspace.extend({ processId: z.string() }),
    { type: 'object', properties: { ...baseSchema.properties, processId: { type: 'string' } }, required: [...baseSchema.required, 'processId'] },
    async ({ env }, input) => getWorkspaceProcess(env, input.workspaceId, await repo(env, input), input.processId),
  ),
  cap(
    'workspace.process.logs',
    'Read accumulated stdout/stderr for a Sandbox-owned workspace process.',
    false,
    workspace.extend({ processId: z.string() }),
    { type: 'object', properties: { ...baseSchema.properties, processId: { type: 'string' } }, required: [...baseSchema.required, 'processId'] },
    async ({ env }, input) => getWorkspaceProcessLogs(env, input.workspaceId, await repo(env, input), input.processId),
  ),
  cap(
    'workspace.process.kill',
    'Terminate a Sandbox-owned workspace process with a signal.',
    true,
    workspace.extend({ processId: z.string(), signal: z.string().default('SIGTERM') }),
    { type: 'object', properties: { ...baseSchema.properties, processId: { type: 'string' }, signal: { type: 'string' } }, required: [...baseSchema.required, 'processId'] },
    async ({ env }, input) => killWorkspaceProcess(env, input.workspaceId, await repo(env, input), input.processId, input.signal),
  ),
];
