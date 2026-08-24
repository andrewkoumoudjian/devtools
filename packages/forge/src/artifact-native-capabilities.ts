import { z } from 'zod';
import type { FeatureCapability } from './feature-capabilities';
import { getRepoRecord } from './db';
import { diffRevisions, lastCommitForPath, searchFilePaths } from './git-data';
import { searchCodeIndexed } from './search-index';

function capability<T extends z.ZodType>(
  name: string,
  description: string,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: FeatureCapability['execute'],
): FeatureCapability {
  return {
    name,
    description,
    mutates: false,
    inputSchema,
    parse: (value) => parser.parse(value),
    execute,
  };
}

const repo = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

export const artifactNativeCapabilities: FeatureCapability[] = [
  capability(
    'fs.search',
    'Search tracked file paths directly from immutable Cloudflare Artifacts commit/tree objects. No checkout, Sandbox, embedding, or LLM call.',
    repo.extend({
      ref: z.string().default('main'),
      query: z.string().default(''),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; ref: string; query: string; limit: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return searchFilePaths(env, record, value.ref, value.query, value.limit);
    },
  ),
  capability(
    'code.search',
    'Literal code search over immutable Cloudflare Artifacts blobs with a persistent blob-hash trigram/text index in R2. Unchanged blobs are reused across commits and worker restarts; direct Artifacts scanning remains the cache-miss fallback.',
    repo.extend({
      ref: z.string().default('main'),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(500).default(100),
      caseSensitive: z.boolean().default(false),
      maxFiles: z.number().int().min(1).max(1000).default(250),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        caseSensitive: { type: 'boolean' },
        maxFiles: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      required: ['owner', 'repo', 'query'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; ref: string; query: string; limit: number; caseSensitive: boolean; maxFiles: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return searchCodeIndexed(env, record, value.ref, value.query, {
        limit: value.limit,
        caseSensitive: value.caseSensitive,
        maxFiles: value.maxFiles,
      });
    },
  ),
  capability(
    'file.last_commit',
    'Find the newest commit that changed a path by comparing Cloudflare Artifacts commit/tree object hashes across history. No checkout.',
    repo.extend({
      ref: z.string().default('main'),
      path: z.string().min(1),
      maxCommits: z.number().int().min(1).max(500).default(100),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        path: { type: 'string' },
        maxCommits: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['owner', 'repo', 'path'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; ref: string; path: string; maxCommits: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return lastCommitForPath(env, record, value.ref, value.path, value.maxCommits);
    },
  ),
  capability(
    'pull.diff',
    'Build a pull-request file diff directly from Cloudflare Artifacts refs, commits, trees, and blobs. Sandbox/ArtifactFS is not involved.',
    repo.extend({
      number: z.number().int().positive(),
      maxFiles: z.number().int().min(1).max(1000).default(300),
      maxTextBytes: z.number().int().min(4096).max(2_000_000).default(512_000),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'integer' },
        maxFiles: { type: 'integer', minimum: 1, maximum: 1000 },
        maxTextBytes: { type: 'integer', minimum: 4096, maximum: 2000000 },
      },
      required: ['owner', 'repo', 'number'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; number: number; maxFiles: number; maxTextBytes: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      const pull = await env.DB.prepare(`SELECT base_ref, head_ref FROM pull_requests WHERE repo_id = ? AND number = ?`)
        .bind(record.id, value.number)
        .first<{ base_ref: string; head_ref: string }>();
      if (!pull) throw new Error(`pull request #${value.number} not found`);
      return diffRevisions(env, record, pull.base_ref, pull.head_ref, {
        maxFiles: value.maxFiles,
        maxTextBytes: value.maxTextBytes,
      });
    },
  ),
];
