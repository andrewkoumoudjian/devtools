import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';

export type RepoMemoryKind = 'lesson' | 'decision' | 'failure' | 'constraint' | 'convention';

export type RepoMemoryEvidence = {
  kind: 'commit' | 'pull' | 'issue' | 'ci' | 'path' | 'url';
  value: string;
};

export type RepoMemoryWrite = {
  key?: string;
  kind: RepoMemoryKind;
  title: string;
  content: string;
  paths?: string[];
  evidence?: RepoMemoryEvidence[];
  agent?: string;
  confidence?: number;
  sessionId?: string;
};

const encoder = new TextEncoder();

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function truncateUtf8(value: string, maxBytes: number) {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > maxBytes) end = Math.floor(end * 0.9);
  while (end < value.length && encoder.encode(value.slice(0, end + 1)).byteLength <= maxBytes) end += 1;
  return value.slice(0, end);
}

function profileName(repo: RepoRecord) {
  // Agent Memory profiles are isolated stores. The forge repository UUID is
  // stable across branches/workspaces and comfortably below the 100-char limit.
  return repo.id;
}

function normalizedSessionId(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf8(trimmed, 64) : null;
}

function memoryContent(repo: RepoRecord, input: RepoMemoryWrite) {
  const paths = Array.from(new Set((input.paths ?? []).map((path) => path.trim()).filter(Boolean))).slice(0, 32);
  const evidence = (input.evidence ?? []).filter((item) => item.value.trim()).slice(0, 32);
  const confidence = clamp(input.confidence ?? 0.8, 0, 1);
  const lines = [
    `Repository: ${repo.owner}/${repo.name}`,
    `Forge memory kind: ${input.kind}`,
    input.key?.trim() ? `Memory key: ${input.key.trim()}` : null,
    `Title: ${input.title.trim()}`,
    input.agent?.trim() ? `Produced by agent: ${input.agent.trim()}` : null,
    `Confidence: ${confidence}`,
    paths.length ? `Relevant paths: ${paths.join(', ')}` : null,
    evidence.length ? 'Evidence:' : null,
    ...evidence.map((item) => `- ${item.kind}: ${item.value.trim()}`),
    '',
    input.content.trim(),
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

async function memoryProfile(env: ForgeEnv, repo: RepoRecord) {
  return env.REPO_MEMORY.getProfile(profileName(repo));
}

function normalizeMemory(memory: AgentMemoryMemory) {
  return {
    id: memory.id,
    type: memory.type,
    summary: memory.summary,
    content: memory.content,
    sessionId: memory.sessionId,
    createdAt: new Date(memory.createdAt).toISOString(),
    updatedAt: new Date(memory.updatedAt).toISOString(),
  };
}

function recallQuery(repo: RepoRecord, query: string, path?: string) {
  const value = [
    `Repository ${repo.owner}/${repo.name}.`,
    path ? `Relevant path: ${path}.` : '',
    query.trim() || 'Recall the most relevant durable lessons, failures, decisions, constraints, and conventions for the current repository work.',
  ].filter(Boolean).join(' ');
  return truncateUtf8(value, 1_024);
}

export async function rememberRepoMemory(env: ForgeEnv, repo: RepoRecord, input: RepoMemoryWrite) {
  if (!input.title.trim()) throw new Error('memory title is required');
  if (!input.content.trim()) throw new Error('memory content is required');
  const profile = await memoryProfile(env, repo);
  const memory = await profile.remember({
    content: memoryContent(repo, input),
    sessionId: normalizedSessionId(input.sessionId),
  });
  return {
    source: 'cloudflare-agent-memory',
    profile: profileName(repo),
    memory: normalizeMemory(memory),
  };
}

export async function ingestRepoMemory(
  env: ForgeEnv,
  repo: RepoRecord,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }>,
  sessionId?: string,
) {
  const profile = await memoryProfile(env, repo);
  await profile.ingest(
    messages.map((message) => ({
      role: message.role,
      content: truncateUtf8(message.content, 32_768),
      ...(message.timestamp ? { timestamp: new Date(message.timestamp) } : {}),
    })),
    { sessionId: normalizedSessionId(sessionId) },
  );
  return {
    source: 'cloudflare-agent-memory',
    profile: profileName(repo),
    ingested: messages.length,
    sessionId: normalizedSessionId(sessionId),
  };
}

export async function recallRepoMemory(env: ForgeEnv, repo: RepoRecord, query: string, limit = 8, path?: string) {
  const capped = clamp(limit, 1, 20);
  const profile = await memoryProfile(env, repo);
  const nativeQuery = recallQuery(repo, query, path);
  const result = await profile.recall(nativeQuery, {
    thinkingLevel: 'medium',
    responseLength: 'short',
    referenceDate: new Date(),
  });
  const candidates = result.candidates.slice(0, capped);
  const memories = (await Promise.all(
    candidates.map((candidate) => profile.get(candidate.id).catch(() => null)),
  )).flatMap((memory) => memory ? [normalizeMemory(memory)] : []);
  return {
    source: 'cloudflare-agent-memory',
    profile: profileName(repo),
    query: nativeQuery,
    path: path ?? null,
    count: result.count,
    answer: result.answer,
    candidates,
    memories,
  };
}

export async function recentRepoMemory(env: ForgeEnv, repo: RepoRecord, limit = 8) {
  const capped = clamp(limit, 1, 20);
  const profile = await memoryProfile(env, repo);
  const page = await profile.list({ limit: capped });
  const memories = (await Promise.all(
    page.memories.map((memory) => profile.get(memory.id).catch(() => null)),
  )).flatMap((memory) => memory ? [normalizeMemory(memory)] : []);
  return {
    source: 'cloudflare-agent-memory',
    profile: profileName(repo),
    memories,
    cursor: page.cursor ?? null,
  };
}

export async function summarizeRepoMemory(env: ForgeEnv, repo: RepoRecord, sessionId?: string) {
  const profile = await memoryProfile(env, repo);
  const result = await profile.getSummary({ sessionId: normalizedSessionId(sessionId) });
  return {
    source: 'cloudflare-agent-memory',
    profile: profileName(repo),
    summary: result.summary,
  };
}
