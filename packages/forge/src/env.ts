import type { CiBindings } from '@cloudflare/ci/worker';

export type ForgeEnv = CiBindings & {
  DB: D1Database;
  WORKSPACE_SANDBOX: DurableObjectNamespace;
  REPO_MEMORY: AgentMemoryNamespace;
  ARTIFACTS_NAMESPACE: string;
  ARTIFACTS_API_TOKEN: string;
  CLOUDFLARE_DEPLOY_ACCOUNT_ID: string;
};

export type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};
