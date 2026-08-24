import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';

export type RepoSettings = {
  repo_id: string;
  issues_enabled: number;
  pulls_enabled: number;
  actions_enabled: number;
  releases_enabled: number;
  merge_method: 'merge' | 'squash' | 'rebase';
  delete_head_on_merge: number;
  agent_context_enabled: number;
  agent_write_enabled: number;
  context_recent_commits: number;
  context_recent_events: number;
  updated_at: string;
};

export type PullRecord = {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  base_ref: string;
  head_ref: string;
  head_sha: string | null;
  state: 'open' | 'closed' | 'merged';
  author: string;
  created_at: string;
  updated_at: string;
};

export type IssueRecord = {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  created_at: string;
  updated_at: string;
};

export type CiRunRecord = {
  id: string;
  repo_id: string | null;
  ref: string;
  sha: string | null;
  status: string;
  workflow_instance_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CiStepRecord = {
  id: string;
  run_id: string;
  name: string;
  status: string;
  exit_code: number | null;
  stdout_key: string | null;
  stderr_key: string | null;
  started_at: string;
  completed_at: string | null;
};

const DEFAULT_SETTINGS = {
  issues_enabled: 1,
  pulls_enabled: 1,
  actions_enabled: 1,
  releases_enabled: 1,
  merge_method: 'squash' as const,
  delete_head_on_merge: 1,
  agent_context_enabled: 1,
  agent_write_enabled: 1,
  context_recent_commits: 20,
  context_recent_events: 50,
};

export async function getRepoSettings(env: ForgeEnv, repo: RepoRecord): Promise<RepoSettings> {
  const current = await env.DB.prepare(`SELECT * FROM repo_settings WHERE repo_id = ?`).bind(repo.id).first<RepoSettings>();
  if (current) return current;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO repo_settings
      (repo_id, issues_enabled, pulls_enabled, actions_enabled, releases_enabled, merge_method, delete_head_on_merge, agent_context_enabled, agent_write_enabled, context_recent_commits, context_recent_events)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    repo.id,
    DEFAULT_SETTINGS.issues_enabled,
    DEFAULT_SETTINGS.pulls_enabled,
    DEFAULT_SETTINGS.actions_enabled,
    DEFAULT_SETTINGS.releases_enabled,
    DEFAULT_SETTINGS.merge_method,
    DEFAULT_SETTINGS.delete_head_on_merge,
    DEFAULT_SETTINGS.agent_context_enabled,
    DEFAULT_SETTINGS.agent_write_enabled,
    DEFAULT_SETTINGS.context_recent_commits,
    DEFAULT_SETTINGS.context_recent_events,
  ).run();
  const inserted = await env.DB.prepare(`SELECT * FROM repo_settings WHERE repo_id = ?`).bind(repo.id).first<RepoSettings>();
  if (!inserted) throw new Error('repository settings were not created');
  return inserted;
}

export async function updateRepoSettings(
  env: ForgeEnv,
  repo: RepoRecord,
  input: Partial<Omit<RepoSettings, 'repo_id' | 'updated_at'>> & { description?: string; visibility?: 'private' | 'public'; default_branch?: string; website?: string },
) {
  await getRepoSettings(env, repo);
  const settingsFields = [
    'issues_enabled', 'pulls_enabled', 'actions_enabled', 'releases_enabled', 'merge_method',
    'delete_head_on_merge', 'agent_context_enabled', 'agent_write_enabled', 'context_recent_commits', 'context_recent_events',
  ] as const;
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const field of settingsFields) {
    const value = input[field];
    if (value !== undefined) {
      updates.push(`${field} = ?`);
      values.push(value);
    }
  }
  if (updates.length) {
    updates.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE repo_settings SET ${updates.join(', ')} WHERE repo_id = ?`).bind(...values, repo.id).run();
  }

  const repoUpdates: string[] = [];
  const repoValues: unknown[] = [];
  for (const [column, value] of [
    ['description', input.description],
    ['visibility', input.visibility],
    ['default_branch', input.default_branch],
    ['website', input.website],
  ] as const) {
    if (value !== undefined) {
      repoUpdates.push(`${column} = ?`);
      repoValues.push(value);
    }
  }
  if (repoUpdates.length) {
    repoUpdates.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE repositories SET ${repoUpdates.join(', ')} WHERE id = ?`).bind(...repoValues, repo.id).run();
  }
  return getRepoSettings(env, repo);
}

export async function listLabels(env: ForgeEnv, repo: RepoRecord) {
  return (await env.DB.prepare(`SELECT * FROM labels WHERE repo_id = ? ORDER BY name`).bind(repo.id).all()).results;
}

export async function createLabel(env: ForgeEnv, repo: RepoRecord, input: { name: string; color?: string; description?: string }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO labels (id, repo_id, name, color, description) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, repo.id, input.name, (input.color ?? '0969da').replace(/^#/, ''), input.description ?? '').run();
  return env.DB.prepare(`SELECT * FROM labels WHERE id = ?`).bind(id).first();
}

export async function listMilestones(env: ForgeEnv, repo: RepoRecord, state?: 'open' | 'closed') {
  const statement = state
    ? env.DB.prepare(`SELECT * FROM milestones WHERE repo_id = ? AND state = ? ORDER BY number DESC`).bind(repo.id, state)
    : env.DB.prepare(`SELECT * FROM milestones WHERE repo_id = ? ORDER BY number DESC`).bind(repo.id);
  return (await statement.all()).results;
}

export async function createMilestone(env: ForgeEnv, repo: RepoRecord, input: { title: string; description?: string; dueAt?: string }) {
  const id = crypto.randomUUID();
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS number FROM milestones WHERE repo_id = ?`).bind(repo.id).first<{ number: number }>();
  const number = row?.number ?? 1;
  await env.DB.prepare(`INSERT INTO milestones (id, repo_id, number, title, description, due_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, repo.id, number, input.title, input.description ?? '', input.dueAt ?? null).run();
  return env.DB.prepare(`SELECT * FROM milestones WHERE id = ?`).bind(id).first();
}

async function idsForLabels(env: ForgeEnv, repo: RepoRecord, names: string[]) {
  if (!names.length) return [] as string[];
  const placeholders = names.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT id, name FROM labels WHERE repo_id = ? AND name IN (${placeholders})`).bind(repo.id, ...names).all<{ id: string; name: string }>()).results;
  const found = new Set(rows.map((row) => row.name));
  const missing = names.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`unknown labels: ${missing.join(', ')}`);
  return rows.map((row) => row.id);
}

export async function setIssueLabels(env: ForgeEnv, repo: RepoRecord, issueId: string, names: string[]) {
  const ids = await idsForLabels(env, repo, names);
  await env.DB.prepare(`DELETE FROM issue_labels WHERE issue_id = ?`).bind(issueId).run();
  for (const id of ids) await env.DB.prepare(`INSERT INTO issue_labels (issue_id, label_id) VALUES (?, ?)`).bind(issueId, id).run();
}

export async function setPullLabels(env: ForgeEnv, repo: RepoRecord, pullId: string, names: string[]) {
  const ids = await idsForLabels(env, repo, names);
  await env.DB.prepare(`DELETE FROM pull_labels WHERE pull_id = ?`).bind(pullId).run();
  for (const id of ids) await env.DB.prepare(`INSERT INTO pull_labels (pull_id, label_id) VALUES (?, ?)`).bind(pullId, id).run();
}

export async function labelsForIssue(env: ForgeEnv, issueId: string) {
  return (await env.DB.prepare(`SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id WHERE il.issue_id = ? ORDER BY l.name`).bind(issueId).all()).results;
}

export async function labelsForPull(env: ForgeEnv, pullId: string) {
  return (await env.DB.prepare(`SELECT l.* FROM labels l JOIN pull_labels pl ON pl.label_id = l.id WHERE pl.pull_id = ? ORDER BY l.name`).bind(pullId).all()).results;
}

export async function getIssueRecord(env: ForgeEnv, repo: RepoRecord, number: number): Promise<IssueRecord> {
  const row = await env.DB.prepare(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`).bind(repo.id, number).first<IssueRecord>();
  if (!row) throw new Error(`issue #${number} not found`);
  return row;
}

export async function getPullRecord(env: ForgeEnv, repo: RepoRecord, number: number): Promise<PullRecord> {
  const row = await env.DB.prepare(`SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?`).bind(repo.id, number).first<PullRecord>();
  if (!row) throw new Error(`pull request #${number} not found`);
  return row;
}

export async function updateIssueProduct(
  env: ForgeEnv,
  repo: RepoRecord,
  number: number,
  input: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[]; milestone?: number | null },
) {
  const issue = await getIssueRecord(env, repo, number);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of [['title', input.title], ['body', input.body], ['state', input.state]] as const) {
    if (value !== undefined) { fields.push(`${field} = ?`); values.push(value); }
  }
  if (fields.length) {
    fields.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).bind(...values, issue.id).run();
  }
  if (input.labels) await setIssueLabels(env, repo, issue.id, input.labels);
  if (input.milestone !== undefined) {
    await env.DB.prepare(`DELETE FROM issue_milestones WHERE issue_id = ?`).bind(issue.id).run();
    if (input.milestone !== null) {
      const milestone = await env.DB.prepare(`SELECT id FROM milestones WHERE repo_id = ? AND number = ?`).bind(repo.id, input.milestone).first<{ id: string }>();
      if (!milestone) throw new Error(`milestone #${input.milestone} not found`);
      await env.DB.prepare(`INSERT INTO issue_milestones (issue_id, milestone_id) VALUES (?, ?)`).bind(issue.id, milestone.id).run();
    }
  }
  const updated = await getIssueRecord(env, repo, number);
  return { ...updated, labels: await labelsForIssue(env, issue.id) };
}

export async function updatePullProduct(
  env: ForgeEnv,
  repo: RepoRecord,
  number: number,
  input: { title?: string; body?: string; state?: 'open' | 'closed' | 'merged'; labels?: string[]; milestone?: number | null; headSha?: string },
) {
  const pull = await getPullRecord(env, repo, number);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of [['title', input.title], ['body', input.body], ['state', input.state], ['head_sha', input.headSha]] as const) {
    if (value !== undefined) { fields.push(`${field} = ?`); values.push(value); }
  }
  if (fields.length) {
    fields.push(`updated_at = datetime('now')`);
    await env.DB.prepare(`UPDATE pull_requests SET ${fields.join(', ')} WHERE id = ?`).bind(...values, pull.id).run();
  }
  if (input.labels) await setPullLabels(env, repo, pull.id, input.labels);
  if (input.milestone !== undefined) {
    await env.DB.prepare(`DELETE FROM pull_milestones WHERE pull_id = ?`).bind(pull.id).run();
    if (input.milestone !== null) {
      const milestone = await env.DB.prepare(`SELECT id FROM milestones WHERE repo_id = ? AND number = ?`).bind(repo.id, input.milestone).first<{ id: string }>();
      if (!milestone) throw new Error(`milestone #${input.milestone} not found`);
      await env.DB.prepare(`INSERT INTO pull_milestones (pull_id, milestone_id) VALUES (?, ?)`).bind(pull.id, milestone.id).run();
    }
  }
  const updated = await getPullRecord(env, repo, number);
  return { ...updated, labels: await labelsForPull(env, pull.id) };
}

export async function listReviewRequests(env: ForgeEnv, pull: PullRecord) {
  return (await env.DB.prepare(`SELECT reviewer, requested_at FROM pull_review_requests WHERE pull_id = ? ORDER BY requested_at`).bind(pull.id).all()).results;
}

export async function requestReviewers(env: ForgeEnv, pull: PullRecord, reviewers: string[]) {
  for (const reviewer of reviewers) {
    await env.DB.prepare(`INSERT INTO pull_review_requests (pull_id, reviewer) VALUES (?, ?) ON CONFLICT(pull_id, reviewer) DO UPDATE SET requested_at = datetime('now')`).bind(pull.id, reviewer).run();
  }
  return listReviewRequests(env, pull);
}

export async function listPullConversation(env: ForgeEnv, pull: PullRecord) {
  const [conversation, reviews, requests] = await Promise.all([
    env.DB.prepare(`SELECT * FROM pull_conversation WHERE pull_id = ? ORDER BY created_at, id`).bind(pull.id).all(),
    env.DB.prepare(`SELECT * FROM pull_reviews WHERE pull_id = ? ORDER BY created_at`).bind(pull.id).all(),
    listReviewRequests(env, pull),
  ]);
  return { conversation: conversation.results, reviews: reviews.results, reviewRequests: requests };
}

export async function addPullComment(env: ForgeEnv, pull: PullRecord, input: { author?: string; body: string; path?: string; line?: number }) {
  const id = crypto.randomUUID();
  const kind = input.path ? 'inline_comment' : 'comment';
  await env.DB.prepare(`INSERT INTO pull_conversation (id, pull_id, kind, author, body, path, line) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, pull.id, kind, input.author ?? 'system', input.body, input.path ?? null, input.line ?? null).run();
  return env.DB.prepare(`SELECT * FROM pull_conversation WHERE id = ?`).bind(id).first();
}

export async function submitPullReview(env: ForgeEnv, pull: PullRecord, input: { author?: string; state: 'commented' | 'approved' | 'changes_requested'; body?: string }) {
  const id = crypto.randomUUID();
  const author = input.author ?? 'system';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO pull_reviews (id, pull_id, author, state, body) VALUES (?, ?, ?, ?, ?)`).bind(id, pull.id, author, input.state, input.body ?? ''),
    env.DB.prepare(`INSERT INTO pull_conversation (id, pull_id, kind, author, body, review_state) VALUES (?, ?, 'review', ?, ?, ?)`).bind(crypto.randomUUID(), pull.id, author, input.body ?? '', input.state),
    env.DB.prepare(`DELETE FROM pull_review_requests WHERE pull_id = ? AND reviewer = ?`).bind(pull.id, author),
  ]);
  return env.DB.prepare(`SELECT * FROM pull_reviews WHERE id = ?`).bind(id).first();
}

export async function listReleases(env: ForgeEnv, repo: RepoRecord) {
  return (await env.DB.prepare(`SELECT * FROM releases WHERE repo_id = ? ORDER BY COALESCE(published_at, created_at) DESC`).bind(repo.id).all()).results;
}

export async function createRelease(env: ForgeEnv, repo: RepoRecord, input: { tagName: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; author?: string }) {
  const id = crypto.randomUUID();
  const draft = input.draft ? 1 : 0;
  await env.DB.prepare(`INSERT INTO releases (id, repo_id, tag_name, name, body, draft, prerelease, author, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, repo.id, input.tagName, input.name ?? input.tagName, input.body ?? '', draft, input.prerelease ? 1 : 0, input.author ?? 'system', draft ? null : new Date().toISOString()).run();
  return env.DB.prepare(`SELECT * FROM releases WHERE id = ?`).bind(id).first();
}

export async function listNotifications(env: ForgeEnv, repo: RepoRecord, unreadOnly = false, limit = 100) {
  const statement = unreadOnly
    ? env.DB.prepare(`SELECT * FROM notifications WHERE repo_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT ?`).bind(repo.id, limit)
    : env.DB.prepare(`SELECT * FROM notifications WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`).bind(repo.id, limit);
  return (await statement.all()).results;
}

export async function createNotification(env: ForgeEnv, repo: RepoRecord, input: { kind: string; title: string; body?: string; targetKind?: string; targetNumber?: number }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO notifications (id, repo_id, kind, title, body, target_kind, target_number) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, repo.id, input.kind, input.title, input.body ?? '', input.targetKind ?? null, input.targetNumber ?? null).run();
  return id;
}

export async function markNotificationRead(env: ForgeEnv, repo: RepoRecord, id: string) {
  await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND repo_id = ?`).bind(id, repo.id).run();
  return { id, read: true };
}

export async function recordContextEvent(env: ForgeEnv, repo: RepoRecord, input: { kind: string; ref?: string; sha?: string; targetKind?: string; targetNumber?: number; actor?: string; payload?: unknown }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO repo_context_events (id, repo_id, kind, ref, sha, target_kind, target_number, actor, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, repo.id, input.kind, input.ref ?? null, input.sha ?? null, input.targetKind ?? null, input.targetNumber ?? null, input.actor ?? 'system', JSON.stringify(input.payload ?? {})).run();
  return id;
}

export async function listContextEvents(env: ForgeEnv, repo: RepoRecord, limit = 50) {
  const rows = (await env.DB.prepare(`SELECT * FROM repo_context_events WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`).bind(repo.id, limit).all<Record<string, unknown> & { payload_json: string }>()).results;
  return rows.map(({ payload_json, ...row }) => {
    let payload: unknown = {};
    try { payload = JSON.parse(payload_json); } catch { payload = {}; }
    return { ...row, payload };
  });
}

export async function openAgentSession(env: ForgeEnv, repo: RepoRecord, input: { id?: string; agentName?: string; ref: string; targetKind?: string; targetNumber?: number; workspaceId?: string; accessMode: 'read-only' | 'write-capable' }) {
  const id = input.id ?? crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO agent_sessions (id, repo_id, agent_name, ref, target_kind, target_number, workspace_id, access_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET agent_name = excluded.agent_name, ref = excluded.ref, target_kind = excluded.target_kind, target_number = excluded.target_number, workspace_id = excluded.workspace_id, access_mode = excluded.access_mode, last_seen_at = datetime('now')`)
    .bind(id, repo.id, input.agentName ?? 'agent', input.ref, input.targetKind ?? null, input.targetNumber ?? null, input.workspaceId ?? null, input.accessMode).run();
  return env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).bind(id).first();
}

export async function touchAgentSession(env: ForgeEnv, id: string) {
  await env.DB.prepare(`UPDATE agent_sessions SET last_seen_at = datetime('now') WHERE id = ?`).bind(id).run();
}

export async function closeAgentSession(env: ForgeEnv, id: string) {
  await env.DB.prepare(`DELETE FROM agent_sessions WHERE id = ?`).bind(id).run();
  return { closed: true, id };
}

export async function listAgentSessions(env: ForgeEnv, repo: RepoRecord) {
  return (await env.DB.prepare(`SELECT * FROM agent_sessions WHERE repo_id = ? ORDER BY last_seen_at DESC LIMIT 100`).bind(repo.id).all()).results;
}

export async function getRepoByArtifactName(env: ForgeEnv, artifactName: string): Promise<RepoRecord | null> {
  return env.DB.prepare(`SELECT * FROM repositories WHERE artifact_name = ?`).bind(artifactName).first<RepoRecord>();
}

export async function ensureCiRun(env: ForgeEnv, repo: RepoRecord | null, input: { ref: string; sha?: string; workflowInstanceId: string }): Promise<CiRunRecord> {
  const existing = await env.DB.prepare(`SELECT * FROM ci_runs WHERE workflow_instance_id = ?`).bind(input.workflowInstanceId).first<CiRunRecord>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO ci_runs (id, repo_id, ref, sha, status, workflow_instance_id) VALUES (?, ?, ?, ?, 'running', ?)`)
    .bind(id, repo?.id ?? null, input.ref, input.sha ?? null, input.workflowInstanceId).run();
  const row = await env.DB.prepare(`SELECT * FROM ci_runs WHERE id = ?`).bind(id).first<CiRunRecord>();
  if (!row) throw new Error('CI run was not created');
  return row;
}

export async function updateCiRunStatus(env: ForgeEnv, runId: string, status: string) {
  await env.DB.prepare(`UPDATE ci_runs SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, runId).run();
}

export async function listCiRuns(env: ForgeEnv, repo: RepoRecord, limit = 100) {
  return (await env.DB.prepare(`SELECT * FROM ci_runs WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`).bind(repo.id, limit).all<CiRunRecord>()).results;
}

export async function getCiRun(env: ForgeEnv, repo: RepoRecord, runId: string) {
  const run = await env.DB.prepare(`SELECT * FROM ci_runs WHERE repo_id = ? AND id = ?`).bind(repo.id, runId).first<CiRunRecord>();
  if (!run) throw new Error(`CI run ${runId} not found`);
  return { ...run, steps: await listCiSteps(env, run.id) };
}

export async function checksForSha(env: ForgeEnv, repo: RepoRecord, sha: string) {
  const runs = (await env.DB.prepare(`SELECT * FROM ci_runs WHERE repo_id = ? AND sha = ? ORDER BY created_at DESC`).bind(repo.id, sha).all<CiRunRecord>()).results;
  return Promise.all(runs.map(async (run) => ({ ...run, steps: await listCiSteps(env, run.id) })));
}

export async function startCiStep(env: ForgeEnv, runId: string, name: string): Promise<CiStepRecord> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO ci_steps (id, run_id, name, status) VALUES (?, ?, ?, 'running')
    ON CONFLICT(run_id, name) DO UPDATE SET status = 'running', exit_code = NULL, stdout_key = NULL, stderr_key = NULL, started_at = datetime('now'), completed_at = NULL`)
    .bind(id, runId, name).run();
  const row = await env.DB.prepare(`SELECT * FROM ci_steps WHERE run_id = ? AND name = ?`).bind(runId, name).first<CiStepRecord>();
  if (!row) throw new Error(`CI step ${name} was not created`);
  return row;
}

export async function finishCiStep(env: ForgeEnv, stepId: string, input: { status: string; exitCode?: number; stdoutKey?: string; stderrKey?: string }) {
  await env.DB.prepare(`UPDATE ci_steps SET status = ?, exit_code = ?, stdout_key = ?, stderr_key = ?, completed_at = datetime('now') WHERE id = ?`)
    .bind(input.status, input.exitCode ?? null, input.stdoutKey ?? null, input.stderrKey ?? null, stepId).run();
}

export async function listCiSteps(env: ForgeEnv, runId: string) {
  return (await env.DB.prepare(`SELECT * FROM ci_steps WHERE run_id = ? ORDER BY started_at, name`).bind(runId).all<CiStepRecord>()).results;
}

export async function getCiStep(env: ForgeEnv, repo: RepoRecord, runId: string, stepId: string) {
  const row = await env.DB.prepare(`SELECT s.* FROM ci_steps s JOIN ci_runs r ON r.id = s.run_id WHERE s.id = ? AND s.run_id = ? AND r.repo_id = ?`).bind(stepId, runId, repo.id).first<CiStepRecord>();
  if (!row) throw new Error(`CI step ${stepId} not found`);
  return row;
}
