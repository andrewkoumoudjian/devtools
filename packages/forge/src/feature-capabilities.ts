import { z } from 'zod';
import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { createIssue, createPull, getRepoRecord, listIssues, listPulls } from './db';
import { artifactRefs, artifactText, type GitRefs } from './artifacts';
import { buildRepoContext, type ContextTarget } from './context';
import {
  addPullComment,
  checksForSha,
  createLabel,
  createMilestone,
  createNotification,
  createRelease,
  getCiRun,
  getCiStep,
  getIssueRecord,
  getPullRecord,
  getRepoSettings,
  labelsForIssue,
  labelsForPull,
  listCiRuns,
  listContextEvents,
  listLabels,
  listMilestones,
  listNotifications,
  listPullConversation,
  listReleases,
  listReviewRequests,
  markNotificationRead,
  recordContextEvent,
  requestReviewers,
  submitPullReview,
  updateIssueProduct,
  updatePullProduct,
  updateRepoSettings,
} from './product';
import { createWorkspace, destroyWorkspace, repoGitCommand, shellQuote } from './workspace';

export type FeatureCapabilityContext = { env: ForgeEnv };
export type FeatureCapability = {
  name: string;
  description: string;
  mutates: boolean;
  inputSchema: Record<string, unknown>;
  parse: (value: unknown) => unknown;
  execute: (ctx: FeatureCapabilityContext, input: never) => Promise<unknown>;
};

function cap<T extends z.ZodType>(
  name: string,
  description: string,
  mutates: boolean,
  parser: T,
  inputSchema: Record<string, unknown>,
  execute: (ctx: FeatureCapabilityContext, input: z.infer<T>) => Promise<unknown>,
): FeatureCapability {
  return {
    name,
    description,
    mutates,
    inputSchema,
    parse: (value) => parser.parse(value),
    execute: execute as FeatureCapability['execute'],
  };
}

const repoRef = z.object({ owner: z.string().min(1), repo: z.string().min(1) });
const repoRefSchema = {
  type: 'object',
  properties: { owner: { type: 'string' }, repo: { type: 'string' } },
  required: ['owner', 'repo'],
};

async function repository(env: ForgeEnv, input: { owner: string; repo: string }) {
  return getRepoRecord(env, input.owner, input.repo);
}

async function emit(
  env: ForgeEnv,
  repo: RepoRecord,
  input: { kind: string; title: string; body?: string; targetKind?: string; targetNumber?: number; actor?: string; ref?: string; sha?: string; payload?: unknown },
) {
  await Promise.all([
    recordContextEvent(env, repo, {
      kind: input.kind,
      ref: input.ref,
      sha: input.sha,
      targetKind: input.targetKind,
      targetNumber: input.targetNumber,
      actor: input.actor,
      payload: input.payload,
    }),
    createNotification(env, repo, {
      kind: input.kind,
      title: input.title,
      body: input.body,
      targetKind: input.targetKind,
      targetNumber: input.targetNumber,
    }),
  ]);
}

async function resolveRevision(env: ForgeEnv, repo: RepoRecord, ref: string): Promise<{ git: string; hash?: string; kind: 'branch' | 'tag' | 'commit' }> {
  const refs = await artifactRefs(env, repo.artifact_name);
  const branch = refs.branches.find((item) => item.name === ref);
  if (branch) return { git: `refs/remotes/origin/${ref}`, hash: branch.hash, kind: 'branch' };
  const tag = refs.tags.find((item) => item.name === ref);
  if (tag) return { git: `refs/tags/${ref}`, hash: tag.hash, kind: 'tag' };
  if (/^[0-9a-f]{7,64}$/i.test(ref)) return { git: ref, hash: ref, kind: 'commit' };
  throw new Error(`unknown Git ref: ${ref}`);
}

function parseSearchLine(line: string, revision: string) {
  const prefix = `${revision}:`;
  const value = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  const first = value.indexOf(':');
  const second = first === -1 ? -1 : value.indexOf(':', first + 1);
  if (first === -1 || second === -1) return null;
  const lineNumber = Number.parseInt(value.slice(first + 1, second), 10);
  if (!Number.isFinite(lineNumber)) return null;
  return { path: value.slice(0, first), line: lineNumber, text: value.slice(second + 1) };
}

async function readReadme(env: ForgeEnv, repo: RepoRecord, ref: string) {
  for (const path of ['README.md', 'README.MD', 'README.markdown', 'README', 'README.txt']) {
    try {
      const content = await artifactText(env, repo.artifact_name, ref, path, 2_000_000);
      return { path, content };
    } catch {
      // Continue through conventional README names.
    }
  }
  return null;
}

async function ciLogBody(env: ForgeEnv, key: string | null) {
  if (!key) return '';
  const object = await env.BACKUP_BUCKET.get(key);
  if (!object) return '';
  return object.text();
}

function targetFrom(input: { issueNumber?: number; pullNumber?: number }): ContextTarget | undefined {
  if (input.pullNumber !== undefined) return { kind: 'pull', number: input.pullNumber };
  if (input.issueNumber !== undefined) return { kind: 'issue', number: input.issueNumber };
  return undefined;
}

export const featureCapabilities: FeatureCapability[] = [
  cap(
    'repo.settings.get',
    'Read repository product and agent-context settings.',
    false,
    repoRef,
    repoRefSchema,
    async ({ env }, input) => getRepoSettings(env, await repository(env, input)),
  ),
  cap(
    'repo.settings.update',
    'Update repository metadata, feature toggles, merge policy, and deterministic agent-context settings.',
    true,
    repoRef.extend({
      description: z.string().optional(),
      visibility: z.enum(['private', 'public']).optional(),
      website: z.string().optional(),
      issuesEnabled: z.boolean().optional(),
      pullsEnabled: z.boolean().optional(),
      actionsEnabled: z.boolean().optional(),
      releasesEnabled: z.boolean().optional(),
      mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
      deleteHeadOnMerge: z.boolean().optional(),
      agentContextEnabled: z.boolean().optional(),
      agentWriteEnabled: z.boolean().optional(),
      contextRecentCommits: z.number().int().min(1).max(100).optional(),
      contextRecentEvents: z.number().int().min(1).max(200).optional(),
      actor: z.string().optional(),
    }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const result = await updateRepoSettings(env, repo, {
        description: input.description,
        visibility: input.visibility,
        website: input.website,
        issues_enabled: input.issuesEnabled === undefined ? undefined : Number(input.issuesEnabled),
        pulls_enabled: input.pullsEnabled === undefined ? undefined : Number(input.pullsEnabled),
        actions_enabled: input.actionsEnabled === undefined ? undefined : Number(input.actionsEnabled),
        releases_enabled: input.releasesEnabled === undefined ? undefined : Number(input.releasesEnabled),
        merge_method: input.mergeMethod,
        delete_head_on_merge: input.deleteHeadOnMerge === undefined ? undefined : Number(input.deleteHeadOnMerge),
        agent_context_enabled: input.agentContextEnabled === undefined ? undefined : Number(input.agentContextEnabled),
        agent_write_enabled: input.agentWriteEnabled === undefined ? undefined : Number(input.agentWriteEnabled),
        context_recent_commits: input.contextRecentCommits,
        context_recent_events: input.contextRecentEvents,
      });
      await emit(env, repo, { kind: 'repo.settings.updated', title: 'Repository settings updated', actor: input.actor, payload: input });
      return result;
    },
  ),
  cap(
    'git.refs',
    'List live branches and tags from the Artifacts Git smart-HTTP advertisement.',
    false,
    repoRef,
    repoRefSchema,
    async ({ env }, input) => artifactRefs(env, (await repository(env, input)).artifact_name),
  ),
  cap(
    'fs.search',
    'Search repository file paths at a branch, tag, or commit. This powers go-to-file without an LLM.',
    false,
    repoRef.extend({ ref: z.string().default('main'), query: z.string().default(''), limit: z.number().int().min(1).max(500).default(100) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const revision = await resolveRevision(env, repo, input.ref);
      const output = await repoGitCommand(env, repo, `git ls-tree -r --name-only ${shellQuote(revision.git)}`);
      const query = input.query.toLowerCase();
      return output.split('\n').filter(Boolean).filter((path) => !query || path.toLowerCase().includes(query)).slice(0, input.limit).map((path) => ({ path }));
    },
  ),
  cap(
    'code.search',
    'Search tracked text content at a branch, tag, or commit using git grep. No embeddings or model call required.',
    false,
    repoRef.extend({ ref: z.string().default('main'), query: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } }, required: ['owner', 'repo', 'query'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const revision = await resolveRevision(env, repo, input.ref);
      const output = await repoGitCommand(env, repo, `git grep -n -I -e ${shellQuote(input.query)} ${shellQuote(revision.git)} -- || true`);
      return output.split('\n').filter(Boolean).map((line) => parseSearchLine(line, revision.git)).filter((row): row is NonNullable<typeof row> => row !== null).slice(0, input.limit);
    },
  ),
  cap(
    'file.last_commit',
    'Return the last commit touching one path at a branch, tag, or commit.',
    false,
    repoRef.extend({ ref: z.string().default('main'), path: z.string().min(1) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' } }, required: ['owner', 'repo', 'path'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const revision = await resolveRevision(env, repo, input.ref);
      const output = await repoGitCommand(env, repo, `git log -1 --format='%H%x00%an%x00%ae%x00%aI%x00%s' ${shellQuote(revision.git)} -- ${shellQuote(input.path)}`);
      const [hash = '', author = '', email = '', committedAt = '', subject = ''] = output.trim().split('\0');
      return hash ? { hash, author, email, committedAt, subject, path: input.path, ref: input.ref } : null;
    },
  ),
  cap(
    'readme.get',
    'Read the conventional repository README at a ref for landing-page rendering.',
    false,
    repoRef.extend({ ref: z.string().default('main') }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => readReadme(env, await repository(env, input), input.ref),
  ),
  cap(
    'label.list',
    'List repository labels.',
    false,
    repoRef,
    repoRefSchema,
    async ({ env }, input) => listLabels(env, await repository(env, input)),
  ),
  cap(
    'label.create',
    'Create a repository label.',
    true,
    repoRef.extend({ name: z.string().min(1), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(), description: z.string().optional(), actor: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } }, required: ['owner', 'repo', 'name'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const result = await createLabel(env, repo, input);
      await emit(env, repo, { kind: 'label.created', title: `Label created: ${input.name}`, actor: input.actor, payload: result });
      return result;
    },
  ),
  cap(
    'milestone.list',
    'List repository milestones.',
    false,
    repoRef.extend({ state: z.enum(['open', 'closed']).optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listMilestones(env, await repository(env, input), input.state),
  ),
  cap(
    'milestone.create',
    'Create a repository milestone.',
    true,
    repoRef.extend({ title: z.string().min(1), description: z.string().optional(), dueAt: z.string().optional(), actor: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const result = await createMilestone(env, repo, input);
      await emit(env, repo, { kind: 'milestone.created', title: `Milestone created: ${input.title}`, actor: input.actor, payload: result });
      return result;
    },
  ),
  cap(
    'issue.get',
    'Read an issue with labels.',
    false,
    repoRef.extend({ number: z.number().int().positive() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const issue = await getIssueRecord(env, repo, input.number);
      return { ...issue, labels: await labelsForIssue(env, issue.id) };
    },
  ),
  cap(
    'issue.update',
    'Update issue title/body/state/labels/milestone.',
    true,
    repoRef.extend({ number: z.number().int().positive(), title: z.string().optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), labels: z.array(z.string()).optional(), milestone: z.number().int().positive().nullable().optional(), actor: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const result = await updateIssueProduct(env, repo, input.number, input);
      await emit(env, repo, { kind: 'issue.updated', title: `Issue #${input.number} updated`, targetKind: 'issue', targetNumber: input.number, actor: input.actor, payload: result });
      return result;
    },
  ),
  cap(
    'pull.get',
    'Read a pull request with labels, reviewers, conversation, checks, and resolved live head SHA when available.',
    false,
    repoRef.extend({ number: z.number().int().positive() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const pull = await getPullRecord(env, repo, input.number);
      const refs = await artifactRefs(env, repo.artifact_name).catch(() => ({ branches: [], tags: [] } as unknown as GitRefs));
      const headSha = pull.head_sha ?? refs.branches.find((branch) => branch.name === pull.head_ref)?.hash ?? null;
      const [labels, conversation, reviewers, checks] = await Promise.all([
        labelsForPull(env, pull.id),
        listPullConversation(env, pull),
        listReviewRequests(env, pull),
        headSha ? checksForSha(env, repo, headSha) : Promise.resolve([]),
      ]);
      return { ...pull, head_sha: headSha, labels, conversation, reviewers, checks };
    },
  ),
  cap(
    'pull.update',
    'Update pull request metadata, state, labels, or milestone.',
    true,
    repoRef.extend({ number: z.number().int().positive(), title: z.string().optional(), body: z.string().optional(), state: z.enum(['open', 'closed', 'merged']).optional(), labels: z.array(z.string()).optional(), milestone: z.number().int().positive().nullable().optional(), headSha: z.string().optional(), actor: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const result = await updatePullProduct(env, repo, input.number, input);
      await emit(env, repo, { kind: 'pull.updated', title: `Pull request #${input.number} updated`, targetKind: 'pull', targetNumber: input.number, actor: input.actor, payload: result });
      return result;
    },
  ),
  cap(
    'pull.reviewers.list',
    'List requested reviewers for a pull request.',
    false,
    repoRef.extend({ number: z.number().int().positive() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      return listReviewRequests(env, await getPullRecord(env, repo, input.number));
    },
  ),
  cap(
    'pull.reviewers.request',
    'Request reviewers on a pull request.',
    true,
    repoRef.extend({ number: z.number().int().positive(), reviewers: z.array(z.string().min(1)).min(1), actor: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' }, reviewers: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'number', 'reviewers'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const pull = await getPullRecord(env, repo, input.number);
      const result = await requestReviewers(env, pull, input.reviewers);
      await emit(env, repo, { kind: 'pull.reviewers.requested', title: `Review requested on #${input.number}`, targetKind: 'pull', targetNumber: input.number, actor: input.actor, payload: { reviewers: input.reviewers } });
      return result;
    },
  ),
  cap(
    'pull.conversation.list',
    'Read the full stored pull-request conversation, submitted reviews, and outstanding review requests.',
    false,
    repoRef.extend({ number: z.number().int().positive() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      return listPullConversation(env, await getPullRecord(env, repo, input.number));
    },
  ),
  cap(
    'pull.comment',
    'Add a top-level or file/line pull-request comment.',
    true,
    repoRef.extend({ number: z.number().int().positive(), body: z.string().min(1), author: z.string().optional(), path: z.string().optional(), line: z.number().int().positive().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' }, body: { type: 'string' }, path: { type: 'string' }, line: { type: 'integer' } }, required: ['owner', 'repo', 'number', 'body'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const pull = await getPullRecord(env, repo, input.number);
      const result = await addPullComment(env, pull, input);
      await emit(env, repo, { kind: 'pull.comment.created', title: `New comment on #${input.number}`, targetKind: 'pull', targetNumber: input.number, actor: input.author, payload: result });
      return result;
    },
  ),
  cap(
    'pull.review',
    'Submit an approve/comment/changes-requested review.',
    true,
    repoRef.extend({ number: z.number().int().positive(), state: z.enum(['commented', 'approved', 'changes_requested']), body: z.string().optional(), author: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' }, state: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'number', 'state'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const pull = await getPullRecord(env, repo, input.number);
      const result = await submitPullReview(env, pull, input);
      await emit(env, repo, { kind: 'pull.review.submitted', title: `Review ${input.state} on #${input.number}`, targetKind: 'pull', targetNumber: input.number, actor: input.author, payload: result });
      return result;
    },
  ),
  cap(
    'pull.diff',
    'Generate the live three-dot Git diff between a pull request base and head using the Artifacts-backed repository.',
    false,
    repoRef.extend({ number: z.number().int().positive(), context: z.number().int().min(0).max(50).default(3) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' }, context: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const pull = await getPullRecord(env, repo, input.number);
      const [base, head] = await Promise.all([resolveRevision(env, repo, pull.base_ref), resolveRevision(env, repo, pull.head_ref)]);
      const diff = await repoGitCommand(env, repo, `git diff --no-ext-diff --unified=${input.context} ${shellQuote(base.git)}...${shellQuote(head.git)}`);
      return { number: input.number, base: pull.base_ref, head: pull.head_ref, diff };
    },
  ),
  cap(
    'pull.checks',
    'Read all Forge CI runs and step checks for the pull-request head SHA.',
    false,
    repoRef.extend({ number: z.number().int().positive() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const pull = await getPullRecord(env, repo, input.number);
      let sha = pull.head_sha;
      if (!sha) sha = (await artifactRefs(env, repo.artifact_name)).branches.find((branch) => branch.name === pull.head_ref)?.hash ?? null;
      return { sha, checks: sha ? await checksForSha(env, repo, sha) : [] };
    },
  ),
  cap(
    'release.list',
    'List repository releases.',
    false,
    repoRef,
    repoRefSchema,
    async ({ env }, input) => listReleases(env, await repository(env, input)),
  ),
  cap(
    'release.create',
    'Create release metadata for an existing Git tag.',
    true,
    repoRef.extend({ tagName: z.string().min(1), name: z.string().optional(), body: z.string().optional(), draft: z.boolean().default(false), prerelease: z.boolean().default(false), author: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, tagName: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'tagName'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const refs = await artifactRefs(env, repo.artifact_name);
      if (!refs.tags.some((tag) => tag.name === input.tagName)) throw new Error(`tag ${input.tagName} does not exist`);
      const result = await createRelease(env, repo, input);
      await emit(env, repo, { kind: 'release.created', title: `Release created: ${input.tagName}`, actor: input.author, ref: input.tagName, payload: result });
      return result;
    },
  ),
  cap(
    'notification.list',
    'List repository notifications.',
    false,
    repoRef.extend({ unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, unreadOnly: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listNotifications(env, await repository(env, input), input.unreadOnly, input.limit),
  ),
  cap(
    'notification.read',
    'Mark a repository notification read.',
    true,
    repoRef.extend({ id: z.string().min(1) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, id: { type: 'string' } }, required: ['owner', 'repo', 'id'] },
    async ({ env }, input) => markNotificationRead(env, await repository(env, input), input.id),
  ),
  cap(
    'context.snapshot',
    'Build the deterministic shared RepoContext used by every agent. No LLM call is made.',
    false,
    repoRef.extend({ ref: z.string().optional(), issueNumber: z.number().int().positive().optional(), pullNumber: z.number().int().positive().optional(), agentName: z.string().optional(), accessMode: z.enum(['read-only', 'write-capable']).optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, issueNumber: { type: 'integer' }, pullNumber: { type: 'integer' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => buildRepoContext(env, await repository(env, input), { ref: input.ref, target: targetFrom(input), agentName: input.agentName, accessMode: input.accessMode }),
  ),
  cap(
    'context.events',
    'Read the append-only deterministic repository context event stream.',
    false,
    repoRef.extend({ limit: z.number().int().min(1).max(200).default(50) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listContextEvents(env, await repository(env, input), input.limit),
  ),
  cap(
    'context.session.open',
    'Open an ArtifactFS agent session and materialize the shared deterministic context under .git/forge/.',
    true,
    repoRef.extend({ ref: z.string().default('main'), agentName: z.string().default('agent'), issueNumber: z.number().int().positive().optional(), pullNumber: z.number().int().positive().optional(), accessMode: z.enum(['read-only', 'write-capable']).default('write-capable'), workspaceId: z.string().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, agentName: { type: 'string' }, accessMode: { type: 'string' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => createWorkspace(env, await repository(env, input), input.ref, input.workspaceId, { agentName: input.agentName, target: targetFrom(input), accessMode: input.accessMode }),
  ),
  cap(
    'context.session.close',
    'Close an agent workspace/context session.',
    true,
    z.object({ workspaceId: z.string().min(1) }),
    { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] },
    async ({ env }, input) => destroyWorkspace(env, input.workspaceId),
  ),
  cap(
    'ci.list',
    'List Cloudflare-native CI runs for a repository.',
    false,
    repoRef.extend({ limit: z.number().int().min(1).max(200).default(100) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'integer' } }, required: ['owner', 'repo'] },
    async ({ env }, input) => listCiRuns(env, await repository(env, input), input.limit),
  ),
  cap(
    'ci.get',
    'Read one CI run and all of its step statuses.',
    false,
    repoRef.extend({ runId: z.string().min(1) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, runId: { type: 'string' } }, required: ['owner', 'repo', 'runId'] },
    async ({ env }, input) => getCiRun(env, await repository(env, input), input.runId),
  ),
  cap(
    'ci.step.log',
    'Read complete persisted stdout/stderr for one CI step.',
    false,
    repoRef.extend({ runId: z.string().min(1), stepId: z.string().min(1) }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, runId: { type: 'string' }, stepId: { type: 'string' } }, required: ['owner', 'repo', 'runId', 'stepId'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const step = await getCiStep(env, repo, input.runId, input.stepId);
      const [stdout, stderr] = await Promise.all([ciLogBody(env, step.stdout_key), ciLogBody(env, step.stderr_key)]);
      return { step, stdout, stderr };
    },
  ),
  cap(
    'issue.create.enriched',
    'Create an issue with labels/milestone and emit notification/context events.',
    true,
    repoRef.extend({ title: z.string().min(1), body: z.string().optional(), author: z.string().optional(), labels: z.array(z.string()).default([]), milestone: z.number().int().positive().nullable().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const created = await createIssue(env, repo, input) as { number: number } | null;
      if (!created) throw new Error('issue was not created');
      const result = await updateIssueProduct(env, repo, created.number, { labels: input.labels, milestone: input.milestone });
      await emit(env, repo, { kind: 'issue.created', title: `Issue #${created.number}: ${input.title}`, targetKind: 'issue', targetNumber: created.number, actor: input.author, payload: result });
      return result;
    },
  ),
  cap(
    'pull.create.enriched',
    'Create a pull request with live head SHA, labels/reviewers/milestone and emit context events.',
    true,
    repoRef.extend({ title: z.string().min(1), body: z.string().optional(), baseRef: z.string(), headRef: z.string(), author: z.string().optional(), labels: z.array(z.string()).default([]), reviewers: z.array(z.string()).default([]), milestone: z.number().int().positive().nullable().optional() }),
    { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, baseRef: { type: 'string' }, headRef: { type: 'string' } }, required: ['owner', 'repo', 'title', 'baseRef', 'headRef'] },
    async ({ env }, input) => {
      const repo = await repository(env, input);
      const refs = await artifactRefs(env, repo.artifact_name);
      const headSha = refs.branches.find((branch) => branch.name === input.headRef)?.hash;
      if (!headSha) throw new Error(`head branch ${input.headRef} does not exist`);
      if (!refs.branches.some((branch) => branch.name === input.baseRef)) throw new Error(`base branch ${input.baseRef} does not exist`);
      const created = await createPull(env, repo, { ...input, headSha }) as { number: number } | null;
      if (!created) throw new Error('pull request was not created');
      const pull = await getPullRecord(env, repo, created.number);
      await updatePullProduct(env, repo, created.number, { labels: input.labels, milestone: input.milestone, headSha });
      if (input.reviewers.length) await requestReviewers(env, pull, input.reviewers);
      const result = await getPullRecord(env, repo, created.number);
      await emit(env, repo, { kind: 'pull.created', title: `Pull request #${created.number}: ${input.title}`, targetKind: 'pull', targetNumber: created.number, actor: input.author, ref: input.headRef, sha: headSha, payload: result });
      return result;
    },
  ),
];
