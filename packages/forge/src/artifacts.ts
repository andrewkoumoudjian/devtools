import { createArtifact } from '@cloudflare/computer/artifacts';
import type { ForgeEnv } from './env';
import { fetchWithRetry } from './http';

export type GitRef = {
  name: string;
  hash: string;
  type: 'branch' | 'tag' | 'other';
};

export type GitRefs = {
  head: string | null;
  headHash: string | null;
  branches: GitRef[];
  tags: GitRef[];
  other: GitRef[];
};

export type ArtifactsGitIdentity = { name: string; email: string };
export type ArtifactsCommit = {
  hash: string;
  treeHash: string;
  message: string;
  author: ArtifactsGitIdentity;
  committer: ArtifactsGitIdentity;
  parents: string[];
  authoredAt: number;
  committedAt: number;
};
export type ArtifactsTreeEntry = {
  name: string;
  mode: string;
  hash: string;
  type: 'tree' | 'blob' | 'symlink' | 'gitlink' | 'exec';
};

export function artifactClient(env: ForgeEnv) {
  return createArtifact(env.ARTIFACTS, undefined);
}

export function credentialedRemote(remote: string, token: string): string {
  const secret = encodeURIComponent(token.split('?expires=', 1)[0] ?? token);
  const sep = remote.indexOf('://');
  if (sep === -1) return remote;
  return `${remote.slice(0, sep + 3)}x:${secret}@${remote.slice(sep + 3)}`;
}

function basicAuth(token: string): string {
  const secret = token.split('?expires=', 1)[0] ?? token;
  return `Basic ${btoa(`x:${secret}`)}`;
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
  const response = await fetchWithRetry(artifactsRestUrl(env, repo, segments, query), {
    headers: {
      accept,
      authorization: `Bearer ${env.ARTIFACTS_API_TOKEN}`,
    },
  }, { timeoutMs: 10_000, retries: 2 });
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

export async function artifactBlob(
  env: ForgeEnv,
  repo: string,
  hash: string,
): Promise<Response> {
  return artifactFetch(env, repo, ['blob', hash], undefined, 'application/octet-stream');
}

export async function artifactBlobText(
  env: ForgeEnv,
  repo: string,
  hash: string,
  maxBytes = 1_000_000,
): Promise<string | null> {
  const response = await artifactBlob(env, repo, hash);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes || bytes.includes(0)) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function artifactLog<T = ArtifactsCommit[]>(
  env: ForgeEnv,
  repo: string,
  ref?: string,
  limit = 50,
  offset = 0,
): Promise<T> {
  return artifactJson<T>(env, repo, ['log'], { ref, limit, offset });
}

export async function artifactTree<T = ArtifactsTreeEntry[]>(env: ForgeEnv, repo: string, hash: string): Promise<T> {
  return artifactJson<T>(env, repo, ['tree', hash]);
}

export async function artifactCommit<T = ArtifactsCommit>(env: ForgeEnv, repo: string, hash: string): Promise<T> {
  return artifactJson<T>(env, repo, ['commit', hash]);
}

function parsePktLines(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const lengthText = decoder.decode(bytes.slice(offset, offset + 4));
    const length = Number.parseInt(lengthText, 16);
    if (!Number.isFinite(length)) break;
    offset += 4;
    if (length === 0 || length === 1 || length === 2) continue;
    if (length < 4 || offset + length - 4 > bytes.length) break;
    lines.push(decoder.decode(bytes.slice(offset, offset + length - 4)).replace(/\n$/, ''));
    offset += length - 4;
  }
  return lines;
}

function parseRefAdvertisement(lines: string[]): GitRefs {
  const branches: GitRef[] = [];
  const tags: GitRef[] = [];
  const other: GitRef[] = [];
  let head: string | null = null;
  let headHash: string | null = null;

  for (const raw of lines) {
    const line = raw.startsWith('# service=') || raw.startsWith('version ') ? '' : raw.split('\0', 1)[0] ?? '';
    if (!line) continue;
    if (line.startsWith('symref=HEAD:')) {
      head = line.slice('symref=HEAD:'.length).split(' ', 1)[0] ?? null;
      continue;
    }
    const match = line.match(/^([0-9a-f]{40,64})\s+([^\s]+)(?:\s|$)/i);
    if (!match) continue;
    const hash = match[1]!;
    const ref = match[2]!;
    if (ref === 'HEAD') {
      headHash = hash;
      continue;
    }
    if (ref.endsWith('^{}')) continue;
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice(11), hash, type: 'branch' });
    else if (ref.startsWith('refs/tags/')) tags.push({ name: ref.slice(10), hash, type: 'tag' });
    else other.push({ name: ref, hash, type: 'other' });
  }

  for (const raw of lines) {
    const sym = raw.match(/symref=HEAD:([^\s\0]+)/);
    if (sym) head = sym[1]!;
  }

  return { head, headHash, branches, tags, other };
}

export async function artifactGitRefs(env: ForgeEnv, repoName: string): Promise<GitRefs> {
  const artifacts = artifactClient(env);
  const info = await artifacts.get(repoName);
  const token = await artifacts.createToken(repoName, 'read', 300);
  const response = await fetchWithRetry(`${info.remote}/info/refs?service=git-upload-pack`, {
    headers: {
      accept: 'application/x-git-upload-pack-advertisement',
      authorization: basicAuth(token.plaintext),
      'git-protocol': 'version=1',
    },
  }, { timeoutMs: 10_000, retries: 2 });
  try {
    if (!response.ok) throw new Error(`Artifacts git ref advertisement failed: ${response.status}`);
    return parseRefAdvertisement(parsePktLines(new Uint8Array(await response.arrayBuffer())));
  } finally {
    await artifacts.revokeToken(repoName, token.id).catch(() => undefined);
  }
}
