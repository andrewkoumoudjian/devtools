import { getSandbox } from '@cloudflare/sandbox';
import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { artifactClient } from './artifacts';
import { buildRepoContext, repoContextMarkdown, type ContextTarget } from './context';
import { closeAgentSession, openAgentSession, touchAgentSession } from './product';

const MOUNT_SCRIPT = '/usr/local/bin/mount-artifact-fs-repo';
const MOUNT_ROOT = '/workspace/mnt';
type SandboxId = `${string}-${string}-${string}-${string}-${string}`;

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

function sandboxFor(env: ForgeEnv, id: string) {
  return getSandbox(env.WORKSPACE_SANDBOX as never, id as SandboxId, {
    enableDefaultSession: false,
    normalizeId: true,
    sleepAfter: '30m',
    transport: 'rpc',
  });
}

async function freshAuth(env: ForgeEnv, repo: RepoRecord, scope: 'read' | 'write' = 'write') {
  const artifacts = artifactClient(env);
  const info = await artifacts.get(repo.artifact_name);
  const token = await artifacts.createToken(repo.artifact_name, scope, 3600);
  return { remote: info.remote, authorization: `Basic ${basicAuth(token.plaintext)}` };
}

async function mountWorkspace(env: ForgeEnv, repo: RepoRecord, branch: string, workspaceId: string, scope: 'read' | 'write') {
  const sandbox = sandboxFor(env, workspaceId);
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
  return { sandbox, auth, cwd: `${MOUNT_ROOT}/${repo.artifact_name}` };
}

async function currentBranch(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  const result = await sandboxFor(env, workspaceId).exec('git branch --show-current', {
    cwd: `${MOUNT_ROOT}/${repo.artifact_name}`,
    timeout: 10_000,
  });
  return result.success && result.stdout.trim() ? result.stdout.trim() : repo.default_branch;
}

export async function syncWorkspaceContext(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  ref: string,
  options: { agentName?: string; target?: ContextTarget; accessMode?: 'read-only' | 'write-capable' } = {},
) {
  const sandbox = sandboxFor(env, workspaceId);
  const cwd = `${MOUNT_ROOT}/${repo.artifact_name}`;
  const context = await buildRepoContext(env, repo, {
    ref,
    target: options.target,
    agentName: options.agentName,
    accessMode: options.accessMode,
  });
  const json = JSON.stringify(context, null, 2);
  const markdown = repoContextMarkdown(context);
  const command = [
    'mkdir -p .git/forge',
    `printf %s ${shellQuote(base64Utf8(json))} | base64 -d > .git/forge/context.json`,
    `printf %s ${shellQuote(base64Utf8(markdown))} | base64 -d > .git/forge/AGENT_CONTEXT.md`,
  ].join(' && ');
  const result = await sandbox.exec(command, { cwd, timeout: 20_000 });
  if (!result.success) throw new Error(`could not synchronize Forge context: ${result.stderr.slice(0, 500)}`);
  return context;
}

export async function createWorkspace(
  env: ForgeEnv,
  repo: RepoRecord,
  branch: string,
  workspaceId = crypto.randomUUID(),
  options: { agentName?: string; target?: ContextTarget; accessMode?: 'read-only' | 'write-capable' } = {},
) {
  const accessMode = options.accessMode ?? 'write-capable';
  const { cwd } = await mountWorkspace(env, repo, branch, workspaceId, accessMode === 'read-only' ? 'read' : 'write');
  const context = await syncWorkspaceContext(env, workspaceId, repo, branch, { ...options, accessMode });
  await openAgentSession(env, repo, {
    id: workspaceId,
    agentName: options.agentName,
    ref: branch,
    targetKind: options.target?.kind,
    targetNumber: options.target?.number,
    workspaceId,
    accessMode,
  });
  return {
    workspaceId,
    repo: `${repo.owner}/${repo.name}`,
    branch,
    mountPath: cwd,
    contextPath: `${cwd}/.git/forge/context.json`,
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
  const sandbox = sandboxFor(env, workspaceId);
  const cwd = `${MOUNT_ROOT}/${repo.artifact_name}`;
  const branch = await currentBranch(env, workspaceId, repo);
  await syncWorkspaceContext(env, workspaceId, repo, branch).catch(() => undefined);
  await touchAgentSession(env, workspaceId).catch(() => undefined);
  const result = await sandbox.exec(command, {
    cwd,
    env: {
      FORGE_CONTEXT_PATH: `${cwd}/.git/forge/context.json`,
      FORGE_CONTEXT_MD: `${cwd}/.git/forge/AGENT_CONTEXT.md`,
      FORGE_REPOSITORY: `${repo.owner}/${repo.name}`,
      FORGE_REF: branch,
    },
    timeout: Math.min(Math.max(timeoutMs, 1_000), 600_000),
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function repoGitCommand(
  env: ForgeEnv,
  repo: RepoRecord,
  ref: string,
  command: string,
  timeoutMs = 120_000,
) {
  const id = crypto.randomUUID();
  const { sandbox, cwd } = await mountWorkspace(env, repo, ref, id, 'read');
  try {
    const result = await sandbox.exec(command, {
      cwd,
      env: { FORGE_REPOSITORY: `${repo.owner}/${repo.name}`, FORGE_REF: ref },
      timeout: Math.min(Math.max(timeoutMs, 1_000), 600_000),
    });
    if (!result.success) throw new Error(result.stderr || `git command failed with ${result.exitCode}`);
    return result.stdout;
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

export async function diffWorkspace(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  return execWorkspace(env, workspaceId, repo, 'git diff --no-ext-diff --binary && git status --short');
}

export async function commitWorkspace(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  input: { message: string; authorName?: string; authorEmail?: string },
) {
  const name = input.authorName ?? 'Forge Agent';
  const email = input.authorEmail ?? 'forge-agent@localhost';
  const command = [
    `git config user.name ${shellQuote(name)}`,
    `git config user.email ${shellQuote(email)}`,
    'git add -A',
    `git commit -m ${shellQuote(input.message)}`,
    'git rev-parse HEAD',
  ].join(' && ');
  return execWorkspace(env, workspaceId, repo, command);
}

export async function pushWorkspace(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  ref: string,
) {
  const sandbox = sandboxFor(env, workspaceId);
  const auth = await freshAuth(env, repo, 'write');
  const cwd = `${MOUNT_ROOT}/${repo.artifact_name}`;
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
  await sandboxFor(env, workspaceId).destroy();
  return { destroyed: true, workspaceId };
}
