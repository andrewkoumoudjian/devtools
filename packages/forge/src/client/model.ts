export type RepoRecord = {
  id: string;
  owner: string;
  name: string;
  artifact_name: string;
  description: string;
  default_branch: string;
  visibility: 'private' | 'public';
  website?: string;
  artifact?: { remote?: string; defaultBranch?: string };
};

export type Commit = {
  hash: string;
  treeHash: string;
  message: string;
  author?: { name?: string; email?: string };
  committedAt?: number;
};

export type GitRef = { name: string; hash: string; type: 'branch' | 'tag' | 'other' };
export type GitRefs = { head: string | null; headHash: string | null; branches: GitRef[]; tags: GitRef[]; other: GitRef[] };

export type Label = { id: string; name: string; color: string; description: string };
export type Milestone = { id: string; number: number; title: string; description: string; state: 'open' | 'closed'; due_at: string | null };

export type Issue = {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  body: string;
  labels?: Label[];
};

export type Pull = {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  base_ref: string;
  head_ref: string;
  head_sha: string | null;
  body: string;
};

export type PullConversationItem = {
  id: string;
  kind: 'comment' | 'review' | 'inline_comment' | 'system';
  author: string;
  body: string;
  review_state?: 'commented' | 'approved' | 'changes_requested' | null;
  path?: string | null;
  line?: number | null;
  created_at: string;
};

export type PullDetail = Pull & {
  labels: Label[];
  reviewers: Array<{ reviewer: string; requested_at: string }>;
  conversation: {
    conversation: PullConversationItem[];
    reviews: Array<{ id: string; author: string; state: string; body: string; created_at: string }>;
    reviewRequests: Array<{ reviewer: string; requested_at: string }>;
  };
  checks: CiRun[];
};

export type FileChange = {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'type_changed';
  binary: boolean;
  truncated: boolean;
  patch: string | null;
};

export type PullDiff = {
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  filesChanged: number;
  truncated: boolean;
  changes: FileChange[];
};

export type CiStep = {
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

export type CiRun = {
  id: string;
  ref: string;
  sha: string | null;
  status: string;
  workflow_instance_id: string | null;
  created_at: string;
  steps?: CiStep[];
};

export type Release = {
  id: string;
  tag_name: string;
  name: string;
  body: string;
  draft: number;
  prerelease: number;
  author: string;
  created_at: string;
  published_at: string | null;
};

export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  target_kind: string | null;
  target_number: number | null;
  read_at: string | null;
  created_at: string;
};

export type RepoSettings = {
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
};

export type RepoContext = {
  generatedAt: string;
  authority: {
    repository: string;
    ref: string;
    headSha: string | null;
    target: { kind: 'issue' | 'pull'; number: number } | null;
    workingTree: 'read-only' | 'write-capable';
  };
  instructions: Array<{ path: string; content: string }>;
  openIssues: Issue[];
  openPullRequests: Pull[];
  activeAgents: Array<{ id: string; agent_name: string; ref: string; target_kind: string | null; target_number: number | null; access_mode: string; last_seen_at: string }>;
  recentEvents: Array<{ id: string; kind: string; actor: string; created_at: string; payload: unknown }>;
};

export type FileSearch = { ref: string; sha: string; matches: Array<{ path: string; hash: string; type: string }> };
export type CodeSearch = { ref: string; sha: string; query: string; matches: Array<{ path: string; hash: string; line: number; text: string }>; truncated: boolean };
export type LastCommit = Commit & { path?: string };
