import { getSandbox } from '@cloudflare/sandbox';
import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { artifactClient } from './artifacts';
import { buildRepoContext, repoContextMarkdown, type ContextTarget } from './context';
import { closeAgentSession, getRepoSettings, openAgentSession, touchAgentSession } from './product';

const MOUNT_SCRIPT = '/usr/local/bin/mount-artifact-fs-repo';
const MOUNT_ROOT = '/workspace/mnt';
type SandboxId = `${string}-${string}-${string}-${string}-${string}`;

type AgentSessionContext = {
  agent_name: string;
  ref: string;
  target_kind: 'issue' | 'pull' | null;
  target_number: number | null;
  access_mode: 'read-only' | 'write-capable';
};

export type WorkspaceSession = AgentSessionContext & {
  id: string;
  repo_id: string;
  workspace_id: string | null;
  opened_at: string;
  last_seen_at: string;
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function basicAuth(token: string): string {
  const secret = token.split('?expires=', 1)[0] ?? token;
  return btoa(`x:${secret}`);
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function workspaceSandbox(env: ForgeEnv, id: string) {
  return getSandbox(env.WORKSPACE_SANDBOX as never, id as SandboxId, {
    enableDefaultSession: false,
    normalizeId: true,
    sleepAfter: '30m',
    transport: 'rpc',
  });
}

export function workspaceRoot(repo: RepoRecord) {
  return `${MOUNT_ROOT}/${repo.artifact_name}`;
}

function workspacePath(repo: RepoRecord, path = '') {
  if (path.includes('\0')) throw new Error('workspace path contains a NUL byte');
  if (path.startsWith('/')) throw new Error('workspace paths must be repository-relative');
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error('workspace path cannot escape the repository root');
  return parts.length ? `${workspaceRoot(repo)}/${parts.join('/')}` : workspaceRoot(repo);
}

function assertWorkingTreePath(path: string) {
  const normalized = path.replace(/^\.\//, '');
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('direct writes to .git are not permitted through the workspace file API');
  }
}

async function freshAuth(env: ForgeEnv, repo: RepoRecord, scope: 'read' | 'write' = 'write') {
  const artifacts = artifactClient(env);
  const info = await artifacts.get(repo.artifact_name);
  const token = await artifacts.createToken(repo.artifact_name, scope, 3600);
  return { remote: info.remote, authorization: `Basic ${basicAuth(token.plaintext)}` };
}

async function mountWorkspace(env: ForgeEnv, repo: RepoRecord, branch: string, workspaceId: string, scope: 'read' | 'write') {
  const sandbox = workspaceSandbox(env, workspaceId);
  const auth = await freshAuth(env, repo, scope);
  const result = await sandbox.exec(MOUNT_SCRIPT, {
    cwd: '/workspace',
    env: {
      MOUNT_GIT_REMOTE: auth.remote,
      MOUNT_GIT_BRANCH: branch,
      MOUNT_REPO_NAME: repo.artifact_name,
      MOUNT_ROOT,
      ARTIFACTS_AUTHORIZATION: auth.authorization,
    },
    timeout: 120_000,
  });
  if (!result.success) {
    await sandbox.destroy().catch(() => undefined);
    throw new Error(`workspace mount failed (${result.exitCode}): ${result.stderr.slice(0, 500)}`);
  }
  return { sandbox, auth, cwd: workspaceRoot(repo) };
}

async function currentBranch(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  const result = await workspaceSandbox(env, workspaceId).exec('git branch --show-current', {
    cwd: workspaceRoot(repo),
    timeout: 10_000,
  });
  return result.success && result.stdout.trim() ? result.stdout.trim() : repo.default_branch;
}

async function agentSession(env: ForgeEnv, workspaceId: string, repo: RepoRecord): Promise<AgentSessionContext | null> {
  return env.DB.prepare(
    `SELECT agent_name, ref, target_kind, target_number, access_mode FROM agent_sessions WHERE id = ? AND repo_id = ?`,
  ).bind(workspaceId, repo.id).first<AgentSessionContext>();
}

export async function getWorkspaceSession(env: ForgeEnv, workspaceId: string, repo: RepoRecord): Promise<WorkspaceSession> {
  const row = await env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ? AND repo_id = ?`)
    .bind(workspaceId, repo.id)
    .first<WorkspaceSession>();
  if (!row) throw new Error(`workspace ${workspaceId} is not attached to ${repo.owner}/${repo.name}`);
  return row;
}

export async function listWorkspaceSessions(env: ForgeEnv, repo: RepoRecord): Promise<WorkspaceSession[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM agent_sessions WHERE repo_id = ? ORDER BY last_seen_at DESC, opened_at DESC`,
  ).bind(repo.id).all<WorkspaceSession>();
  return rows.results;
}

function targetFromSession(session: AgentSessionContext | null): ContextTarget | undefined {
  return session?.target_kind && session.target_number
    ? { kind: session.target_kind, number: session.target_number }
    : undefined;
}

export async function syncWorkspaceContext(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  ref: string,
  options: { agentName?: string; target?: ContextTarget; accessMode?: 'read-only' | 'write-capable' } = {},
) {
  const sandbox = workspaceSandbox(env, workspaceId);
  const cwd = workspaceRoot(repo);
  const context = await buildRepoContext(env, repo, {
    ref,
    target: options.target,
    agentName: options.agentName,
    accessMode: options.accessMode,
  });
  const json = JSON.stringify(context, null, 2);
  const markdown = repoContextMarkdown(context);
  const command = [
    // In ArtifactFS views `.git` can be a gitfile pointing at the real gitdir,
    // so always resolve it instead of assuming `./.git` is a directory.
    'GIT_DIR_ABS=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null || echo "$PWD/.git")',
    'mkdir -p "$GIT_DIR_ABS/forge"',
    `printf %s ${shellQuote(base64Utf8(json))} | base64 -d > "$GIT_DIR_ABS/forge/context.json"`,
    `printf %s ${shellQuote(base64Utf8(markdown))} | base64 -d > "$GIT_DIR_ABS/forge/AGENT_CONTEXT.md"`,
  ].join(' && ');
  const result = await sandbox.exec(command, { cwd, timeout: 20_000 });
  if (!result.success) throw new Error(`could not synchronize Forge context: ${result.stderr.slice(0, 500)}`);
  return context;
}

export async function prepareWorkspaceOperation(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  const session = await getWorkspaceSession(env, workspaceId, repo);
  const ref = await currentBranch(env, workspaceId, repo);
  if (ref !== session.ref) {
    await env.DB.prepare(`UPDATE agent_sessions SET ref = ?, last_seen_at = datetime('now') WHERE id = ?`)
      .bind(ref, workspaceId)
      .run();
  } else {
    await touchAgentSession(env, workspaceId).catch(() => undefined);
  }
  const context = await syncWorkspaceContext(env, workspaceId, repo, ref, {
    agentName: session.agent_name,
    target: targetFromSession(session),
    accessMode: session.access_mode,
  });
  return { session: { ...session, ref }, context, sandbox: workspaceSandbox(env, workspaceId), cwd: workspaceRoot(repo) };
}

export async function assertWorkspaceWritable(env: ForgeEnv, repo: RepoRecord, session: WorkspaceSession | AgentSessionContext) {
  if (session.access_mode === 'read-only') throw new Error('workspace is read-only');
  const settings = await getRepoSettings(env, repo);
  if (!settings.agent_write_enabled) throw new Error('repository agent writes are disabled');
}

export async function createWorkspace(
  env: ForgeEnv,
  repo: RepoRecord,
  branch: string,
  workspaceId: string = crypto.randomUUID(),
  options: { agentName?: string; target?: ContextTarget; accessMode?: 'read-only' | 'write-capable' } = {},
) {
  const settings = await getRepoSettings(env, repo);
  const requestedMode = options.accessMode ?? 'write-capable';
  const accessMode: 'read-only' | 'write-capable' =
    requestedMode === 'write-capable' && settings.agent_write_enabled ? 'write-capable' : 'read-only';
  const { cwd } = await mountWorkspace(env, repo, branch, workspaceId, accessMode === 'read-only' ? 'read' : 'write');
  await openAgentSession(env, repo, {
    id: workspaceId,
    agentName: options.agentName,
    ref: branch,
    targetKind: options.target?.kind,
    targetNumber: options.target?.number,
    workspaceId,
    accessMode,
  });
  const context = await syncWorkspaceContext(env, workspaceId, repo, branch, { ...options, accessMode });
  return {
    workspaceId,
    repo: `${repo.owner}/${repo.name}`,
    branch,
    mountPath: cwd,
    contextPath: `${cwd}/.git/forge/context.json`,
    contextMarkdownPath: `${cwd}/.git/forge/AGENT_CONTEXT.md`,
    accessMode,
    context,
  };
}

async function runWorkspaceCommand(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  command: string,
  timeoutMs: number,
  requireWrite: boolean,
) {
  const { session, context, sandbox, cwd } = await prepareWorkspaceOperation(env, workspaceId, repo);
  if (requireWrite) await assertWorkspaceWritable(env, repo, session);
  const result = await sandbox.exec(command, {
    cwd,
    env: {
      FORGE_CONTEXT_PATH: `${cwd}/.git/forge/context.json`,
      FORGE_CONTEXT_MD: `${cwd}/.git/forge/AGENT_CONTEXT.md`,
      FORGE_REPOSITORY: `${repo.owner}/${repo.name}`,
      FORGE_REF: session.ref,
      FORGE_HEAD_SHA: context.authority.headSha ?? '',
      FORGE_TARGET_KIND: context.authority.target?.kind ?? '',
      FORGE_TARGET_NUMBER: context.authority.target ? String(context.authority.target.number) : '',
      FORGE_WORKING_TREE: session.access_mode,
    },
    timeout: Math.min(Math.max(timeoutMs, 1_000), 600_000),
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    context,
  };
}

export async function execWorkspace(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  command: string,
  timeoutMs = 120_000,
) {
  // Arbitrary shell execution can mutate the working tree, package caches, or
  // repository metadata. Fail closed for read-only agent sessions; read-only
  // agents still have Artifacts-native reads and native workspace file reads.
  return runWorkspaceCommand(env, workspaceId, repo, command, timeoutMs, true);
}

export async function readWorkspaceFile(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  path: string,
  encoding: 'utf8' | 'base64' = 'utf8',
) {
  const { sandbox, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const absolutePath = workspacePath(repo, path);
  const file = encoding === 'base64'
    ? await sandbox.readFile(absolutePath, { encoding: 'base64' })
    : await sandbox.readFile(absolutePath);
  return { requestedPath: path, file, context };
}

export async function writeWorkspaceFile(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  path: string,
  content: string,
  options: { encoding?: 'utf8' | 'base64'; createParents?: boolean } = {},
) {
  assertWorkingTreePath(path);
  const { sandbox, session, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  await assertWorkspaceWritable(env, repo, session);
  const absolutePath = workspacePath(repo, path);
  if (options.createParents !== false) {
    const parent = absolutePath.slice(0, absolutePath.lastIndexOf('/'));
    if (parent && parent !== workspaceRoot(repo)) await sandbox.mkdir(parent, { recursive: true });
  }
  const file = options.encoding === 'base64'
    ? await sandbox.writeFile(absolutePath, content, { encoding: 'base64' })
    : await sandbox.writeFile(absolutePath, content);
  return { requestedPath: path, file, context };
}

export async function listWorkspaceFiles(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  path = '',
  options: { recursive?: boolean; includeHidden?: boolean } = {},
) {
  const { sandbox, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const listing = await sandbox.listFiles(workspacePath(repo, path), options);
  return { requestedPath: path, listing, context };
}

export async function workspaceExists(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  path: string,
) {
  const { sandbox, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const result = await sandbox.exists(workspacePath(repo, path));
  return { requestedPath: path, result, context };
}

export async function mkdirWorkspace(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  path: string,
  recursive = true,
) {
  assertWorkingTreePath(path);
  const { sandbox, session, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  await assertWorkspaceWritable(env, repo, session);
  const directory = await sandbox.mkdir(workspacePath(repo, path), { recursive });
  return { requestedPath: path, directory, context };
}

export async function moveWorkspaceFile(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  from: string,
  to: string,
) {
  assertWorkingTreePath(from);
  assertWorkingTreePath(to);
  const { sandbox, session, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  await assertWorkspaceWritable(env, repo, session);
  const result = await sandbox.moveFile(workspacePath(repo, from), workspacePath(repo, to));
  return { from, to, result, context };
}

export async function deleteWorkspaceFile(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  path: string,
) {
  assertWorkingTreePath(path);
  const { sandbox, session, context } = await prepareWorkspaceOperation(env, workspaceId, repo);
  await assertWorkspaceWritable(env, repo, session);
  const result = await sandbox.deleteFile(workspacePath(repo, path));
  return { requestedPath: path, result, context };
}

export async function workspaceContext(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  const { session, context, cwd } = await prepareWorkspaceOperation(env, workspaceId, repo);
  return {
    workspaceId,
    repo: `${repo.owner}/${repo.name}`,
    ref: session.ref,
    accessMode: session.access_mode,
    mountPath: cwd,
    contextPath: `${cwd}/.git/forge/context.json`,
    contextMarkdownPath: `${cwd}/.git/forge/AGENT_CONTEXT.md`,
    context,
  };
}

// Retained as an internal escape hatch for commands that genuinely require a
// POSIX checkout. Repository browsing/search/history/diff capabilities do not
// call this; those operate directly on Artifacts Git objects in git-data.ts.
export async function repoGitCommand(
  env: ForgeEnv,
  repo: RepoRecord,
  command: string,
  timeoutMs = 120_000,
) {
  const id = crypto.randomUUID();
  const { sandbox, cwd } = await mountWorkspace(env, repo, repo.default_branch, id, 'read');
  try {
    const result = await sandbox.exec(command, {
      cwd,
      env: { FORGE_REPOSITORY: `${repo.owner}/${repo.name}` },
      timeout: Math.min(Math.max(timeoutMs, 1_000), 600_000),
    });
    if (!result.success) throw new Error(result.stderr || `git command failed with ${result.exitCode}`);
    return result.stdout;
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

export async function diffWorkspace(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  return runWorkspaceCommand(
    env,
    workspaceId,
    repo,
    'git diff --no-ext-diff --binary && git status --short',
    120_000,
    false,
  );
}

export async function commitWorkspace(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  input: { message: string; authorName?: string; authorEmail?: string },
) {
  const session = await getWorkspaceSession(env, workspaceId, repo);
  await assertWorkspaceWritable(env, repo, session);
  const name = input.authorName ?? 'Forge Agent';
  const email = input.authorEmail ?? 'forge-agent@localhost';
  const command = [
    `git config user.name ${shellQuote(name)}`,
    `git config user.email ${shellQuote(email)}`,
    'git add -A',
    `git commit -m ${shellQuote(input.message)}`,
    'git rev-parse HEAD',
  ].join(' && ');
  return runWorkspaceCommand(env, workspaceId, repo, command, 120_000, true);
}

export async function pushWorkspace(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  ref: string,
) {
  const session = await getWorkspaceSession(env, workspaceId, repo);
  await assertWorkspaceWritable(env, repo, session);

  const sandbox = workspaceSandbox(env, workspaceId);
  const auth = await freshAuth(env, repo, 'write');
  const cwd = workspaceRoot(repo);
  const configure = await sandbox.exec(
    `git config http.extraHeader ${shellQuote(`Authorization: ${auth.authorization}`)}`,
    { cwd, timeout: 10_000 },
  );
  if (!configure.success) throw new Error(`could not refresh git credentials: ${configure.stderr}`);
  const pushed = await sandbox.exec(`git push origin HEAD:${shellQuote(ref)}`, {
    cwd,
    timeout: 120_000,
  });
  return {
    success: pushed.success,
    exitCode: pushed.exitCode,
    stdout: pushed.stdout,
    stderr: pushed.stderr,
  };
}

export async function destroyWorkspace(env: ForgeEnv, workspaceId: string) {
  await closeAgentSession(env, workspaceId).catch(() => undefined);
  await workspaceSandbox(env, workspaceId).destroy();
  return { destroyed: true, workspaceId };
}
