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
  return createArtifact(env.ARTIFACTS);
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

export async function artifactBlob(
  env: ForgeEnv,
  repo: string,
  hash: string,
): Promise<Response> {
  return artifactFetch(env, repo, ['blob', hash], undefined, 'application/octet-stream');
}

async function boundedText(response: Response, label: string, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) throw new Error(`${label} is binary`);
  return new TextDecoder().decode(bytes);
}

export async function artifactText(
  env: ForgeEnv,
  repo: string,
  ref: string,
  path: string,
  maxBytes = 1_000_000,
): Promise<string> {
  return boundedText(await artifactFile(env, repo, ref, path), path, maxBytes);
}

export async function artifactBlobText(
  env: ForgeEnv,
  repo: string,
  hash: string,
  maxBytes = 1_000_000,
): Promise<string> {
  return boundedText(await artifactBlob(env, repo, hash), hash, maxBytes);
}

export async function artifactRaw(
  env: ForgeEnv,
  repo: string,
  ref: string,
  path: string,
): Promise<Response> {
  return artifactFetch(env, repo, ['raw', ref, ...path.split('/')], undefined, '*/*');
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

function parsePktLines(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const prefix = decoder.decode(bytes.slice(offset, offset + 4));
    const length = Number.parseInt(prefix, 16);
    if (!Number.isFinite(length)) break;
    offset += 4;
    if (length === 0) continue;
    if (length < 4 || offset + length - 4 > bytes.length) break;
    const payload = decoder.decode(bytes.slice(offset, offset + length - 4));
    offset += length - 4;
    lines.push(payload.replace(/\n$/, ''));
  }
  return lines;
}

export async function artifactRefs(env: ForgeEnv, repoName: string): Promise<GitRefs> {
  const client = artifactClient(env);
  const [repo, token] = await Promise.all([
    client.get(repoName),
    client.createToken(repoName, 'read', 300),
  ]);
  const url = new URL(repo.remote.replace(/\/+$/, '') + '/info/refs');
  url.searchParams.set('service', 'git-upload-pack');
  const response = await fetchWithRetry(url, {
    headers: {
      accept: 'application/x-git-upload-pack-advertisement',
      authorization: basicAuth(token.plaintext),
    },
  }, { timeoutMs: 10_000, retries: 2 });
  if (!response.ok) throw new Error(`Git ref advertisement failed (${response.status})`);

  const packets = parsePktLines(new Uint8Array(await response.arrayBuffer()));
  const refs: GitRef[] = [];
  let head: string | null = null;
  let headHash: string | null = null;

  for (const packet of packets) {
    if (!packet || packet.startsWith('# service=')) continue;
    const [record, capabilities = ''] = packet.split('\0', 2);
    const separator = record.indexOf(' ');
    if (separator <= 0) continue;
    const hash = record.slice(0, separator);
    const name = record.slice(separator + 1);
    if (!/^[0-9a-f]{40,64}$/i.test(hash)) continue;
    if (name === 'HEAD') {
      headHash = hash;
      const match = capabilities.match(/(?:^| )symref=HEAD:([^ ]+)/);
      head = match?.[1]?.replace(/^refs\/heads\//, '') ?? null;
      continue;
    }
    if (name.endsWith('^{}')) continue;
    refs.push({
      name: name.replace(/^refs\/(heads|tags)\//, ''),
      hash,
      type: name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/tags/') ? 'tag' : 'other',
    });
  }

  const byName = (a: GitRef, b: GitRef) => a.name.localeCompare(b.name);
  return {
    head,
    headHash,
    branches: refs.filter((ref) => ref.type === 'branch').sort(byName),
    tags: refs.filter((ref) => ref.type === 'tag').sort(byName),
    other: refs.filter((ref) => ref.type === 'other').sort(byName),
  };
}
