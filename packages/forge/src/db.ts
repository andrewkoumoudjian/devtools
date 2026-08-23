import type { ForgeEnv } from './env';

export type RepoRecord = {
  id: string;
  owner: string;
  name: string;
  artifact_name: string;
  description: string;
  default_branch: string;
  visibility: 'private' | 'public';
  created_at: string;
  updated_at: string;
};

export async function createRepoRecord(
  env: ForgeEnv,
  input: Omit<RepoRecord, 'id' | 'created_at' | 'updated_at'>,
): Promise<RepoRecord> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repositories (id, owner, name, artifact_name, description, default_branch, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.owner,
      input.name,
      input.artifact_name,
      input.description,
      input.default_branch,
      input.visibility,
    ),
    env.DB.prepare(`INSERT INTO repo_counters (repo_id) VALUES (?)`).bind(id),
  ]);
  const row = await env.DB.prepare(`SELECT * FROM repositories WHERE id = ?`).bind(id).first<RepoRecord>();
  if (!row) throw new Error('repository record was not created');
  return row;
}

export async function deleteRepoRecord(env: ForgeEnv, owner: string, name: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM repositories WHERE owner = ? AND name = ?`).bind(owner, name).run();
}

export async function getRepoRecord(env: ForgeEnv, owner: string, name: string): Promise<RepoRecord> {
  const row = await env.DB.prepare(`SELECT * FROM repositories WHERE owner = ? AND name = ?`)
    .bind(owner, name)
    .first<RepoRecord>();
  if (!row) throw new Error(`repository ${owner}/${name} not found`);
  return row;
}

export async function listRepoRecords(env: ForgeEnv): Promise<RepoRecord[]> {
  const result = await env.DB.prepare(`SELECT * FROM repositories ORDER BY owner, name`).all<RepoRecord>();
  return result.results;
}

async function nextNumber(env: ForgeEnv, repoId: string, kind: 'issue' | 'pull'): Promise<number> {
  const column = kind === 'issue' ? 'next_issue' : 'next_pull';
  const row = await env.DB.prepare(
    `UPDATE repo_counters SET ${column} = ${column} + 1 WHERE repo_id = ? RETURNING ${column} - 1 AS n`,
  )
    .bind(repoId)
    .first<{ n: number }>();
  if (!row) throw new Error(`missing repository counter for ${repoId}`);
  return row.n;
}

export async function createIssue(
  env: ForgeEnv,
  repo: RepoRecord,
  input: { title: string; body?: string; author?: string },
) {
  const id = crypto.randomUUID();
  const number = await nextNumber(env, repo.id, 'issue');
  await env.DB.prepare(
    `INSERT INTO issues (id, repo_id, number, title, body, author) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, repo.id, number, input.title, input.body ?? '', input.author ?? 'system')
    .run();
  return env.DB.prepare(`SELECT * FROM issues WHERE id = ?`).bind(id).first();
}

export async function listIssues(env: ForgeEnv, repo: RepoRecord, state?: string) {
  const query = state
    ? env.DB.prepare(`SELECT * FROM issues WHERE repo_id = ? AND state = ? ORDER BY number DESC`).bind(repo.id, state)
    : env.DB.prepare(`SELECT * FROM issues WHERE repo_id = ? ORDER BY number DESC`).bind(repo.id);
  return (await query.all()).results;
}

export async function createPull(
  env: ForgeEnv,
  repo: RepoRecord,
  input: { title: string; body?: string; baseRef: string; headRef: string; headSha?: string; author?: string },
) {
  const id = crypto.randomUUID();
  const number = await nextNumber(env, repo.id, 'pull');
  await env.DB.prepare(
    `INSERT INTO pull_requests (id, repo_id, number, title, body, base_ref, head_ref, head_sha, author)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      repo.id,
      number,
      input.title,
      input.body ?? '',
      input.baseRef,
      input.headRef,
      input.headSha ?? null,
      input.author ?? 'system',
    )
    .run();
  return env.DB.prepare(`SELECT * FROM pull_requests WHERE id = ?`).bind(id).first();
}

export async function listPulls(env: ForgeEnv, repo: RepoRecord, state?: string) {
  const query = state
    ? env.DB.prepare(`SELECT * FROM pull_requests WHERE repo_id = ? AND state = ? ORDER BY number DESC`).bind(repo.id, state)
    : env.DB.prepare(`SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC`).bind(repo.id);
  return (await query.all()).results;
}

export async function recordCiRun(
  env: ForgeEnv,
  repoId: string | null,
  ref: string,
  sha: string | undefined,
  workflowInstanceId: string | undefined,
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO ci_runs (id, repo_id, ref, sha, workflow_instance_id) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, repoId, ref, sha ?? null, workflowInstanceId ?? null)
    .run();
  return env.DB.prepare(`SELECT * FROM ci_runs WHERE id = ?`).bind(id).first();
}

export async function listCiRuns(env: ForgeEnv, repo: RepoRecord, limit = 50) {
  const result = await env.DB.prepare(
    `SELECT * FROM ci_runs WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(repo.id, limit)
    .all();
  return result.results;
}
