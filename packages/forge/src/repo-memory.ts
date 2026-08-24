import { Agent } from 'agents';
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
};

export type RepoMemoryRecord = {
  key: string;
  kind: RepoMemoryKind;
  title: string;
  content: string;
  paths: string[];
  evidence: RepoMemoryEvidence[];
  agent: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  rank?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ftsQuery(query: string) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_./:-]+/gu, ''))
    .filter((token) => token.length >= 2)
    .slice(0, 24);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

async function stableKey(input: RepoMemoryWrite) {
  if (input.key?.trim()) return input.key.trim();
  const source = `${input.kind}\n${input.title.trim()}\n${(input.paths ?? []).slice().sort().join('\n')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return `mem_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
}

function rowToMemory(row: {
  key: string;
  kind: string;
  title: string;
  content: string;
  paths_json: string;
  evidence_json: string;
  agent: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  rank?: number;
}): RepoMemoryRecord {
  return {
    key: row.key,
    kind: row.kind as RepoMemoryKind,
    title: row.title,
    content: row.content,
    paths: safeJson<string[]>(row.paths_json, []),
    evidence: safeJson<RepoMemoryEvidence[]>(row.evidence_json, []),
    agent: row.agent,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rank: row.rank,
  };
}

export class RepoMemoryAgent extends Agent<ForgeEnv> {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS forge_repo_memory (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        paths_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        agent TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS forge_repo_memory_fts USING fts5(
        key UNINDEXED,
        title,
        content,
        paths,
        tokenize='porter unicode61'
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS forge_repo_memory_revision (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL
      )
    `;
    this.sql`INSERT OR IGNORE INTO forge_repo_memory_revision (singleton, revision) VALUES (1, 0)`;
  }

  private currentRevision() {
    return this.sql<{ revision: number }>`SELECT revision FROM forge_repo_memory_revision WHERE singleton = 1`[0]?.revision ?? 0;
  }

  async remember(input: RepoMemoryWrite) {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) throw new Error('memory title is required');
    if (!content) throw new Error('memory content is required');
    const key = await stableKey(input);
    const now = Date.now();
    const paths = Array.from(new Set((input.paths ?? []).map((path) => path.trim()).filter(Boolean))).slice(0, 32);
    const evidence = (input.evidence ?? []).filter((item) => item.value.trim()).slice(0, 32);
    const confidence = clamp(input.confidence ?? 0.8, 0, 1);
    const agent = input.agent?.trim() || 'remote-agent';
    const existing = this.sql<{ created_at: number }>`SELECT created_at FROM forge_repo_memory WHERE key = ${key}`[0];
    const createdAt = existing?.created_at ?? now;

    this.sql`
      INSERT INTO forge_repo_memory (
        key, kind, title, content, paths_json, evidence_json, agent, confidence, created_at, updated_at
      ) VALUES (
        ${key}, ${input.kind}, ${title}, ${content}, ${JSON.stringify(paths)}, ${JSON.stringify(evidence)},
        ${agent}, ${confidence}, ${createdAt}, ${now}
      )
      ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        paths_json = excluded.paths_json,
        evidence_json = excluded.evidence_json,
        agent = excluded.agent,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `;
    this.sql`DELETE FROM forge_repo_memory_fts WHERE key = ${key}`;
    this.sql`
      INSERT INTO forge_repo_memory_fts (key, title, content, paths)
      VALUES (${key}, ${title}, ${content}, ${paths.join(' ')})
    `;
    this.sql`UPDATE forge_repo_memory_revision SET revision = revision + 1 WHERE singleton = 1`;

    return {
      revision: this.currentRevision(),
      memory: rowToMemory({
        key,
        kind: input.kind,
        title,
        content,
        paths_json: JSON.stringify(paths),
        evidence_json: JSON.stringify(evidence),
        agent,
        confidence,
        created_at: createdAt,
        updated_at: now,
      }),
    };
  }

  async recall(query: string, limit = 8, path?: string) {
    const capped = clamp(limit, 1, 20);
    const normalized = query.trim();
    let rows: Array<{
      key: string;
      kind: string;
      title: string;
      content: string;
      paths_json: string;
      evidence_json: string;
      agent: string;
      confidence: number;
      created_at: number;
      updated_at: number;
      rank?: number;
    }>;

    const match = ftsQuery(normalized);
    if (match) {
      rows = this.sql`
        SELECT m.*, bm25(forge_repo_memory_fts) AS rank
        FROM forge_repo_memory_fts
        JOIN forge_repo_memory m ON m.key = forge_repo_memory_fts.key
        WHERE forge_repo_memory_fts MATCH ${match}
        ORDER BY rank ASC, m.confidence DESC, m.updated_at DESC
        LIMIT ${Math.min(capped * 3, 60)}
      `;
    } else {
      rows = this.sql`
        SELECT m.*
        FROM forge_repo_memory m
        ORDER BY m.confidence DESC, m.updated_at DESC
        LIMIT ${Math.min(capped * 3, 60)}
      `;
    }

    const memories = rows
      .map(rowToMemory)
      .filter((memory) => !path || memory.paths.length === 0 || memory.paths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`) || candidate.startsWith(`${path}/`)))
      .slice(0, capped);

    return { revision: this.currentRevision(), query: normalized, path: path ?? null, memories };
  }

  async recent(limit = 8) {
    const capped = clamp(limit, 1, 20);
    const rows = this.sql<{
      key: string;
      kind: string;
      title: string;
      content: string;
      paths_json: string;
      evidence_json: string;
      agent: string;
      confidence: number;
      created_at: number;
      updated_at: number;
    }>`
      SELECT * FROM forge_repo_memory
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ${capped}
    `;
    return { revision: this.currentRevision(), memories: rows.map(rowToMemory) };
  }
}

function memoryStub(env: ForgeEnv, repo: RepoRecord) {
  return env.REPO_MEMORY.getByName(repo.id) as DurableObjectStub<RepoMemoryAgent>;
}

export async function rememberRepoMemory(env: ForgeEnv, repo: RepoRecord, input: RepoMemoryWrite) {
  return memoryStub(env, repo).remember(input);
}

export async function recallRepoMemory(env: ForgeEnv, repo: RepoRecord, query: string, limit = 8, path?: string) {
  return memoryStub(env, repo).recall(query, limit, path);
}

export async function recentRepoMemory(env: ForgeEnv, repo: RepoRecord, limit = 8) {
  return memoryStub(env, repo).recent(limit);
}
