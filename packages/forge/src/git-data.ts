import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import {
  artifactBlobText,
  artifactCommit,
  artifactLog,
  artifactRefs,
  artifactTree,
  type ArtifactsCommit,
  type ArtifactsTreeEntry,
  type GitRefs,
} from './artifacts';

export type ResolvedRevision = {
  input: string;
  hash: string;
  kind: 'branch' | 'tag' | 'commit';
};

export type RepoTreeEntry = ArtifactsTreeEntry & { path: string };

export type FileSearchMatch = {
  path: string;
  hash: string;
  type: ArtifactsTreeEntry['type'];
};

export type CodeSearchMatch = {
  path: string;
  hash: string;
  line: number;
  text: string;
};

export type FileChange = {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'type_changed';
  before: RepoTreeEntry | null;
  after: RepoTreeEntry | null;
  binary: boolean;
  truncated: boolean;
  patch: string | null;
};

const DEFAULT_TREE_LIMIT = 25_000;
const DEFAULT_TEXT_FILE_LIMIT = 512_000;
const DEFAULT_SEARCH_TOTAL_BYTES = 8_000_000;
const DEFAULT_SEARCH_FILE_LIMIT = 250;
const SKIP_SEARCH_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'target',
]);
const LIKELY_BINARY_EXTENSIONS = new Set([
  '7z', 'a', 'avi', 'bin', 'bmp', 'class', 'dmg', 'doc', 'docx', 'eot', 'exe', 'gif', 'gz', 'ico',
  'jar', 'jpeg', 'jpg', 'lockb', 'mov', 'mp3', 'mp4', 'o', 'otf', 'pdf', 'png', 'ppt', 'pptx', 'pyc',
  'rar', 'so', 'sqlite', 'tar', 'tgz', 'ttf', 'wav', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'zip',
]);

type TreeCache = Map<string, Promise<ArtifactsTreeEntry[]>>;
type CommitCache = Map<string, Promise<ArtifactsCommit>>;

type DiffOp = {
  type: 'equal' | 'insert' | 'delete';
  line: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function extension(path: string) {
  const name = path.split('/').at(-1) ?? path;
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index + 1).toLowerCase();
}

function shouldSkipPath(path: string) {
  return path.split('/').some((segment) => SKIP_SEARCH_SEGMENTS.has(segment));
}

function likelyBinary(path: string) {
  return LIKELY_BINARY_EXTENSIONS.has(extension(path));
}

async function cachedTree(env: ForgeEnv, repo: RepoRecord, hash: string, cache: TreeCache) {
  let promise = cache.get(hash);
  if (!promise) {
    promise = artifactTree<ArtifactsTreeEntry[]>(env, repo.artifact_name, hash);
    cache.set(hash, promise);
  }
  return promise;
}

async function cachedCommit(env: ForgeEnv, repo: RepoRecord, hash: string, cache: CommitCache) {
  let promise = cache.get(hash);
  if (!promise) {
    promise = artifactCommit<ArtifactsCommit>(env, repo.artifact_name, hash);
    cache.set(hash, promise);
  }
  return promise;
}

export async function resolveRevision(
  env: ForgeEnv,
  repo: RepoRecord,
  ref = repo.default_branch,
  knownRefs?: GitRefs,
): Promise<ResolvedRevision> {
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const commit = await artifactCommit<ArtifactsCommit>(env, repo.artifact_name, ref);
    return { input: ref, hash: commit.hash, kind: 'commit' };
  }

  const refs = knownRefs ?? await artifactRefs(env, repo.artifact_name);
  const branch = refs.branches.find((item) => item.name === ref);
  if (branch) return { input: ref, hash: branch.hash, kind: 'branch' };
  const tag = refs.tags.find((item) => item.name === ref);
  if (tag) return { input: ref, hash: tag.hash, kind: 'tag' };

  // REST file/log routes also accept commit hashes and may accept a ref not
  // advertised to an anonymous ref listing. Let Artifacts resolve it once
  // before treating it as unknown.
  const log = await artifactLog<ArtifactsCommit[]>(env, repo.artifact_name, ref, 1, 0).catch(() => []);
  if (log[0]?.hash) return { input: ref, hash: log[0].hash, kind: 'commit' };
  throw new Error(`unknown Git ref: ${ref}`);
}

export async function treeForRevision(env: ForgeEnv, repo: RepoRecord, revision: ResolvedRevision) {
  const commit = await artifactCommit<ArtifactsCommit>(env, repo.artifact_name, revision.hash);
  return { commit, treeHash: commit.treeHash };
}

export async function walkTree(
  env: ForgeEnv,
  repo: RepoRecord,
  treeHash: string,
  options: { maxEntries?: number; includeTrees?: boolean } = {},
): Promise<RepoTreeEntry[]> {
  const maxEntries = clamp(options.maxEntries ?? DEFAULT_TREE_LIMIT, 1, 100_000);
  const cache: TreeCache = new Map();
  const output: RepoTreeEntry[] = [];
  const queue: Array<{ hash: string; prefix: string }> = [{ hash: treeHash, prefix: '' }];

  while (queue.length) {
    const current = queue.shift()!;
    const entries = await cachedTree(env, repo, current.hash, cache);
    for (const entry of entries) {
      const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const row = { ...entry, path };
      if (entry.type === 'tree') {
        if (options.includeTrees) output.push(row);
        queue.push({ hash: entry.hash, prefix: path });
      } else {
        output.push(row);
      }
      if (output.length >= maxEntries) return output;
    }
  }
  return output;
}

export async function findPathEntry(
  env: ForgeEnv,
  repo: RepoRecord,
  treeHash: string,
  path: string,
  treeCache: TreeCache = new Map(),
): Promise<RepoTreeEntry | null> {
  const segments = path.split('/').filter(Boolean);
  if (!segments.length) return { name: '', mode: '040000', hash: treeHash, type: 'tree', path: '' };

  let currentHash = treeHash;
  let currentPath = '';
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index]!;
    const entries = await cachedTree(env, repo, currentHash, treeCache);
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return null;
    currentPath = currentPath ? `${currentPath}/${name}` : name;
    if (index === segments.length - 1) return { ...entry, path: currentPath };
    if (entry.type !== 'tree') return null;
    currentHash = entry.hash;
  }
  return null;
}

export async function searchFilePaths(
  env: ForgeEnv,
  repo: RepoRecord,
  ref: string,
  query: string,
  limit = 100,
) {
  const revision = await resolveRevision(env, repo, ref);
  const { treeHash } = await treeForRevision(env, repo, revision);
  const normalized = query.trim().toLowerCase();
  const entries = await walkTree(env, repo, treeHash, { maxEntries: DEFAULT_TREE_LIMIT, includeTrees: true });
  const matches = entries
    .filter((entry) => !normalized || entry.path.toLowerCase().includes(normalized))
    .slice(0, clamp(limit, 1, 500))
    .map<FileSearchMatch>((entry) => ({ path: entry.path, hash: entry.hash, type: entry.type }));
  return { ref, sha: revision.hash, matches };
}

export async function searchCode(
  env: ForgeEnv,
  repo: RepoRecord,
  ref: string,
  query: string,
  options: { limit?: number; maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; caseSensitive?: boolean } = {},
) {
  const revision = await resolveRevision(env, repo, ref);
  const { treeHash } = await treeForRevision(env, repo, revision);
  const all = await walkTree(env, repo, treeHash, { maxEntries: DEFAULT_TREE_LIMIT });
  const candidates = all
    .filter((entry) => entry.type !== 'gitlink' && !shouldSkipPath(entry.path) && !likelyBinary(entry.path))
    .slice(0, clamp(options.maxFiles ?? DEFAULT_SEARCH_FILE_LIMIT, 1, 1_000));
  const limit = clamp(options.limit ?? 100, 1, 500);
  const maxFileBytes = clamp(options.maxFileBytes ?? DEFAULT_TEXT_FILE_LIMIT, 1_024, 2_000_000);
  const maxTotalBytes = clamp(options.maxTotalBytes ?? DEFAULT_SEARCH_TOTAL_BYTES, maxFileBytes, 32_000_000);
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: CodeSearchMatch[] = [];
  let bytesRead = 0;
  let filesRead = 0;
  let truncated = candidates.length < all.length;

  for (const entry of candidates) {
    if (matches.length >= limit || bytesRead >= maxTotalBytes) { truncated = true; break; }
    try {
      const text = await artifactBlobText(env, repo.artifact_name, entry.hash, Math.min(maxFileBytes, maxTotalBytes - bytesRead));
      bytesRead += new TextEncoder().encode(text).byteLength;
      filesRead += 1;
      const lines = text.split('\n');
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index]!;
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) matches.push({ path: entry.path, hash: entry.hash, line: index + 1, text: line });
      }
    } catch {
      // Binary/oversized/unreadable blobs are not search candidates.
    }
  }

  return { ref, sha: revision.hash, query, matches, filesRead, bytesRead, truncated };
}

export async function lastCommitForPath(
  env: ForgeEnv,
  repo: RepoRecord,
  ref: string,
  path: string,
  maxCommits = 100,
) {
  const commits = await artifactLog<ArtifactsCommit[]>(
    env,
    repo.artifact_name,
    ref,
    clamp(maxCommits, 1, 500),
    0,
  );
  const treeCache: TreeCache = new Map();
  const commitCache: CommitCache = new Map();

  for (const commit of commits) {
    const current = await findPathEntry(env, repo, commit.treeHash, path, treeCache);
    if (!current && commit.parents.length === 0) continue;
    if (commit.parents.length === 0) return current ? commit : null;

    let unchangedInAnyParent = false;
    for (const parentHash of commit.parents) {
      const parent = await cachedCommit(env, repo, parentHash, commitCache);
      const previous = await findPathEntry(env, repo, parent.treeHash, path, treeCache);
      if (previous?.hash === current?.hash && previous?.type === current?.type) {
        unchangedInAnyParent = true;
        break;
      }
    }
    if (!unchangedInAnyParent) return commit;
  }
  return null;
}

function flatten(entries: RepoTreeEntry[]) {
  return new Map(entries.filter((entry) => entry.type !== 'tree').map((entry) => [entry.path, entry]));
}

function lineDiff(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const cellBudget = 350_000;

  if (n * m > cellBudget) {
    let prefix = 0;
    while (prefix < n && prefix < m && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && before[n - 1 - suffix] === after[m - 1 - suffix]) suffix += 1;
    return [
      ...before.slice(0, prefix).map((line) => ({ type: 'equal' as const, line })),
      ...before.slice(prefix, n - suffix).map((line) => ({ type: 'delete' as const, line })),
      ...after.slice(prefix, m - suffix).map((line) => ({ type: 'insert' as const, line })),
      ...before.slice(n - suffix).map((line) => ({ type: 'equal' as const, line })),
    ];
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const output: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      output.push({ type: 'equal', line: before[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      output.push({ type: 'delete', line: before[i]! });
      i += 1;
    } else {
      output.push({ type: 'insert', line: after[j]! });
      j += 1;
    }
  }
  while (i < n) output.push({ type: 'delete', line: before[i++]! });
  while (j < m) output.push({ type: 'insert', line: after[j++]! });
  return output;
}

function unifiedPatch(path: string, beforeText: string, afterText: string, context = 3) {
  const before = beforeText.replace(/\r\n/g, '\n').split('\n');
  const after = afterText.replace(/\r\n/g, '\n').split('\n');
  const ops = lineDiff(before, after);
  const changed = ops.map((op, index) => op.type === 'equal' ? -1 : index).filter((index) => index >= 0);
  if (!changed.length) return '';

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const oldBefore = new Uint32Array(ops.length + 1);
  const newBefore = new Uint32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i += 1) {
    oldBefore[i + 1] = oldBefore[i]! + (ops[i]!.type === 'insert' ? 0 : 1);
    newBefore[i + 1] = newBefore[i]! + (ops[i]!.type === 'delete' ? 0 : 1);
  }

  const chunks = [`--- a/${path}`, `+++ b/${path}`];
  for (const range of ranges) {
    const slice = ops.slice(range.start, range.end + 1);
    const oldCount = slice.reduce((count, op) => count + (op.type === 'insert' ? 0 : 1), 0);
    const newCount = slice.reduce((count, op) => count + (op.type === 'delete' ? 0 : 1), 0);
    chunks.push(`@@ -${oldBefore[range.start]! + 1},${oldCount} +${newBefore[range.start]! + 1},${newCount} @@`);
    for (const op of slice) chunks.push(`${op.type === 'equal' ? ' ' : op.type === 'insert' ? '+' : '-'}${op.line}`);
  }
  return chunks.join('\n');
}

async function textPatch(
  env: ForgeEnv,
  repo: RepoRecord,
  path: string,
  before: RepoTreeEntry | null,
  after: RepoTreeEntry | null,
  maxBytes: number,
) {
  if ((before && likelyBinary(path)) || (after && likelyBinary(path))) return { binary: true, truncated: false, patch: null };
  try {
    const [beforeText, afterText] = await Promise.all([
      before ? artifactBlobText(env, repo.artifact_name, before.hash, maxBytes) : Promise.resolve(''),
      after ? artifactBlobText(env, repo.artifact_name, after.hash, maxBytes) : Promise.resolve(''),
    ]);
    return { binary: false, truncated: false, patch: unifiedPatch(path, beforeText, afterText) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const binary = message.includes('binary');
    return { binary, truncated: !binary, patch: null };
  }
}

export async function diffRevisions(
  env: ForgeEnv,
  repo: RepoRecord,
  baseRef: string,
  headRef: string,
  options: { maxFiles?: number; maxTextBytes?: number } = {},
) {
  const refs = await artifactRefs(env, repo.artifact_name);
  const [base, head] = await Promise.all([
    resolveRevision(env, repo, baseRef, refs),
    resolveRevision(env, repo, headRef, refs),
  ]);
  const [baseCommit, headCommit] = await Promise.all([
    artifactCommit<ArtifactsCommit>(env, repo.artifact_name, base.hash),
    artifactCommit<ArtifactsCommit>(env, repo.artifact_name, head.hash),
  ]);
  const [baseEntries, headEntries] = await Promise.all([
    walkTree(env, repo, baseCommit.treeHash, { maxEntries: DEFAULT_TREE_LIMIT }),
    walkTree(env, repo, headCommit.treeHash, { maxEntries: DEFAULT_TREE_LIMIT }),
  ]);
  const beforeMap = flatten(baseEntries);
  const afterMap = flatten(headEntries);
  const paths = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();
  const changed = paths.filter((path) => {
    const before = beforeMap.get(path);
    const after = afterMap.get(path);
    return before?.hash !== after?.hash || before?.type !== after?.type;
  });
  const maxFiles = clamp(options.maxFiles ?? 300, 1, 1_000);
  const maxTextBytes = clamp(options.maxTextBytes ?? DEFAULT_TEXT_FILE_LIMIT, 4_096, 2_000_000);
  const selected = changed.slice(0, maxFiles);
  const changes: FileChange[] = [];

  for (const path of selected) {
    const before = beforeMap.get(path) ?? null;
    const after = afterMap.get(path) ?? null;
    const status: FileChange['status'] = !before ? 'added' : !after ? 'deleted' : before.type !== after.type ? 'type_changed' : 'modified';
    const rendered = await textPatch(env, repo, path, before, after, maxTextBytes);
    changes.push({ path, status, before, after, ...rendered });
  }

  return {
    base: { ref: baseRef, sha: base.hash },
    head: { ref: headRef, sha: head.hash },
    filesChanged: changed.length,
    truncated: changed.length > selected.length,
    changes,
  };
}
