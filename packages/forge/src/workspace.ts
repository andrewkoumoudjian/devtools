import { getSandbox } from '@cloudflare/sandbox';
import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { artifactClient } from './artifacts';

const MOUNT_SCRIPT = '/usr/local/bin/mount-artifact-fs-repo';
const MOUNT_ROOT = '/workspace/mnt';
type SandboxId = `${string}-${string}-${string}-${string}-${string}`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function basicAuth(token: string): string {
  const secret = token.split('?expires=', 1)[0] ?? token;
  return btoa(`x:${secret}`);
}

function sandboxFor(env: ForgeEnv, id: string) {
  return getSandbox(env.WORKSPACE_SANDBOX as never, id as SandboxId, {
    enableDefaultSession: false,
    normalizeId: true,
    sleepAfter: '30m',
    transport: 'rpc',
  });
}

async function freshAuth(env: ForgeEnv, repo: RepoRecord) {
  const artifacts = artifactClient(env);
  const info = await artifacts.get(repo.artifact_name);
  const token = await artifacts.createToken(repo.artifact_name, 'write', 3600);
  return { remote: info.remote, authorization: `Basic ${basicAuth(token.plaintext)}` };
}

export async function createWorkspace(
  env: ForgeEnv,
  repo: RepoRecord,
  branch: string,
  workspaceId = crypto.randomUUID(),
) {
  const sandbox = sandboxFor(env, workspaceId);
  const auth = await freshAuth(env, repo);
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
    throw new Error(`workspace mount failed (${result.exitCode}): ${result.stderr.slice(0, 500)}`);
  }
  return {
    workspaceId,
    repo: `${repo.owner}/${repo.name}`,
    branch,
    mountPath: `${MOUNT_ROOT}/${repo.artifact_name}`,
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
  const result = await sandbox.exec(command, {
    cwd: `${MOUNT_ROOT}/${repo.artifact_name}`,
    timeout: Math.min(Math.max(timeoutMs, 1_000), 600_000),
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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
  const auth = await freshAuth(env, repo);
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
  await sandboxFor(env, workspaceId).destroy();
  return { destroyed: true, workspaceId };
}
