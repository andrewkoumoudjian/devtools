import { createArtifact } from '@cloudflare/computer/artifacts';
import type { ForgeEnv } from './env';

export function artifactClient(env: ForgeEnv) {
  return createArtifact(env.ARTIFACTS);
}

export function credentialedRemote(remote: string, token: string): string {
  const secret = encodeURIComponent(token.split('?expires=', 1)[0] ?? token);
  const sep = remote.indexOf('://');
  if (sep === -1) return remote;
  return `${remote.slice(0, sep + 3)}x:${secret}@${remote.slice(sep + 3)}`;
}

function artifactsRestUrl(
  env: ForgeEnv,
  repo: string,
  segments: readonly string[] = [],
  query?: Record<string, string | number | undefined>,
): URL {
  const parts = [
    'accounts',
    env.CLOUDFLARE_ACCOUNT_ID,
    'artifacts',
    'namespaces',
    env.ARTIFACTS_NAMESPACE,
    'repos',
    repo,
    ...segments,
  ];
  const url = new URL(
    `https://api.cloudflare.com/client/v4/${parts.map(encodeURIComponent).join('/')}`,
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function artifactFetch(
  env: ForgeEnv,
  repo: string,
  segments: readonly string[],
  query: Record<string, string | number | undefined> | undefined,
  accept: string,
): Promise<Response> {
  const response = await fetch(artifactsRestUrl(env, repo, segments, query), {
    headers: {
      accept,
      authorization: `Bearer ${env.ARTIFACTS_API_TOKEN}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Artifacts ${response.status}: ${text.slice(0, 500)}`);
  }
  return response;
}

export async function artifactJson<T>(
  env: ForgeEnv,
  repo: string,
  segments: readonly string[] = [],
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const response = await artifactFetch(env, repo, segments, query, 'application/json');
  const envelope = (await response.json()) as { result?: T; success?: boolean; errors?: unknown } | T;
  if (typeof envelope === 'object' && envelope !== null && 'result' in envelope) {
    return envelope.result as T;
  }
  return envelope as T;
}

export async function artifactFile(
  env: ForgeEnv,
  repo: string,
  ref: string,
  path: string,
): Promise<Response> {
  return artifactFetch(env, repo, ['file'], { ref, path }, 'application/octet-stream');
}

export async function artifactRaw(
  env: ForgeEnv,
  repo: string,
  ref: string,
  path: string,
): Promise<Response> {
  return artifactFetch(env, repo, ['raw', ref, ...path.split('/')], undefined, '*/*');
}

export async function artifactLog<T>(
  env: ForgeEnv,
  repo: string,
  ref?: string,
  limit = 50,
  offset = 0,
): Promise<T> {
  return artifactJson<T>(env, repo, ['log'], { ref, limit, offset });
}

export async function artifactTree<T>(env: ForgeEnv, repo: string, hash: string): Promise<T> {
  return artifactJson<T>(env, repo, ['tree', hash]);
}

export async function artifactCommit<T>(env: ForgeEnv, repo: string, hash: string): Promise<T> {
  return artifactJson<T>(env, repo, ['commit', hash]);
}
