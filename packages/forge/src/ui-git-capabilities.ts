import { z } from 'zod';
import type { FeatureCapability } from './feature-capabilities';
import { artifactCommit, artifactLog, type ArtifactsCommit } from './artifacts';
import { getRepoRecord } from './db';
import { diffRevisions, findPathEntry } from './git-data';

function capability<T extends z.ZodType>(
  name: string,
  description: string,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: FeatureCapability['execute'],
): FeatureCapability {
  return { name, description, mutates: false, inputSchema, parse: (value) => parser.parse(value), execute };
}

const repo = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

async function changedPathHistory(
  env: Parameters<FeatureCapability['execute']>[0]['env'],
  owner: string,
  name: string,
  ref: string,
  path: string,
  offset: number,
  limit: number,
) {
  const record = await getRepoRecord(env, owner, name);
  if (!path) {
    const rows = await artifactLog<ArtifactsCommit[]>(env, record.artifact_name, ref, limit + 1, offset);
    return { commits: rows.slice(0, limit), more: rows.length > limit };
  }

  // Path history is derived from immutable tree/blob identity. Fetch a bounded
  // history window, then retain only commits where this path differs from every
  // parent. This is the same primitive Forge uses for file.last_commit, exposed
  // as a page-shaped read for the Walgit UI.
  const scan = Math.min(500, Math.max(100, offset + limit * 4));
  const rows = await artifactLog<ArtifactsCommit[]>(env, record.artifact_name, ref, scan, 0);
  const changed: ArtifactsCommit[] = [];
  const commitCache = new Map<string, Promise<ArtifactsCommit>>();
  for (const commit of rows) {
    const current = await findPathEntry(env, record, commit.treeHash, path);
    if (commit.parents.length === 0) {
      if (current) changed.push(commit);
      continue;
    }
    let unchangedInParent = false;
    for (const parentHash of commit.parents) {
      let parent = commitCache.get(parentHash);
      if (!parent) {
        parent = artifactCommit<ArtifactsCommit>(env, record.artifact_name, parentHash);
        commitCache.set(parentHash, parent);
      }
      const previous = await findPathEntry(env, record, (await parent).treeHash, path);
      if (previous?.hash === current?.hash && previous?.type === current?.type) {
        unchangedInParent = true;
        break;
      }
    }
    if (!unchangedInParent) changed.push(commit);
  }
  return { commits: changed.slice(offset, offset + limit), more: changed.length > offset + limit };
}

export const uiGitCapabilities: FeatureCapability[] = [
  capability(
    'git.history',
    'Read page-shaped Git history, optionally filtered to commits that changed one path, directly from immutable Cloudflare Artifacts commits and trees.',
    repo.extend({
      ref: z.string().default('main'),
      path: z.string().default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; ref: string; path: string; offset: number; limit: number };
      return changedPathHistory(env, value.owner, value.repo, value.ref, value.path, value.offset, value.limit);
    },
  ),
  capability(
    'git.diff',
    'Diff two Git revisions directly from Cloudflare Artifacts commits, trees, and blobs. No workspace checkout is created.',
    repo.extend({
      base: z.string().min(1),
      head: z.string().min(1),
      maxFiles: z.number().int().min(1).max(1000).default(500),
      maxTextBytes: z.number().int().min(4096).max(2_000_000).default(1_000_000),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
        maxFiles: { type: 'integer', minimum: 1, maximum: 1000 }, maxTextBytes: { type: 'integer', minimum: 4096, maximum: 2000000 },
      },
      required: ['owner', 'repo', 'base', 'head'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; base: string; head: string; maxFiles: number; maxTextBytes: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return diffRevisions(env, record, value.base, value.head, { maxFiles: value.maxFiles, maxTextBytes: value.maxTextBytes });
    },
  ),
];
