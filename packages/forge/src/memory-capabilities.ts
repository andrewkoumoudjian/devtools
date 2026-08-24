import { z } from 'zod';
import type { FeatureCapability } from './feature-capabilities';
import { getRepoRecord } from './db';
import {
  ingestRepoMemory,
  recallRepoMemory,
  recentRepoMemory,
  rememberRepoMemory,
  summarizeRepoMemory,
} from './repo-memory';

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
const message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
  timestamp: z.string().datetime().optional(),
});

export const memoryCapabilities: FeatureCapability[] = [
  capability(
    'memory.recall',
    'Recall shared repository knowledge from Cloudflare Agent Memory. Every forge repository maps to one isolated Agent Memory profile, so all agents working on that repository retrieve the same durable facts, events, instructions, and lessons.',
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
        query: { type: 'string', description: 'Natural-language memory query.' },
        path: { type: 'string', description: 'Optional repository path used as retrieval context.' },
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
    'Explicitly store a durable repository lesson in Cloudflare Agent Memory. Use for known conclusions, failed approaches, architectural decisions, constraints, and conventions; Agent Memory classifies and summarizes the content and handles supersession of evolving facts/instructions.',
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
      sessionId: z.string().min(1).optional(),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        key: { type: 'string', description: 'Optional stable semantic key included in the stored memory to make corrections/supersession explicit.' },
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
        sessionId: { type: 'string', description: 'Optional coding-session/workspace identifier. Agent Memory limits it to 64 characters.' },
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
        sessionId?: string;
      };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return rememberRepoMemory(env, record, value);
    },
  ),
  capability(
    'memory.ingest',
    'Send a completed or checkpointed agent conversation to Cloudflare Agent Memory for automatic extraction of durable facts, events, instructions, and tasks. Prefer natural checkpoints instead of ingesting every turn.',
    true,
    repo.extend({
      messages: z.array(message).min(1).max(500),
      sessionId: z.string().min(1).optional(),
    }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        messages: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' },
            },
            required: ['role', 'content'],
          },
        },
        sessionId: { type: 'string' },
      },
      required: ['owner', 'repo', 'messages'],
    },
    async ({ env }, input: never) => {
      const value = input as {
        owner: string;
        repo: string;
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }>;
        sessionId?: string;
      };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return ingestRepoMemory(env, record, value.messages, value.sessionId);
    },
  ),
  capability(
    'memory.summary',
    'Return Cloudflare Agent Memory’s structured Markdown summary of what the shared repository profile currently remembers.',
    false,
    repo.extend({ sessionId: z.string().min(1).optional() }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; sessionId?: string };
      const record = await getRepoRecord(env, value.owner, value.repo);
      return summarizeRepoMemory(env, record, value.sessionId);
    },
  ),
];
