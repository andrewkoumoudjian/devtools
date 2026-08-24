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

// @cloudflare/computer 0.2.1 publishes a stricter two-argument type for
// createArtifact than the current upstream implementation, which explicitly
// permits an omitted session id for a namespace-wide administrative client.
// Keep that compatibility mismatch isolated here instead of spreading casts to
// every caller. This forge intentionally administers the whole Artifacts
// namespace; tenant isolation happens at the forge authorization layer.
type NamespaceArtifactFactory = (
  binding: Parameters<typeof createArtifact>[0],
) => ReturnType<typeof createArtifact>;
const createNamespaceArtifact = createArtifact as unknown as NamespaceArtifactFactory;

export function artifactClient(env: ForgeEnv) {
  return createNamespaceArtifact(env.ARTIFACTS);
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

function assertReadableText(bytes: Uint8Array, maxBytes: number, declaredBytes = 0) {
  if (declaredBytes > maxBytes || bytes.byteLength > maxBytes) {
    throw new Error(`Artifacts text object exceeds maxBytes (${Math.max(declaredBytes, bytes.byteLength)} > ${maxBytes})`);
  }
  if (bytes.includes(0)) throw new Error('Artifacts object appears to be binary');
}

async function responseText(response: Response, maxBytes: number) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0;
  if (declared > maxBytes) throw new Error(`Artifacts text object exceeds maxBytes (${declared} > ${maxBytes})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertReadableText(bytes, maxBytes, declared);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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

export async function artifactText(
  env: ForgeEnv,
  repo: string,
  ref: string,
  path: string,
  maxBytes = 1_000_000,
): Promise<string> {
  return responseText(await artifactFile(env, repo, ref, path), maxBytes);
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
): Promise<string> {
  return responseText(await artifactBlob(env, repo, hash), maxBytes);
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

// Stable forge-facing name retained for callers. The implementation is the
// native Artifacts Git ref advertisement above, not an index stored by Forge.
export const artifactRefs = artifactGitRefs;
