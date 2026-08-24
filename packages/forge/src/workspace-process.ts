import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { assertWorkspaceWritable, prepareWorkspaceOperation } from './workspace';

function processView(process: {
  id: string;
  pid?: number;
  command: string;
  status: string;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  sessionId?: string;
}) {
  return {
    id: process.id,
    pid: process.pid,
    command: process.command,
    status: process.status,
    startTime: process.startTime instanceof Date ? process.startTime.toISOString() : String(process.startTime),
    endTime: process.endTime instanceof Date ? process.endTime.toISOString() : process.endTime ? String(process.endTime) : undefined,
    exitCode: process.exitCode,
    sessionId: process.sessionId,
  };
}

function agentEnv(
  repo: RepoRecord,
  cwd: string,
  session: { ref: string; access_mode: 'read-only' | 'write-capable' },
  context: { authority: { headSha?: string | null; target?: { kind: string; number: number } | null } },
) {
  return {
    FORGE_CONTEXT_PATH: `${cwd}/.git/forge/context.json`,
    FORGE_CONTEXT_MD: `${cwd}/.git/forge/AGENT_CONTEXT.md`,
    FORGE_REPOSITORY: `${repo.owner}/${repo.name}`,
    FORGE_REF: session.ref,
    FORGE_HEAD_SHA: context.authority.headSha ?? '',
    FORGE_TARGET_KIND: context.authority.target?.kind ?? '',
    FORGE_TARGET_NUMBER: context.authority.target ? String(context.authority.target.number) : '',
    FORGE_WORKING_TREE: session.access_mode,
  };
}

export async function startWorkspaceProcess(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  command: string,
  options: { processId?: string; timeoutMs?: number; autoCleanup?: boolean } = {},
) {
  const { session, context, sandbox, cwd } = await prepareWorkspaceOperation(env, workspaceId, repo);
  // A background command can mutate arbitrary workspace state. Fail closed for
  // read-only sessions instead of attempting to classify shell commands.
  await assertWorkspaceWritable(env, repo, session);
  const process = await sandbox.startProcess(command, {
    cwd,
    env: agentEnv(repo, cwd, session, context),
    processId: options.processId,
    timeoutMs: options.timeoutMs,
    autoCleanup: options.autoCleanup ?? false,
  });
  return { process: processView(process), context };
}

export async function listWorkspaceProcesses(env: ForgeEnv, workspaceId: string, repo: RepoRecord) {
  const { context, sandbox } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const processes = await sandbox.listProcesses();
  return { processes: processes.map(processView), context };
}

export async function getWorkspaceProcess(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  processId: string,
) {
  const { context, sandbox } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const process = await sandbox.getProcess(processId);
  if (!process) throw new Error(`process ${processId} not found in workspace ${workspaceId}`);
  const status = await process.getStatus();
  return { process: { ...processView(process), status }, context };
}

export async function getWorkspaceProcessLogs(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  processId: string,
) {
  const { context, sandbox } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const process = await sandbox.getProcess(processId);
  if (!process) throw new Error(`process ${processId} not found in workspace ${workspaceId}`);
  const [status, logs] = await Promise.all([process.getStatus(), process.getLogs()]);
  return { process: { ...processView(process), status }, logs, context };
}

export async function killWorkspaceProcess(
  env: ForgeEnv,
  workspaceId: string,
  repo: RepoRecord,
  processId: string,
  signal = 'SIGTERM',
) {
  const { context, sandbox } = await prepareWorkspaceOperation(env, workspaceId, repo);
  const process = await sandbox.getProcess(processId);
  if (!process) throw new Error(`process ${processId} not found in workspace ${workspaceId}`);
  await process.kill(signal);
  return { processId, killed: true, signal, context };
}
