import { z } from 'zod';
import type { ForgeEnv } from './env';
import {
  artifactClient,
  artifactCommit,
  artifactFile,
  artifactLog,
  artifactTree,
} from './artifacts';
import { artifactRepoName } from './naming';
import {
  createIssue,
  createPull,
  createRepoRecord,
  deleteRepoRecord,
  getRepoRecord,
  listIssues,
  listPulls,
  listRepoRecords,
  recordCiRun,
} from './db';
import {
  commitWorkspace,
  createWorkspace,
  destroyWorkspace,
  diffWorkspace,
  execWorkspace,
  pushWorkspace,
} from './workspace';

export type CapabilityContext = { env: ForgeEnv };

type Capability = {
  name: string;
  description: string;
  mutates: boolean;
  inputSchema: Record<string, unknown>;
  parse: (value: unknown) => unknown;
  execute: (ctx: CapabilityContext, input: never) => Promise<unknown>;
};

function schema<T extends z.ZodType>(
  name: string,
  description: string,
  mutates: boolean,
  zod: T,
  inputSchema: Record<string, unknown>,
  execute: (ctx: CapabilityContext, input: z.infer<T>) => Promise<unknown>,
): Capability {
  return {
    name,
    description,
    mutates,
    inputSchema,
    parse: (value) => zod.parse(value),
    execute: execute as Capability['execute'],
  };
}

const repoRef = z.object({ owner: z.string(), repo: z.string() });
const repoRefSchema = {
  type: 'object',
  properties: { owner: { type: 'string' }, repo: { type: 'string' } },
  required: ['owner', 'repo'],
};

const capabilities: Capability[] = [
  schema(
    'repo.list',
    'List repositories registered in this forge.',
    false,
    z.object({}),
    { type: 'object', properties: {} },
    async ({ env }) => listRepoRecords(env),
  ),
  schema(
    'repo.get',
    'Get forge metadata plus live Cloudflare Artifacts metadata for a repository.',
    false,
    repoRef,
    repoRefSchema,
    async ({ env }, input) => {
      const record = await getRepoRecord(env, input.owner, input.repo);
      const artifact = await artifactClient(env).get(record.artifact_name);
      return { ...record, artifact };
    },
  ),
  schema(
    'repo.create',
    'Create a Git repository in Cloudflare Artifacts and register it in the forge.',
    true,
    z.object({
      owner: z.string(),
      repo: z.string(),
      description: z.string().optional(),
      defaultBranch: z.string().default('main'),
      visibility: z.enum(['private', 'public']).default('private'),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        description: { type: 'string' },
        defaultBranch: { type: 'string', default: 'main' },
        visibility: { type: 'string', enum: ['private', 'public'], default: 'private' },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input) => {
      const stored = artifactRepoName(input.owner, input.repo);
      const artifacts = artifactClient(env);
      const created = await artifacts.create(stored, {
        description: input.description,
        setDefaultBranch: input.defaultBranch,
      });
      try {
        const record = await createRepoRecord(env, {
          owner: input.owner,
          name: input.repo,
          artifact_name: stored,
          description: input.description ?? '',
          default_branch: input.defaultBranch,
          visibility: input.visibility,
        });
        return {
          repository: record,
          remote: created.remote,
          initialToken: created.token,
        };
      } catch (error) {
        await artifacts.delete(stored).catch(() => undefined);
        throw error;
      }
    },
  ),
  schema(
    'repo.import',
    'Import an existing Git remote into Cloudflare Artifacts and register it in the forge.',
    true,
    z.object({
      owner: z.string(),
      repo: z.string(),
      url: z.string().url(),
      branch: z.string().optional(),
      depth: z.number().int().positive().optional(),
      description: z.string().optional(),
      visibility: z.enum(['private', 'public']).default('private'),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, url: { type: 'string' },
        branch: { type: 'string' }, depth: { type: 'integer', minimum: 1 },
        description: { type: 'string' }, visibility: { type: 'string', enum: ['private', 'public'] },
      },
      required: ['owner', 'repo', 'url'],
    },
    async ({ env }, input) => {
      const stored = artifactRepoName(input.owner, input.repo);
      const artifacts = artifactClient(env);
      const imported = await artifacts.import(
        stored,
        { url: input.url, branch: input.branch, depth: input.depth },
        { description: input.description },
      );
      try {
        const artifact = await artifacts.get(stored);
        const record = await createRepoRecord(env, {
          owner: input.owner,
          name: input.repo,
          artifact_name: stored,
          description: input.description ?? '',
          default_branch: artifact.defaultBranch ?? input.branch ?? 'main',
          visibility: input.visibility,
        });
        return { repository: record, artifact: imported };
      } catch (error) {
        await artifacts.delete(stored).catch(() => undefined);
        throw error;
      }
    },
  ),
  schema(
    'repo.delete',
    'Delete a repository from Cloudflare Artifacts and remove its forge metadata.',
    true,
    repoRef,
    repoRefSchema,
    async ({ env }, input) => {
      const record = await getRepoRecord(env, input.owner, input.repo);
      const deleted = await artifactClient(env).delete(record.artifact_name);
      if (deleted) await deleteRepoRecord(env, input.owner, input.repo);
      return { deleted };
    },
  ),
  schema(
    'repo.token.create',
    'Mint a short-lived Git token for clone/fetch/push. The returned plaintext is secret.',
    true,
    repoRef.extend({ scope: z.enum(['read', 'write']).default('read'), ttl: z.number().int().positive().max(86400).default(3600) }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, scope: { type: 'string', enum: ['read', 'write'] }, ttl: { type: 'integer' },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input) => {
      const record = await getRepoRecord(env, input.owner, input.repo);
      return artifactClient(env).createToken(record.artifact_name, input.scope, input.ttl);
    },
  ),
  schema(
    'git.log',
    'Read commit history from Cloudflare Artifacts.',
    false,
    repoRef.extend({ ref: z.string().optional(), limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0) }),
    {
      type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } }, required: ['owner', 'repo'],
    },
    async ({ env }, input) => {
      const repo = await getRepoRecord(env, input.owner, input.repo);
      return artifactLog(env, repo.artifact_name, input.ref, input.limit, input.offset);
    },
  ),
  schema(
    'git.commit.get',
    'Read a commit object by hash from Cloudflare Artifacts.',
    false,
    repoRef.extend({ hash: z.string() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, hash: { type: 'string' } }, required: ['owner', 'repo', 'hash'] },
    async ({ env }, input) => {
      const repo = await getRepoRecord(env, input.owner, input.repo);
      return artifactCommit(env, repo.artifact_name, input.hash);
    },
  ),
  schema(
    'git.tree',
    'List one Git tree by hash from Cloudflare Artifacts.',
    false,
    repoRef.extend({ hash: z.string() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, hash: { type: 'string' } }, required: ['owner', 'repo', 'hash'] },
    async ({ env }, input) => {
      const repo = await getRepoRecord(env, input.owner, input.repo);
      return artifactTree(env, repo.artifact_name, input.hash);
    },
  ),
  schema(
    'fs.read',
    'Read a text file at a Git ref from the Artifacts-backed repository filesystem.',
    false,
    repoRef.extend({ ref: z.string().default('main'), path: z.string().min(1), maxBytes: z.number().int().positive().max(2_000_000).default(1_000_000) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' }, maxBytes: { type: 'integer' } }, required: ['owner', 'repo', 'path'] },
    async ({ env }, input) => {
      const repo = await getRepoRecord(env, input.owner, input.repo);
      const response = await artifactFile(env, repo.artifact_name, input.ref, input.path);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > input.maxBytes) throw new Error(`file exceeds maxBytes (${bytes.byteLength} > ${input.maxBytes})`);
      return { path: input.path, ref: input.ref, size: bytes.byteLength, text: new TextDecoder().decode(bytes) };
    },
  ),
  schema(
    'issue.list',
    'List issues for a repository.',
    false,
    repoRef.extend({ state: z.enum(['open', 'closed']).optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listIssues(env, await getRepoRecord(env, input.owner, input.repo), input.state),
  ),
  schema(
    'issue.create',
    'Create an issue in forge metadata.',
    true,
    repoRef.extend({ title: z.string().min(1), body: z.string().optional(), author: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, author: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
    async ({ env }, input) => createIssue(env, await getRepoRecord(env, input.owner, input.repo), input),
  ),
  schema(
    'pull.list',
    'List pull requests for a repository.',
    false,
    repoRef.extend({ state: z.enum(['open', 'closed', 'merged']).optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'merged'] } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listPulls(env, await getRepoRecord(env, input.owner, input.repo), input.state),
  ),
  schema(
    'pull.create',
    'Create a pull request record between two refs.',
    true,
    repoRef.extend({ title: z.string().min(1), body: z.string().optional(), baseRef: z.string(), headRef: z.string(), headSha: z.string().optional(), author: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, baseRef: { type: 'string' }, headRef: { type: 'string' }, headSha: { type: 'string' } }, required: ['owner', 'repo', 'title', 'baseRef', 'headRef'] },
    async ({ env }, input) => createPull(env, await getRepoRecord(env, input.owner, input.repo), input),
  ),
  schema(
    'workspace.create',
    'Create a mutable Cloudflare Sandbox workspace mounted from Artifacts through ArtifactFS.',
    true,
    repoRef.extend({ branch: z.string().default('main'), workspaceId: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, workspaceId: { type: 'string' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => createWorkspace(env, await getRepoRecord(env, input.owner, input.repo), input.branch, input.workspaceId),
  ),
  schema(
    'workspace.exec',
    'Execute a command inside a mutable ArtifactFS-backed workspace.',
    true,
    repoRef.extend({ workspaceId: z.string(), command: z.string().min(1), timeoutMs: z.number().int().positive().max(600000).default(120000) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, workspaceId: { type: 'string' }, command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['owner', 'repo', 'workspaceId', 'command'] },
    async ({ env }, input) => execWorkspace(env, input.workspaceId, await getRepoRecord(env, input.owner, input.repo), input.command, input.timeoutMs),
  ),
  schema(
    'workspace.diff',
    'Return git diff and status for a mutable workspace.',
    false,
    repoRef.extend({ workspaceId: z.string() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, workspaceId: { type: 'string' } }, required: ['owner', 'repo', 'workspaceId'] },
    async ({ env }, input) => diffWorkspace(env, input.workspaceId, await getRepoRecord(env, input.owner, input.repo)),
  ),
  schema(
    'workspace.commit',
    'Stage all workspace changes and create a Git commit.',
    true,
    repoRef.extend({ workspaceId: z.string(), message: z.string().min(1), authorName: z.string().optional(), authorEmail: z.string().email().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, workspaceId: { type: 'string' }, message: { type: 'string' }, authorName: { type: 'string' }, authorEmail: { type: 'string' } }, required: ['owner', 'repo', 'workspaceId', 'message'] },
    async ({ env }, input) => commitWorkspace(env, input.workspaceId, await getRepoRecord(env, input.owner, input.repo), input),
  ),
  schema(
    'workspace.push',
    'Push workspace HEAD to an Artifacts branch using a fresh short-lived token.',
    true,
    repoRef.extend({ workspaceId: z.string(), ref: z.string() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, workspaceId: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo', 'workspaceId', 'ref'] },
    async ({ env }, input) => pushWorkspace(env, input.workspaceId, await getRepoRecord(env, input.owner, input.repo), input.ref),
  ),
  schema(
    'workspace.destroy',
    'Destroy an interactive workspace sandbox.',
    true,
    z.object({ workspaceId: z.string() }),
    { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] },
    async ({ env }, input) => destroyWorkspace(env, input.workspaceId),
  ),
  schema(
    'ci.run',
    'Start the Cloudflare-native CI Workflow manually for an Artifacts commit.',
    true,
    repoRef.extend({ ref: z.string(), sha: z.string() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, sha: { type: 'string' } }, required: ['owner', 'repo', 'ref', 'sha'] },
    async ({ env }, input) => {
      const repo = await getRepoRecord(env, input.owner, input.repo);
      const fullRef = input.ref.startsWith('refs/') ? input.ref : `refs/heads/${input.ref}`;
      const instance = await env.CI_WORKFLOW.create({
        params: {
          provider: 'cloudflare-artifacts',
          providerData: { namespace: env.ARTIFACTS_NAMESPACE },
          event: { type: 'push' },
          owner: env.ARTIFACTS_NAMESPACE,
          repo: repo.artifact_name,
          sha: input.sha,
          remote: 'cloudflare',
          trigger: 'push',
          ref: fullRef,
          branch: fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : undefined,
        },
      });
      const run = await recordCiRun(env, repo.id, fullRef, input.sha, instance.id);
      return { instanceId: instance.id, run };
    },
  ),
];

const byName = new Map(capabilities.map((capability) => [capability.name, capability]));

export const capabilityRegistry = {
  search(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return capabilities
      .map((c) => ({
        name: c.name,
        description: c.description,
        mutates: c.mutates,
        score: terms.reduce((score, term) => score + (c.name.toLowerCase().includes(term) ? 4 : 0) + (c.description.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  },
  describe(name: string) {
    const c = byName.get(name);
    if (!c) throw new Error(`unknown capability: ${name}`);
    return { name: c.name, description: c.description, mutates: c.mutates, inputSchema: c.inputSchema };
  },
  async execute(ctx: CapabilityContext, name: string, rawInput: unknown) {
    const c = byName.get(name);
    if (!c) throw new Error(`unknown capability: ${name}`);
    const input = c.parse(rawInput);
    return c.execute(ctx, input as never);
  },
  list() {
    return capabilities.map((c) => ({ name: c.name, description: c.description, mutates: c.mutates }));
  },
};
