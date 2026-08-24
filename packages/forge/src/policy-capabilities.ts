import { z } from 'zod';
import type { FeatureCapability } from './feature-capabilities';
import { getRepoRecord } from './db';
import { diffRevisions } from './git-data';
import { evaluateCodeowners, loadCodeowners, resolveAgentAccess } from './policy';
import { getPullRecord } from './product';

function cap<T extends z.ZodType>(
  name: string,
  description: string,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: FeatureCapability['execute'],
): FeatureCapability {
  return { name, description, mutates: false, inputSchema, parse: (value) => parser.parse(value), execute };
}

const repo = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

export const policyCapabilities: FeatureCapability[] = [
  cap(
    'policy.agent_access.resolve',
    'Resolve requested agent write access against repository policy. Fails closed to read-only when writes are disabled.',
    repo.extend({ requested: z.enum(['read-only', 'write-capable']).optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, requested: { type: 'string', enum: ['read-only', 'write-capable'] } }, required: ['owner', 'repo'] },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; requested?: 'read-only' | 'write-capable' };
      return resolveAgentAccess(env, await getRepoRecord(env, value.owner, value.repo), value.requested);
    },
  ),
  cap(
    'policy.codeowners.evaluate',
    'Evaluate CODEOWNERS deterministically for explicit paths or a pull request. Unsupported syntax and missing rules fail closed.',
    repo.extend({
      ref: z.string().default('main'),
      actor: z.string().min(1),
      actorTeams: z.array(z.string()).default([]),
      paths: z.array(z.string()).optional(),
      pullNumber: z.number().int().positive().optional(),
    }).refine((input) => Boolean(input.paths?.length || input.pullNumber), { message: 'paths or pullNumber is required' }),
    {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, actor: { type: 'string' },
        actorTeams: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } }, pullNumber: { type: 'integer' },
      },
      required: ['owner', 'repo', 'actor'],
    },
    async ({ env }, input: never) => {
      const value = input as { owner: string; repo: string; ref: string; actor: string; actorTeams: string[]; paths?: string[]; pullNumber?: number };
      const record = await getRepoRecord(env, value.owner, value.repo);
      const codeowners = await loadCodeowners(env, record, value.ref);
      if (!codeowners) return { allowed: false, reason: 'CODEOWNERS file not found', path: null, evaluations: [] };
      let paths = value.paths ?? [];
      if (value.pullNumber) {
        const pull = await getPullRecord(env, record, value.pullNumber);
        const diff = await diffRevisions(env, record, pull.base_ref, pull.head_ref, { maxFiles: 1000, maxTextBytes: 4096 });
        paths = diff.changes.map((change) => change.path);
        if (diff.truncated) return { allowed: false, reason: 'could not inspect every changed pull-request file', path: codeowners.path, evaluations: [] };
      }
      return { path: codeowners.path, ...evaluateCodeowners(codeowners.rules, paths, value.actor, value.actorTeams) };
    },
  ),
];
