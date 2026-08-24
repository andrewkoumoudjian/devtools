import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { artifactBlobText } from './artifacts';
import { resolveRevision, treeForRevision, walkTree } from './git-data';

const INDEX_VERSION = 1;
const DEFAULT_TEXT_FILE_LIMIT = 512_000;
const DEFAULT_SEARCH_TOTAL_BYTES = 8_000_000;
const DEFAULT_SEARCH_FILE_LIMIT = 250;
const MAX_TRIGRAMS = 50_000;
const SKIP_SEARCH_SEGMENTS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.turbo', 'coverage', 'target',
]);
const LIKELY_BINARY_EXTENSIONS = new Set([
  '7z', 'a', 'avi', 'bin', 'bmp', 'class', 'dmg', 'doc', 'docx', 'eot', 'exe', 'gif', 'gz', 'ico',
  'jar', 'jpeg', 'jpg', 'lockb', 'mov', 'mp3', 'mp4', 'o', 'otf', 'pdf', 'png', 'ppt', 'pptx', 'pyc',
  'rar', 'so', 'sqlite', 'tar', 'tgz', 'ttf', 'wav', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'zip',
]);

type BlobSearchIndex = {
  version: number;
  hash: string;
  bytes: number;
  text: string;
  trigrams: string[];
  completeTrigrams: boolean;
};

type SearchMatch = { path: string; hash: string; line: number; text: string };

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

function indexKey(hash: string) {
  return `forge-search/index/v${INDEX_VERSION}/blobs/${hash}.json`;
}

function trigrams(value: string) {
  const normalized = value.toLowerCase();
  const values = new Set<string>();
  let complete = true;
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    values.add(normalized.slice(index, index + 3));
    if (values.size >= MAX_TRIGRAMS) {
      complete = false;
      break;
    }
  }
  return { values: Array.from(values), complete };
}

function queryTrigrams(value: string) {
  if (value.length < 3) return [];
  const normalized = value.toLowerCase();
  const values = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) values.add(normalized.slice(index, index + 3));
  return Array.from(values);
}

async function cachedIndex(env: ForgeEnv, hash: string): Promise<BlobSearchIndex | null> {
  const object = await env.BACKUP_BUCKET.get(indexKey(hash));
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as BlobSearchIndex;
    return parsed.version === INDEX_VERSION && parsed.hash === hash && typeof parsed.text === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function buildIndex(env: ForgeEnv, repo: RepoRecord, hash: string, maxBytes: number) {
  const text = await artifactBlobText(env, repo.artifact_name, hash, maxBytes);
  const bytes = new TextEncoder().encode(text).byteLength;
  const grams = trigrams(text);
  const value: BlobSearchIndex = {
    version: INDEX_VERSION,
    hash,
    bytes,
    text,
    trigrams: grams.values,
    completeTrigrams: grams.complete,
  };
  await env.BACKUP_BUCKET.put(indexKey(hash), JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { blobHash: hash, indexVersion: String(INDEX_VERSION) },
  }).catch(() => undefined);
  return value;
}

function couldContain(index: BlobSearchIndex, grams: string[]) {
  if (!grams.length || !index.completeTrigrams) return true;
  const available = new Set(index.trigrams);
  return grams.every((gram) => available.has(gram));
}

export async function searchCodeIndexed(
  env: ForgeEnv,
  repo: RepoRecord,
  ref: string,
  query: string,
  options: { limit?: number; maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; caseSensitive?: boolean } = {},
) {
  const revision = await resolveRevision(env, repo, ref);
  const { treeHash } = await treeForRevision(env, repo, revision);
  const all = await walkTree(env, repo, treeHash, { maxEntries: 25_000 });
  const candidates = all
    .filter((entry) => entry.type !== 'gitlink' && !shouldSkipPath(entry.path) && !likelyBinary(entry.path))
    .slice(0, clamp(options.maxFiles ?? DEFAULT_SEARCH_FILE_LIMIT, 1, 1_000));
  const limit = clamp(options.limit ?? 100, 1, 500);
  const maxFileBytes = clamp(options.maxFileBytes ?? DEFAULT_TEXT_FILE_LIMIT, 1_024, 2_000_000);
  const maxTotalBytes = clamp(options.maxTotalBytes ?? DEFAULT_SEARCH_TOTAL_BYTES, maxFileBytes, 32_000_000);
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const grams = queryTrigrams(query);
  const matches: SearchMatch[] = [];
  let bytesRead = 0;
  let filesRead = 0;
  let indexHits = 0;
  let indexMisses = 0;
  let indexedSkips = 0;
  let truncated = candidates.length < all.length;

  for (const entry of candidates) {
    if (matches.length >= limit || bytesRead >= maxTotalBytes) {
      truncated = true;
      break;
    }

    try {
      let index = await cachedIndex(env, entry.hash);
      if (index) {
        indexHits += 1;
      } else {
        indexMisses += 1;
        index = await buildIndex(env, repo, entry.hash, Math.min(maxFileBytes, maxTotalBytes - bytesRead));
        bytesRead += index.bytes;
        filesRead += 1;
      }

      if (!couldContain(index, grams)) {
        indexedSkips += 1;
        continue;
      }

      const lines = index.text.split('\n');
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < limit; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) matches.push({ path: entry.path, hash: entry.hash, line: lineIndex + 1, text: line });
      }
    } catch {
      // Unreadable/oversized blobs remain ordinary scanner misses.
    }
  }

  return {
    ref,
    sha: revision.hash,
    query,
    matches,
    filesRead,
    bytesRead,
    truncated,
    index: {
      kind: 'content-addressed-trigram',
      version: INDEX_VERSION,
      hits: indexHits,
      misses: indexMisses,
      skippedBlobReads: indexedSkips,
    },
  };
}
