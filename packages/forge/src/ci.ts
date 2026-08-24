import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CiRunnerResult, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { ForgeEnv } from './env';
import {
  createNotification,
  ensureCiRun,
  finishCiStep,
  getRepoByArtifactName,
  recordContextEvent,
  startCiStep,
  updateCiRunStatus,
} from './product';

const EXIT_MARKER = '__FORGE_STEP_EXIT_CODE__=';

type RunnerStart = (options: { name: string; command: string; cloudflareCredentials?: boolean | { accountId: string } }) => Promise<CiRunnerResult>;

function wrappedCommand(command: string) {
  return [
    'set +e',
    `{ ${command}; }`,
    'forge_status=$?',
    `printf '\\n${EXIT_MARKER}%s\\n' "$forge_status"`,
    'exit 0',
  ].join('\n');
}

async function logText(log: string | ReadableStream<Uint8Array>) {
  return typeof log === 'string' ? log : new Response(log).text();
}

function extractExitCode(stdout: string) {
  const index = stdout.lastIndexOf(EXIT_MARKER);
  if (index === -1) return 0;
  const raw = stdout.slice(index + EXIT_MARKER.length).split(/\r?\n/, 1)[0] ?? '0';
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

function stripExitMarker(stdout: string) {
  return stdout.replace(new RegExp(`\\n?${EXIT_MARKER}\\d+\\r?\\n?$`), '');
}

async function persistLogs(env: ForgeEnv, runId: string, stepId: string, stdout: string, stderr: string) {
  const prefix = `forge-ci/logs/${runId}/${stepId}`;
  const stdoutKey = `${prefix}/stdout.log`;
  const stderrKey = `${prefix}/stderr.log`;
  await Promise.all([
    env.BACKUP_BUCKET.put(stdoutKey, stdout, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }),
    env.BACKUP_BUCKET.put(stderrKey, stderr, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }),
  ]);
  return { stdoutKey, stderrKey };
}

async function trackedRunner(
  env: ForgeEnv,
  runId: string,
  name: string,
  command: string,
  start: RunnerStart,
  options: { cloudflareCredentials?: boolean | { accountId: string } } = {},
) {
  const step = await startCiStep(env, runId, name);
  try {
    const result = await start({ name, command: wrappedCommand(command), ...options });
    const [rawStdout, stderr] = await Promise.all([logText(result.logs.stdout), logText(result.logs.stderr)]);
    const exitCode = extractExitCode(rawStdout);
    const stdout = stripExitMarker(rawStdout);
    const keys = await persistLogs(env, runId, step.id, stdout, stderr);
    await finishCiStep(env, step.id, {
      status: exitCode === 0 ? 'success' : 'failure',
      exitCode,
      ...keys,
    });
    if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const key = `forge-ci/logs/${runId}/${step.id}/stderr.log`;
    await env.BACKUP_BUCKET.put(key, message, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }).catch(() => undefined);
    await finishCiStep(env, step.id, { status: 'failure', stderrKey: key }).catch(() => undefined);
    throw error;
  }
}

export class ForgeCI extends CIWorkflow<CloudflareArtifacts, ForgeEnv> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const payload = event.payload;
    const repo = await getRepoByArtifactName(this.env, payload.repo);
    const run = await ensureCiRun(this.env, repo, {
      ref: payload.ref,
      sha: payload.sha,
      workflowInstanceId: event.instanceId,
    });
    await updateCiRunStatus(this.env, run.id, 'running');

    if (repo) {
      await recordContextEvent(this.env, repo, {
        kind: 'ci.started',
        ref: payload.ref,
        sha: payload.sha,
        payload: { runId: run.id, workflowInstanceId: event.instanceId, trigger: payload.trigger },
      });
    }

    try {
      const bootstrap = await trackedRunner(
        this.env,
        run.id,
        'bootstrap',
        [
          'set -e',
          'if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile;',
          'elif [ -f package-lock.json ]; then npm ci;',
          'elif [ -f yarn.lock ]; then corepack enable && yarn install --immutable;',
          'elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile;',
          'fi',
        ].join(' '),
        (options) => ci.runner(options),
      );

      const child = (options: { name: string; command: string; cloudflareCredentials?: boolean | { accountId: string } }) => bootstrap.runner(options);
      await Promise.all([
        trackedRunner(this.env, run.id, 'lint', "if [ -f package.json ]; then npm run lint --if-present; elif [ -x .forge/lint.sh ]; then .forge/lint.sh; fi", child),
        trackedRunner(this.env, run.id, 'test', "if [ -f package.json ]; then npm run test --if-present; elif [ -x .forge/test.sh ]; then .forge/test.sh; fi", child),
        trackedRunner(this.env, run.id, 'typecheck', "if [ -f package.json ]; then npm run typecheck --if-present; elif [ -x .forge/typecheck.sh ]; then .forge/typecheck.sh; fi", child),
        trackedRunner(this.env, run.id, 'build', "if [ -f package.json ]; then npm run build --if-present; elif [ -x .forge/build.sh ]; then .forge/build.sh; fi", child),
      ]);

      await trackedRunner(
        this.env,
        run.id,
        'deploy',
        'if [ -x .forge/deploy.sh ]; then .forge/deploy.sh; fi',
        child,
        { cloudflareCredentials: { accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID } },
      );

      await updateCiRunStatus(this.env, run.id, 'success');
      if (repo) {
        await Promise.all([
          recordContextEvent(this.env, repo, { kind: 'ci.succeeded', ref: payload.ref, sha: payload.sha, payload: { runId: run.id } }),
          createNotification(this.env, repo, { kind: 'ci.succeeded', title: `CI passed on ${payload.ref}`, body: payload.sha }),
        ]);
      }
    } catch (error) {
      await updateCiRunStatus(this.env, run.id, 'failure');
      if (repo) {
        await Promise.all([
          recordContextEvent(this.env, repo, { kind: 'ci.failed', ref: payload.ref, sha: payload.sha, payload: { runId: run.id, error: error instanceof Error ? error.message : String(error) } }),
          createNotification(this.env, repo, { kind: 'ci.failed', title: `CI failed on ${payload.ref}`, body: error instanceof Error ? error.message : String(error) }),
        ]);
      }
      throw error;
    }
  }
}
