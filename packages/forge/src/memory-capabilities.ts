import { z } from 'zod';
import type { FeatureCapability } from './feature-capabilities';
import { getRepoRecord } from './db';
import { recallRepoMemory, recentRepoMemory, rememberRepoMemory } from './repo-memory';

function capability<T extends z.ZodType>(
  name: string,
  description: string,
  mutates: boolean,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: FeatureCapability['execute'],
): FeatureCapability {
  return {
    name,
    description,
    mutates,
    inputSchema,
    parse: (value) => parser.parse(value),
    execute,
  };
}

const repo = z.object({ owner: z.string().min(1), repo: z.string().min(1) });
const evidence = z.object({
  kind: z.enum(['commit', 'pull', 'issue', 'ci', 'path', 'url']),
  value: z.string().min(1),
});

export const memoryCapabilities: FeatureCapability[] = [
  capability(
    'memory.recall',
    'Recall durable repo-scoped lessons, decisions, failures, constraints, and conventions produced by other agents. Search is lexical/FTS-backed inside one Cloudflare Agent Durable Object per repository.',
    false,
    repo.extend({
      query: z.string().default(''),
      path: z.string().optional(),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; query: string; path?: string; limit: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return value.query.trim() || value.path
        ? recallRepoMemory(env, record, value.query, value.limit, value.path)
        : recentRepoMemory(env, record, value.limit);
    },
  ),
  capability(
    'memory.remember',
    'Persist a non-obvious repo-specific lesson so later agents do not repeat the same mistake. Store conclusions, failed approaches, architectural decisions, constraints, and conventions with evidence; do not use as transient scratchpad.',
    true,
    repo.extend({
      key: z.string().min(1).optional(),
      kind: z.enum(['lesson', 'decision', 'failure', 'constraint', 'convention']),
      title: z.string().min(1),
      content: z.string().min(1),
      paths: z.array(z.string().min(1)).max(32).optional(),
      evidence: z.array(evidence).max(32).optional(),
      agent: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        key: { type: 'string', description: 'Stable key when updating/correcting an existing memory.' },
        kind: { type: 'string', enum: ['lesson', 'decision', 'failure', 'constraint', 'convention'] },
        title: { type: 'string' },
        content: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        evidence: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['commit', 'pull', 'issue', 'ci', 'path', 'url'] },
              value: { type: 'string' },
            },
            required: ['kind', 'value'],
          },
        },
        agent: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['owner', 'repo', 'kind', 'title', 'content'],
    },
    async ({ env }, input: never) => {
      const value = input as {
        owner: string;
        repo: string;
        key?: string;
        kind: 'lesson' | 'decision' | 'failure' | 'constraint' | 'convention';
        title: string;
        content: string;
        paths?: string[];
        evidence?: Array<{ kind: 'commit' | 'pull' | 'issue' | 'ci' | 'path' | 'url'; value: string }>;
        agent?: string;
        confidence?: number;
      };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return rememberRepoMemory(env, record, {
        key: value.key,
        kind: value.kind,
        title: value.title,
        content: value.content,
        paths: value.paths,
        evidence: value.evidence,
        agent: value.agent,
        confidence: value.confidence,
      });
    },
  ),
];
