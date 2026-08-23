import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { ForgeEnv } from './env';

export class ForgeCI extends CIWorkflow<CloudflareArtifacts, ForgeEnv> {
  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const bootstrap = await ci.runner({
      name: 'bootstrap',
      command: [
        'set -e',
        'if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile;',
        'elif [ -f package-lock.json ]; then npm ci;',
        'elif [ -f yarn.lock ]; then corepack enable && yarn install --immutable;',
        'elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile;',
        'fi',
      ].join(' '),
    });

    await Promise.all([
      bootstrap.runner({
        name: 'lint',
        command: "if [ -f package.json ]; then npm run lint --if-present; elif [ -x .forge/lint.sh ]; then .forge/lint.sh; fi",
      }),
      bootstrap.runner({
        name: 'test',
        command: "if [ -f package.json ]; then npm run test --if-present; elif [ -x .forge/test.sh ]; then .forge/test.sh; fi",
      }),
      bootstrap.runner({
        name: 'typecheck',
        command: "if [ -f package.json ]; then npm run typecheck --if-present; elif [ -x .forge/typecheck.sh ]; then .forge/typecheck.sh; fi",
      }),
      bootstrap.runner({
        name: 'build',
        command: "if [ -f package.json ]; then npm run build --if-present; elif [ -x .forge/build.sh ]; then .forge/build.sh; fi",
      }),
    ]);

    await bootstrap.runner({
      name: 'deploy',
      command: 'if [ -x .forge/deploy.sh ]; then .forge/deploy.sh; fi',
      cloudflareCredentials: { accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID },
    });
  }
}
