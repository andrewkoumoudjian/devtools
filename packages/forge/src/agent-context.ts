import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { artifactRefs, artifactText } from './artifacts';
import { buildRepoContext, type ContextTarget } from './context';
import { getRepoSettings } from './product';
import { recallRepoMemory } from './repo-memory';

export type AgentContextMode = 'none' | 'minimal' | 'full';
export type KnownAgentContext = { id: string; version: string };
export type AgentContextRequest = {
  mode?: AgentContextMode;
  known?: KnownAgentContext;
};

export type AgentContextCoordinates = {
  ref?: string;
  target?: ContextTarget;
  path?: string;
  memoryQuery?: string;
  agentName?: string;
  accessMode?: 'read-only' | 'write-capable';
};

type CachedContext = { version: string; value: Record<string, unknown> };
const contextCache = new Map<string, CachedContext>();
const MAX_CONTEXT_CACHE = 128;
const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md'] as const;

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function optionalText(env: ForgeEnv, repo: RepoRecord, ref: string, path: string) {
  try {
    return await artifactText(env, repo.artifact_name, ref, path, 96_000);
  } catch {
    return null;
  }
}

function parentDirectories(path?: string) {
  if (!path) return [];
  const normalized = path.replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized) return [];
  const parts = normalized.split('/').filter(Boolean);
  if (!path.endsWith('/')) parts.pop();
  const directories: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) directories.push(parts.slice(0, index).join('/'));
  return directories;
}

async function effectiveInstructions(env: ForgeEnv, repo: RepoRecord, ref: string, path?: string) {
  const root = await Promise.all(
    ROOT_INSTRUCTION_FILES.map(async (instructionPath) => ({
      path: instructionPath,
      content: await optionalText(env, repo, ref, instructionPath),
    })),
  );
  const nested = await Promise.all(
    parentDirectories(path).map(async (directory) => {
      const instructionPath = `${directory}/AGENTS.md`;
      return { path: instructionPath, content: await optionalText(env, repo, ref, instructionPath) };
    }),
  );
  return [...root, ...nested].flatMap((item) => item.content === null ? [] : [{ path: item.path, content: item.content }]);
}

function targetKey(target?: ContextTarget) {
  return target ? `${target.kind}:${target.number}` : 'repository';
}

async function buildMinimalContext(env: ForgeEnv, repo: RepoRecord, coordinates: AgentContextCoordinates) {
  const settings = await getRepoSettings(env, repo);
  const ref = coordinates.ref ?? repo.default_branch;
  const accessMode = coordinates.accessMode ?? (settings.agent_write_enabled ? 'write-capable' : 'read-only');
  const memoryQuery = coordinates.memoryQuery?.trim() ?? '';
  const [refs, instructions, sharedMemory] = await Promise.all([
    artifactRefs(env, repo.artifact_name).catch(() => ({ head: repo.default_branch, headHash: null, branches: [], tags: [], other: [] })),
    effectiveInstructions(env, repo, ref, coordinates.path),
    memoryQuery
      ? recallRepoMemory(env, repo, memoryQuery, 5, coordinates.path).catch(() => null)
      : Promise.resolve(null),
  ]);
  const headSha = refs.branches.find((branch) => branch.name === ref)?.hash
    ?? (ref === refs.head ? refs.headHash : null)
    ?? (/^[0-9a-f]{40}$/i.test(ref) ? ref : null);
  const effectiveInstructionsHash = await sha256(JSON.stringify(instructions));
  const memory = sharedMemory?.memories?.length
    ? {
        revision: sharedMemory.revision,
        query: sharedMemory.query,
        memories: sharedMemory.memories,
      }
    : undefined;

  return {
    schemaVersion: 2,
    authority: {
      repository: `${repo.owner}/${repo.name}`,
      artifactRepository: repo.artifact_name,
      ref,
      headSha,
      target: coordinates.target ?? null,
      agentAccess: accessMode,
      view: 'immutable',
    },
    instructions,
    effectiveInstructionsHash,
    ...(memory ? { sharedMemory: memory } : {}),
    retrieval: {
      file: 'fs.read',
      fileSearch: 'fs.search',
      codeSearch: 'code.search',
      lastCommit: 'file.last_commit',
      refs: 'git.refs',
      commits: 'git.log',
      pullDiff: 'pull.diff',
      pullChecks: 'pull.checks',
      ciLogs: 'ci.step.log',
      memory: 'memory.recall',
      remember: 'memory.remember',
    },
  };
}

function stableContext(value: Record<string, unknown>) {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  return copy;
}

function delta(previous: unknown, current: unknown): unknown {
  if (Object.is(previous, current)) return undefined;
  if (Array.isArray(previous) || Array.isArray(current)) {
    return JSON.stringify(previous) === JSON.stringify(current) ? undefined : current;
  }
  if (typeof previous !== 'object' || previous === null || typeof current !== 'object' || current === null) return current;

  const out: Record<string, unknown> = {};
  const before = previous as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) {
      out[key] = null;
      continue;
    }
    const changed = delta(before[key], after[key]);
    if (changed !== undefined) out[key] = changed;
  }
  return Object.keys(out).length ? out : undefined;
}

function remember(id: string, version: string, value: Record<string, unknown>) {
  contextCache.delete(id);
  contextCache.set(id, { version, value });
  while (contextCache.size > MAX_CONTEXT_CACHE) contextCache.delete(contextCache.keys().next().value as string);
}

export async function agentContextEnvelope(
  env: ForgeEnv,
  repo: RepoRecord,
  coordinates: AgentContextCoordinates,
  request: AgentContextRequest = {},
) {
  const mode = request.mode ?? 'minimal';
  if (mode === 'none') return undefined;

  const minimal = await buildMinimalContext(env, repo, coordinates);
  let value: Record<string, unknown> = minimal;
  if (mode === 'full') {
    const full = await buildRepoContext(env, repo, {
      ref: coordinates.ref,
      target: coordinates.target,
      agentName: coordinates.agentName,
      accessMode: coordinates.accessMode,
    }) as unknown as Record<string, unknown>;
    value = {
      ...full,
      authority: {
        ...(full.authority as Record<string, unknown>),
        agentAccess: (minimal.authority as Record<string, unknown>).agentAccess,
        view: 'immutable',
      },
      instructions: minimal.instructions,
      effectiveInstructionsHash: minimal.effectiveInstructionsHash,
      ...('sharedMemory' in minimal ? { sharedMemory: minimal.sharedMemory } : {}),
    };
  }

  const identity = `${repo.id}:${coordinates.ref ?? repo.default_branch}:${targetKey(coordinates.target)}:${coordinates.path ?? ''}:${coordinates.memoryQuery ?? ''}:${mode}`;
  const id = `ctx_${(await sha256(identity)).slice(0, 20)}`;
  const stable = stableContext(value);
  const version = (await sha256(JSON.stringify(stable))).slice(0, 24);
  const cached = contextCache.get(id);

  if (request.known?.id === id && request.known.version === version) {
    remember(id, version, stable);
    return { id, version, changed: false };
  }

  if (request.known?.id === id && cached?.version === request.known.version) {
    const changed = delta(cached.value, stable);
    remember(id, version, stable);
    return { id, version, changed: true, delta: changed ?? {} };
  }

  remember(id, version, stable);
  return { id, version, changed: true, full: value };
}
