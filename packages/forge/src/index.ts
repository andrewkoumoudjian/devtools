import { Hono } from 'hono';
import { routeArtifactRequest } from 'artifacts-viewer';
import { createCacheApiAdapter } from 'artifacts-viewer/server/cache';
import { createMcpHandler } from 'agents/mcp/server';
import { CiSandbox } from '@cloudflare/ci/worker';
import type { ForgeEnv } from './env';
import { capabilityRegistry } from './capabilities';
import { createForgeMcpServer } from './mcp';
import { getRepoRecord, listCiRuns } from './db';

export { CiSandbox };
export { Sandbox } from '@cloudflare/sandbox';
export { ForgeCI } from './ci';
export { ForgeConnector } from './codemode';

const app = new Hono<{ Bindings: ForgeEnv }>();

app.get('/health', (c) => c.json({ ok: true, service: 'devtools-forge' }));
app.get('/api/capabilities', (c) => c.json({ capabilities: capabilityRegistry.list() }));
app.get('/api/capabilities/:name', (c) => {
  try {
    return c.json(capabilityRegistry.describe(c.req.param('name')));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});
app.get('/api/search', (c) => c.json({ results: capabilityRegistry.search(c.req.query('q') ?? '') }));
app.post('/api/execute', async (c) => {
  try {
    const body = await c.req.json<{ name?: string; input?: unknown }>();
    if (!body.name) return c.json({ error: 'name is required' }, 400);

    // CI history is a read-only UI projection over forge metadata. Keep it on
    // the same execute wire shape while the canonical registry grows a richer
    // CI read surface (steps/logs/checks) in the next tranche.
    if (body.name === 'ci.list') {
      const input = body.input as { owner?: string; repo?: string } | undefined;
      if (!input?.owner || !input.repo) return c.json({ error: 'owner and repo are required' }, 400);
      const repo = await getRepoRecord(c.env, input.owner, input.repo);
      return c.json({ result: await listCiRuns(c.env, repo) });
    }

    const result = await capabilityRegistry.execute({ env: c.env }, body.name, body.input ?? {});
    return c.json({ result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

// Conventional REST aliases over the canonical capability registry.
app.get('/api/repos', async (c) => c.json(await capabilityRegistry.execute({ env: c.env }, 'repo.list', {})));
app.post('/api/repos', async (c) => c.json(await capabilityRegistry.execute({ env: c.env }, 'repo.create', await c.req.json()), 201));
app.get('/api/repos/:owner/:repo', async (c) => c.json(await capabilityRegistry.execute({ env: c.env }, 'repo.get', { owner: c.req.param('owner'), repo: c.req.param('repo') })));
app.get('/api/repos/:owner/:repo/commits', async (c) => c.json(await capabilityRegistry.execute({ env: c.env }, 'git.log', { owner: c.req.param('owner'), repo: c.req.param('repo'), ref: c.req.query('ref'), limit: Number(c.req.query('limit') ?? 30) })));
app.get('/api/repos/:owner/:repo/file', async (c) => c.json(await capabilityRegistry.execute({ env: c.env }, 'fs.read', { owner: c.req.param('owner'), repo: c.req.param('repo'), ref: c.req.query('ref') ?? 'main', path: c.req.query('path') ?? '' })));
app.post('/api/repos/:owner/:repo/workspaces', async (c) => {
  const body = await c.req.json<{ branch?: string; workspaceId?: string }>().catch(() => ({}));
  return c.json(await capabilityRegistry.execute({ env: c.env }, 'workspace.create', { owner: c.req.param('owner'), repo: c.req.param('repo'), ...body }), 201);
});

export default {
  async fetch(request: Request, env: ForgeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return createMcpHandler(() => createForgeMcpServer(env), {
        route: '/mcp',
        legacy: 'stateless',
        responseMode: 'auto',
      })(request, env, ctx);
    }

    if (url.pathname === '/artifacts' || url.pathname.startsWith('/artifacts/')) {
      const handled = await routeArtifactRequest(request, {
        apiPath: '/artifacts',
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        namespace: env.ARTIFACTS_NAMESPACE,
        apiToken: env.ARTIFACTS_API_TOKEN,
        cache: createCacheApiAdapter({ cache: caches.default, baseUrl: url.origin }),
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
      if (handled) return handled;
    }

    // Non-API requests intentionally return 404 here. With the Cloudflare Vite
    // plugin and `assets.not_found_handling = single-page-application`, the
    // built Primer/React SPA is served after the Worker declines the request.
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<ForgeEnv>;
