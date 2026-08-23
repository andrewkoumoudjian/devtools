import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BaseStyles,
  BranchName,
  Button,
  Header,
  Heading,
  Spinner,
  StateLabel,
  ThemeProvider,
  UnderlineNav,
} from '@primer/react';
import {
  CodeIcon,
  CopyIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  PlayIcon,
  PlusIcon,
  RepoIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { createArtifactsClient } from 'artifacts-viewer/client';
import { ArtifactRepoViewer } from 'artifacts-viewer/react';
import 'artifacts-viewer/styles.css';
import './styles.css';

type RepoRecord = {
  id: string;
  owner: string;
  name: string;
  artifact_name: string;
  description: string;
  default_branch: string;
  visibility: 'private' | 'public';
  artifact?: {
    remote?: string;
    defaultBranch?: string;
  };
};

type Commit = {
  hash: string;
  treeHash: string;
  message: string;
  author?: { name?: string; email?: string };
  committedAt?: number;
};

type Issue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  body?: string;
};

type Pull = {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  base_ref: string;
  head_ref: string;
  body?: string;
};

type CiRun = {
  id: string;
  ref: string;
  sha: string | null;
  status: string;
  workflow_instance_id: string | null;
  created_at: string;
};

type RepoCreateResult = {
  repository: RepoRecord;
  remote: string;
  initialToken: unknown;
};

const artifactsClient = createArtifactsClient({ apiPath: '/artifacts' });

async function execute<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload.result as T;
}

function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePathname() {
  const [pathname, setPathname] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPathname(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return pathname;
}

function AppHeader() {
  return (
    <Header>
      <Header.Item>
        <Header.Link href="/" className="forge-header-link" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
          <RepoIcon size={24} />
          <span>Forge</span>
        </Header.Link>
      </Header.Item>
      <Header.Item full>
        <span className="forge-muted">Cloudflare Artifacts</span>
      </Header.Item>
      <Header.Item><Header.Link href="/api/capabilities">API</Header.Link></Header.Item>
      <Header.Item><Header.Link href="/mcp">MCP</Header.Link></Header.Item>
    </Header>
  );
}

function ErrorMessage({ error }: { error: unknown }) {
  return <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div>;
}

function Dashboard() {
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<RepoCreateResult | null>(null);

  async function reload() {
    try {
      setError(null);
      setRepos(await execute<RepoRecord[]>('repo.list'));
    } catch (cause) {
      setError(cause);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function createRepository(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setError(null);
      const result = await execute<RepoCreateResult>('repo.create', {
        owner: String(data.get('owner') ?? ''),
        repo: String(data.get('repo') ?? ''),
        description: String(data.get('description') ?? ''),
        visibility: String(data.get('visibility') ?? 'private'),
      });
      setCreated(result);
      await reload();
    } catch (cause) {
      setError(cause);
    }
  }

  return (
    <main className="forge-container">
      <div className="forge-page-head">
        <div>
          <Heading as="h1">Repositories</Heading>
          <div className="forge-page-subtitle">Git repositories stored in Cloudflare Artifacts.</div>
        </div>
        <Button variant="primary" leadingVisual={PlusIcon} onClick={() => { setShowCreate((value) => !value); setCreated(null); }}>
          New repository
        </Button>
      </div>

      {error ? <ErrorMessage error={error} /> : null}
      {showCreate ? (
        <div className="forge-card">
          <form className="forge-form" onSubmit={createRepository}>
            <Heading as="h2">Create a new repository</Heading>
            <div className="forge-field"><label htmlFor="owner">Owner</label><input id="owner" name="owner" className="forge-input" required /></div>
            <div className="forge-field"><label htmlFor="repo">Repository name</label><input id="repo" name="repo" className="forge-input" required /></div>
            <div className="forge-field"><label htmlFor="description">Description</label><textarea id="description" name="description" className="forge-textarea" /></div>
            <div className="forge-field"><label htmlFor="visibility">Visibility</label><select id="visibility" name="visibility" className="forge-select"><option value="private">Private</option><option value="public">Public</option></select></div>
            {created ? (
              <div className="forge-clone">
                <strong>Repository created.</strong>
                <div className="forge-muted">The initial Git token is shown once. Treat it as a secret.</div>
                <div className="forge-secret">{typeof created.initialToken === 'string' ? created.initialToken : JSON.stringify(created.initialToken)}</div>
                <div style={{ marginTop: 10 }}>
                  <Button onClick={() => navigate(`/r/${encodeURIComponent(created.repository.owner)}/${encodeURIComponent(created.repository.name)}`)}>Open repository</Button>
                </div>
              </div>
            ) : null}
            <div className="forge-form-actions"><Button type="button" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" variant="primary">Create repository</Button></div>
          </form>
        </div>
      ) : null}

      <div className="forge-card" style={{ marginTop: 16 }}>
        {repos === null ? <div className="forge-loading"><Spinner /></div> : repos.length === 0 ? <div className="forge-empty">No repositories yet.</div> : repos.map((repo) => (
          <div className="forge-repo-row" key={repo.id}>
            <div>
              <a className="forge-repo-name" href={`/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`} onClick={(event) => { event.preventDefault(); navigate(event.currentTarget.pathname); }}>
                {repo.owner} / {repo.name}
              </a>
              <div className="forge-page-subtitle">{repo.description || 'No description'} · {repo.default_branch}</div>
            </div>
            <span className="forge-badge">{repo.visibility}</span>
          </div>
        ))}
      </div>
    </main>
  );
}

type RepoTab = 'code' | 'issues' | 'pulls' | 'actions';

function RepositoryPage({ owner, repo }: { owner: string; repo: string }) {
  const [meta, setMeta] = useState<RepoRecord | null>(null);
  const [tab, setTab] = useState<RepoTab>('code');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [runs, setRuns] = useState<CiRun[]>([]);
  const [error, setError] = useState<unknown>(null);

  async function refreshSummary() {
    const [repository, issueRows, pullRows, ciRows] = await Promise.all([
      execute<RepoRecord>('repo.get', { owner, repo }),
      execute<Issue[]>('issue.list', { owner, repo }),
      execute<Pull[]>('pull.list', { owner, repo }),
      execute<CiRun[]>('ci.list', { owner, repo }).catch(() => []),
    ]);
    setMeta(repository);
    setIssues(issueRows);
    setPulls(pullRows);
    setRuns(ciRows);
  }

  useEffect(() => {
    setMeta(null);
    setError(null);
    void refreshSummary().catch(setError);
  }, [owner, repo]);

  if (error) return <main className="forge-container"><ErrorMessage error={error} /></main>;
  if (!meta) return <main className="forge-container"><div className="forge-loading"><Spinner /></div></main>;

  const openIssues = issues.filter((item) => item.state === 'open').length;
  const openPulls = pulls.filter((item) => item.state === 'open').length;

  return (
    <main className="forge-container">
      <div className="forge-repo-header">
        <div>
          <div className="forge-repo-title">
            <RepoIcon size={20} />
            <a href="/" className="forge-owner" onClick={(event) => { event.preventDefault(); navigate('/'); }}>{owner}</a>
            <span className="forge-muted">/</span>
            <a href={`/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`} className="forge-title-link" onClick={(event) => { event.preventDefault(); navigate(event.currentTarget.pathname); }}>{repo}</a>
            <span className="forge-badge">{meta.visibility}</span>
          </div>
          <div className="forge-page-subtitle">{meta.description || 'No description provided.'}</div>
        </div>
      </div>

      <div className="forge-tabs">
        <UnderlineNav aria-label="Repository">
          <UnderlineNav.Item leadingVisual={<CodeIcon />} aria-current={tab === 'code' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('code'); }}>Code</UnderlineNav.Item>
          <UnderlineNav.Item leadingVisual={<IssueOpenedIcon />} counter={openIssues} aria-current={tab === 'issues' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('issues'); }}>Issues</UnderlineNav.Item>
          <UnderlineNav.Item leadingVisual={<GitPullRequestIcon />} counter={openPulls} aria-current={tab === 'pulls' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('pulls'); }}>Pull requests</UnderlineNav.Item>
          <UnderlineNav.Item leadingVisual={<PlayIcon />} counter={runs.length} aria-current={tab === 'actions' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('actions'); }}>Actions</UnderlineNav.Item>
        </UnderlineNav>
      </div>

      {tab === 'code' ? <CodeTab owner={owner} repo={repo} meta={meta} /> : null}
      {tab === 'issues' ? <IssuesTab owner={owner} repo={repo} issues={issues} refresh={refreshSummary} /> : null}
      {tab === 'pulls' ? <PullsTab owner={owner} repo={repo} pulls={pulls} defaultBranch={meta.default_branch} refresh={refreshSummary} /> : null}
      {tab === 'actions' ? <ActionsTab owner={owner} repo={repo} runs={runs} refresh={refreshSummary} /> : null}
    </main>
  );
}

function CodeTab({ owner, repo, meta }: { owner: string; repo: string; meta: RepoRecord }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [showCommits, setShowCommits] = useState(false);
  const [clone, setClone] = useState<{ token: string; expiresAt?: string; remote?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void execute<Commit[]>('git.log', { owner, repo, ref: meta.default_branch, limit: 50 }).then(setCommits).catch(setError);
  }, [owner, repo, meta.default_branch]);

  const latest = commits?.[0];

  async function createCloneToken() {
    try {
      const token = await execute<{ plaintext: string; expiresAt?: string }>('repo.token.create', { owner, repo, scope: 'read', ttl: 3600 });
      setClone({ ...token, token: token.plaintext, remote: meta.artifact?.remote });
    } catch (cause) {
      setError(cause);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
  }

  if (error) return <ErrorMessage error={error} />;

  return (
    <section>
      <div className="forge-code-toolbar">
        <div className="forge-toolbar-left"><BranchName>{meta.default_branch}</BranchName></div>
        <div className="forge-toolbar-right">
          <Button leadingVisual={GitCommitIcon} onClick={() => setShowCommits((value) => !value)}>Commits{commits ? ` (${commits.length})` : ''}</Button>
          <Button variant="primary" onClick={createCloneToken}>Code</Button>
        </div>
      </div>

      {clone ? (
        <div className="forge-clone">
          <strong>Clone this repository</strong>
          {clone.remote ? <div className="forge-secret">{clone.remote} <Button aria-label="Copy remote" leadingVisual={CopyIcon} onClick={() => void copy(clone.remote ?? '')}>Copy</Button></div> : null}
          <div className="forge-muted" style={{ marginTop: 10 }}>Username: <code>x</code>. Use this one-hour token as the Git HTTP password:</div>
          <div className="forge-secret">{clone.token} <Button aria-label="Copy token" leadingVisual={CopyIcon} onClick={() => void copy(clone.token)}>Copy</Button></div>
        </div>
      ) : null}

      {showCommits ? (
        <div className="forge-card">
          <div className="forge-list-head"><strong>Commit history</strong><span className="forge-muted">{meta.default_branch}</span></div>
          {commits === null ? <div className="forge-loading"><Spinner /></div> : commits.length === 0 ? <div className="forge-empty">No commits yet.</div> : commits.map((commit) => (
            <div className="forge-commit-row" key={commit.hash}>
              <div><div className="forge-list-title">{commit.message?.split('\n')[0] || '(no message)'}</div><div className="forge-list-meta">{commit.author?.name || 'unknown author'}</div></div>
              <span className="forge-sha">{commit.hash.slice(0, 10)}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          {latest ? (
            <div className="forge-latest-commit">
              <div><strong>{latest.author?.name || 'unknown author'}</strong> <span className="forge-muted">{latest.message?.split('\n')[0]}</span></div>
              <span className="forge-sha">{latest.hash.slice(0, 10)}</span>
            </div>
          ) : null}
          <div className="forge-viewer forge-artifacts-viewer">
            <ArtifactRepoViewer client={artifactsClient} repoName={meta.artifact_name} gitRef={meta.default_branch} colorMode="system" />
          </div>
        </>
      )}
    </section>
  );
}

function IssuesTab({ owner, repo, issues, refresh }: { owner: string; repo: string; issues: Issue[]; refresh: () => Promise<void> }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rows = useMemo(() => issues.filter((item) => item.state === state), [issues, state]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('issue.create', { owner, repo, title: String(data.get('title') ?? ''), body: String(data.get('body') ?? '') });
      setCreating(false);
      await refresh();
    } catch (cause) { setError(cause); }
  }

  return (
    <section>
      {error ? <ErrorMessage error={error} /> : null}
      <div className="forge-code-toolbar">
        <div className="forge-toolbar-left"><Button onClick={() => setState('open')}>Open</Button><Button onClick={() => setState('closed')}>Closed</Button></div>
        <Button variant="primary" leadingVisual={PlusIcon} onClick={() => setCreating((value) => !value)}>New issue</Button>
      </div>
      {creating ? <div className="forge-card"><form className="forge-form" onSubmit={submit}><div className="forge-field"><label>Title</label><input className="forge-input" name="title" required /></div><div className="forge-field"><label>Description</label><textarea className="forge-textarea" name="body" /></div><div className="forge-form-actions"><Button type="button" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary">Submit issue</Button></div></form></div> : null}
      <div className="forge-card">
        <div className="forge-list-head"><strong>{state === 'open' ? 'Open' : 'Closed'} issues</strong><span className="forge-muted">{rows.length}</span></div>
        {rows.length === 0 ? <div className="forge-empty">No {state} issues.</div> : rows.map((issue) => <div className="forge-list-row" key={issue.number}><IssueOpenedIcon /><div><div className="forge-list-title">{issue.title}</div><div className="forge-list-meta">#{issue.number} opened by {issue.author}</div></div><StateLabel status={issue.state === 'open' ? 'issueOpened' : 'issueClosed'} size="small">{issue.state === 'open' ? 'Open' : 'Closed'}</StateLabel></div>)}
      </div>
    </section>
  );
}

function PullsTab({ owner, repo, pulls, defaultBranch, refresh }: { owner: string; repo: string; pulls: Pull[]; defaultBranch: string; refresh: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('pull.create', {
        owner,
        repo,
        title: String(data.get('title') ?? ''),
        body: String(data.get('body') ?? ''),
        baseRef: String(data.get('baseRef') ?? defaultBranch),
        headRef: String(data.get('headRef') ?? ''),
      });
      setCreating(false);
      await refresh();
    } catch (cause) { setError(cause); }
  }

  return (
    <section>
      {error ? <ErrorMessage error={error} /> : null}
      <div className="forge-code-toolbar"><div /><Button variant="primary" leadingVisual={PlusIcon} onClick={() => setCreating((value) => !value)}>New pull request</Button></div>
      {creating ? <div className="forge-card"><form className="forge-form" onSubmit={submit}><div className="forge-field"><label>Title</label><input className="forge-input" name="title" required /></div><div className="forge-field"><label>Base branch</label><input className="forge-input" name="baseRef" defaultValue={defaultBranch} required /></div><div className="forge-field"><label>Compare branch</label><input className="forge-input" name="headRef" required /></div><div className="forge-field"><label>Description</label><textarea className="forge-textarea" name="body" /></div><div className="forge-form-actions"><Button type="button" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary">Create pull request</Button></div></form></div> : null}
      <div className="forge-card">
        <div className="forge-list-head"><strong>Pull requests</strong><span className="forge-muted">{pulls.length}</span></div>
        {pulls.length === 0 ? <div className="forge-empty">No pull requests.</div> : pulls.map((pull) => <div className="forge-list-row" key={pull.number}><GitPullRequestIcon /><div><div className="forge-list-title">{pull.title}</div><div className="forge-list-meta">#{pull.number} {pull.head_ref} → {pull.base_ref} · {pull.author}</div></div><StateLabel status={pull.state === 'merged' ? 'pullMerged' : pull.state === 'closed' ? 'pullClosed' : 'pullOpened'} size="small">{pull.state}</StateLabel></div>)}
      </div>
    </section>
  );
}

function ActionsTab({ owner, repo, runs, refresh }: { owner: string; repo: string; runs: CiRun[]; refresh: () => Promise<void> }) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => { void execute<Commit[]>('git.log', { owner, repo, limit: 1 }).then(setCommits).catch(setError); }, [owner, repo]);

  async function runLatest() {
    const latest = commits[0];
    if (!latest) return;
    try {
      await execute('ci.run', { owner, repo, ref: 'main', sha: latest.hash });
      await refresh();
    } catch (cause) { setError(cause); }
  }

  return (
    <section>
      {error ? <ErrorMessage error={error} /> : null}
      <div className="forge-code-toolbar"><div><Heading as="h2">Actions</Heading><div className="forge-page-subtitle">Cloudflare Workflows + Sandbox CI.</div></div><Button variant="primary" leadingVisual={SyncIcon} onClick={runLatest} disabled={!commits[0]}>Run latest</Button></div>
      <div className="forge-card">
        <div className="forge-list-head"><strong>Workflow runs</strong><span className="forge-muted">{runs.length}</span></div>
        {runs.length === 0 ? <div className="forge-empty">No CI runs recorded yet.</div> : runs.map((run) => <div className="forge-list-row" key={run.id}><PlayIcon /><div><div className="forge-list-title">{run.ref}</div><div className="forge-list-meta">{run.sha?.slice(0, 10) || 'no sha'} · {run.workflow_instance_id || 'pending workflow id'}</div></div><span className="forge-badge">{run.status}</span></div>)}
      </div>
    </section>
  );
}

function App() {
  const pathname = usePathname();
  const match = pathname.match(/^\/r\/([^/]+)\/([^/]+)\/?$/);
  return (
    <ThemeProvider colorMode="auto">
      <BaseStyles style={{ minHeight: '100vh', backgroundColor: 'var(--bgColor-default)' }}>
        <div className="forge-shell">
          <AppHeader />
          {match ? <RepositoryPage owner={decodeURIComponent(match[1] ?? '')} repo={decodeURIComponent(match[2] ?? '')} /> : <Dashboard />}
        </div>
      </BaseStyles>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
