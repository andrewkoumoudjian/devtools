import { z } from 'zod';
import type { ForgeEnv } from './env';
import { getRepoRecord } from './db';
import {
  commitWorkspace,
  createWorkspace,
  deleteWorkspaceFile,
  destroyWorkspace,
  diffWorkspace,
  execWorkspace,
  getWorkspaceSession,
  listWorkspaceFiles,
  listWorkspaceSessions,
  mkdirWorkspace,
  moveWorkspaceFile,
  pushWorkspace,
  readWorkspaceFile,
  workspaceContext,
  workspaceExists,
  writeWorkspaceFile,
} from './workspace';

export type WorkspaceCapabilityContext = { env: ForgeEnv };
export type WorkspaceCapability = {
  name: string;
  description: string;
  mutates: boolean;
  inputSchema: Record<string, unknown>;
  parse: (value: unknown) => unknown;
  execute: (ctx: WorkspaceCapabilityContext, input: never) => Promise<unknown>;
};

function cap<T extends z.ZodType>(
  name: string,
  description: string,
  mutates: boolean,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: (ctx: WorkspaceCapabilityContext, input: z.infer<T>) => Promise<unknown>,
): WorkspaceCapability {
  return {
    name,
    description,
    mutates,
    inputSchema,
    parse: (value) => parser.parse(value),
    execute: execute as WorkspaceCapability['execute'],
  };
}

const repoRef = z.object({ owner: z.string().min(1), repo: z.string().min(1) });
const workspaceRef = repoRef.extend({ workspaceId: z.string().min(1) });
const workspaceSchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    workspaceId: { type: 'string' },
  },
  required: ['owner', 'repo', 'workspaceId'],
};

async function repository(env: ForgeEnv, input: { owner: string; repo: string }) {
  return getRepoRecord(env, input.owner, input.repo);
}

export const workspaceCapabilities: WorkspaceCapability[] = [
  cap(
    'workspace.create',
    'Create or attach a durable Sandbox workspace whose repository tree is a lazy ArtifactFS projection of the Artifacts Git repository. Returns the workspace id and deterministic RepoContext.',
    true,
    repoRef.extend({
      branch: z.string().optional(),
      workspaceId: z.string().optional(),
      agentName: z.string().optional(),
      accessMode: z.enum(['read-only', 'write-capable']).default('write-capable'),
      targetKind: z.enum(['issue', 'pull']).optional(),
      targetNumber: z.number().int().positive().optional(),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' },
        workspaceId: { type: 'string' }, agentName: { type: 'string' },
        accessMode: { type: 'string', enum: ['read-only', 'write-capable'] },
        targetKind: { type: 'string', enum: ['issue', 'pull'] }, targetNumber: { type: 'integer' },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      if ((input.targetKind === undefined) !== (input.targetNumber === undefined)) {
        throw new Error('targetKind and targetNumber must be supplied together');
      }
      return createWorkspace(
        env,
        repo,
        input.branch ?? repo.default_branch,
        input.workspaceId,
        {
          agentName: input.agentName ?? 'remote-agent',
          accessMode: input.accessMode,
          target: input.targetKind && input.targetNumber
            ? { kind: input.targetKind, number: input.targetNumber }
            : undefined,
        },
      );
    },
  ),
  cap(
    'workspace.list',
    'List durable agent workspace sessions for a repository so a remote agent can discover and resume existing work.',
    false,
    repoRef,
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listWorkspaceSessions(env, await repository(env, input)),
  ),
  cap(
    'workspace.get',
    'Get one workspace session record and verify that it belongs to the requested repository.',
    false,
    workspaceRef,
    workspaceSchema,
    async ({ env }, input) => getWorkspaceSession(env, input.workspaceId, await repository(env, input)),
  ),
  cap(
    'workspace.context',
    'Refresh and return the authoritative RepoContext mounted into a workspace under .git/forge for every agent.',
    false,
    workspaceRef,
    workspaceSchema,
    async ({ env }, input) => workspaceContext(env, input.workspaceId, await repository(env, input)),
  ),
  cap(
    'workspace.exec',
    'Execute a normal command inside the ArtifactFS-backed POSIX workspace. git, rg, compilers, package managers and coding agents operate on the mounted working tree.',
    true,
    workspaceRef.extend({ command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(600000).default(120000) }),
    {
      type: 'object',
      properties: { ...workspaceSchema.properties, command: { type: 'string' }, timeoutMs: { type: 'integer' } },
      required: [...workspaceSchema.required, 'command'],
    },
    async ({ env }, input) => execWorkspace(env, input.workspaceId, await repository(env, input), input.command, input.timeoutMs),
  ),
  cap(
    'workspace.file.read',
    'Read a file from the live ArtifactFS working tree using the native Sandbox file API. Lazy ArtifactFS hydration is preserved.',
    false,
    workspaceRef.extend({ path: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') }),
    {
      type: 'object', properties: { ...workspaceSchema.properties, path: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } },
      required: [...workspaceSchema.required, 'path'],
    },
    async ({ env }, input) => readWorkspaceFile(env, input.workspaceId, await repository(env, input), input.path, input.encoding),
  ),
  cap(
    'workspace.file.write',
    'Write a file into the mutable ArtifactFS working tree using Sandbox.writeFile. This changes only the workspace until a Git commit/push is performed.',
    true,
    workspaceRef.extend({
      path: z.string().min(1), content: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8'), createParents: z.boolean().default(true),
    }),
    {
      type: 'object', properties: { ...workspaceSchema.properties, path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, createParents: { type: 'boolean' } },
      required: [...workspaceSchema.required, 'path', 'content'],
    },
    async ({ env }, input) => writeWorkspaceFile(env, input.workspaceId, await repository(env, input), input.path, input.content, { encoding: input.encoding, createParents: input.createParents }),
  ),
  cap(
    'workspace.file.list',
    'List files/directories from the live ArtifactFS working tree using Sandbox.listFiles.',
    false,
    workspaceRef.extend({ path: z.string().default(''), recursive: z.boolean().default(false), includeHidden: z.boolean().default(false) }),
    {
      type: 'object', properties: { ...workspaceSchema.properties, path: { type: 'string' }, recursive: { type: 'boolean' }, includeHidden: { type: 'boolean' } },
      required: workspaceSchema.required,
    },
    async ({ env }, input) => listWorkspaceFiles(env, input.workspaceId, await repository(env, input), input.path, { recursive: input.recursive, includeHidden: input.includeHidden }),
  ),
  cap(
    'workspace.file.exists',
    'Check a path in the live ArtifactFS working tree using Sandbox.exists.',
    false,
    workspaceRef.extend({ path: z.string() }),
    { type: 'object', properties: { ...workspaceSchema.properties, path: { type: 'string' } }, required: [...workspaceSchema.required, 'path'] },
    async ({ env }, input) => workspaceExists(env, input.workspaceId, await repository(env, input), input.path),
  ),
  cap(
    'workspace.dir.create',
    'Create a directory in the live ArtifactFS working tree using Sandbox.mkdir.',
    true,
    workspaceRef.extend({ path: z.string().min(1), recursive: z.boolean().default(true) }),
    { type: 'object', properties: { ...workspaceSchema.properties, path: { type: 'string' }, recursive: { type: 'boolean' } }, required: [...workspaceSchema.required, 'path'] },
    async ({ env }, input) => mkdirWorkspace(env, input.workspaceId, await repository(env, input), input.path, input.recursive),
  ),
  cap(
    'workspace.file.move',
    'Move or rename a file inside the live ArtifactFS working tree using Sandbox.moveFile.',
    true,
    workspaceRef.extend({ from: z.string().min(1), to: z.string().min(1) }),
    { type: 'object', properties: { ...workspaceSchema.properties, from: { type: 'string' }, to: { type: 'string' } }, required: [...workspaceSchema.required, 'from', 'to'] },
    async ({ env }, input) => moveWorkspaceFile(env, input.workspaceId, await repository(env, input), input.from, input.to),
  ),
  cap(
    'workspace.file.delete',
    'Delete a file from the mutable ArtifactFS working tree using Sandbox.deleteFile.',
    true,
    workspaceRef.extend({ path: z.string().min(1) }),
    { type: 'object', properties: { ...workspaceSchema.properties, path: { type: 'string' } }, required: [...workspaceSchema.required, 'path'] },
    async ({ env }, input) => deleteWorkspaceFile(env, input.workspaceId, await repository(env, input), input.path),
  ),
  cap(
    'workspace.diff',
    'Return the current working-tree Git diff/status from the ArtifactFS workspace. Git state remains owned by Artifacts.',
    false,
    workspaceRef,
    workspaceSchema,
    async ({ env }, input) => diffWorkspace(env, input.workspaceId, await repository(env, input)),
  ),
  cap(
    'workspace.commit',
    'Create a normal Git commit from the mutable workspace. The commit remains local until pushed to Artifacts.',
    true,
    workspaceRef.extend({ message: z.string().min(1), authorName: z.string().optional(), authorEmail: z.string().email().optional() }),
    {
      type: 'object', properties: { ...workspaceSchema.properties, message: { type: 'string' }, authorName: { type: 'string' }, authorEmail: { type: 'string' } },
      required: [...workspaceSchema.required, 'message'],
    },
    async ({ env }, input) => commitWorkspace(env, input.workspaceId, await repository(env, input), input),
  ),
  cap(
    'workspace.push',
    'Push workspace HEAD through native Git to the Artifacts repository. Artifacts remains the durable Git source of truth.',
    true,
    workspaceRef.extend({ ref: z.string().min(1) }),
    { type: 'object', properties: { ...workspaceSchema.properties, ref: { type: 'string' } }, required: [...workspaceSchema.required, 'ref'] },
    async ({ env }, input) => pushWorkspace(env, input.workspaceId, await repository(env, input), input.ref),
  ),
  cap(
    'workspace.destroy',
    'Close the agent session and destroy the Sandbox workspace. Durable Git state already pushed to Artifacts is unaffected.',
    true,
    workspaceRef,
    workspaceSchema,
    async ({ env }, input) => {
      await getWorkspaceSession(env, input.workspaceId, await repository(env, input));
      return destroyWorkspace(env, input.workspaceId);
    },
  ),
];
