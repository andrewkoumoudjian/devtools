import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles, Button, Header, Heading, Spinner, ThemeProvider } from '@primer/react';
import { BellIcon, PlusIcon, RepoIcon } from '@primer/octicons-react';
import 'artifacts-viewer/styles.css';
import './styles.css';
import type { RepoRecord } from './model';
import { execute, navigate, repoPath } from './api';
import { RepositoryPage } from './RepositoryPage';
import { PullDetail } from './PullDetail';

type RepoCreateResult = {
  repository: RepoRecord;
  remote: string;
  initialToken: unknown;
};

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
  return <Header><Header.Item><Header.Link href="/" className="forge-header-link" onClick={(event) => { event.preventDefault(); navigate('/'); }}><RepoIcon size={24} /><span>Forge</span></Header.Link></Header.Item><Header.Item full><span className="forge-muted">Cloudflare Artifacts</span></Header.Item><Header.Item><Header.Link href="/api/capabilities">API</Header.Link></Header.Item><Header.Item><Header.Link href="/mcp">MCP</Header.Link></Header.Item><Header.Item><BellIcon /></Header.Item></Header>;
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
    } catch (cause) { setError(cause); }
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
    } catch (cause) { setError(cause); }
  }

  return <main className="forge-container"><div className="forge-page-head"><div><Heading as="h1">Repositories</Heading><div className="forge-page-subtitle">Git repositories whose durable Git/filesystem state lives in Cloudflare Artifacts.</div></div><Button variant="primary" leadingVisual={PlusIcon} onClick={() => { setShowCreate((value) => !value); setCreated(null); }}>New repository</Button></div>{error ? <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div> : null}{showCreate ? <div className="forge-card"><form className="forge-form" onSubmit={createRepository}><Heading as="h2">Create a new repository</Heading><div className="forge-two-column"><div className="forge-field"><label htmlFor="owner">Owner</label><input id="owner" name="owner" className="forge-input" required /></div><div className="forge-field"><label htmlFor="repo">Repository name</label><input id="repo" name="repo" className="forge-input" required /></div></div><div className="forge-field"><label htmlFor="description">Description</label><textarea id="description" name="description" className="forge-textarea" /></div><div className="forge-field"><label htmlFor="visibility">Visibility</label><select id="visibility" name="visibility" className="forge-select"><option value="private">Private</option><option value="public">Public</option></select></div>{created ? <div className="forge-clone"><strong>Repository created.</strong><div className="forge-muted">The initial Git token is shown once. Treat it as a secret.</div><div className="forge-secret">{typeof created.initialToken === 'string' ? created.initialToken : JSON.stringify(created.initialToken)}</div><div style={{ marginTop: 10 }}><Button onClick={() => navigate(repoPath(created.repository.owner, created.repository.name))}>Open repository</Button></div></div> : null}<div className="forge-form-actions"><Button type="button" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" variant="primary">Create repository</Button></div></form></div> : null}<div className="forge-card" style={{ marginTop: 16 }}>{repos === null ? <div className="forge-loading"><Spinner /></div> : repos.length === 0 ? <div className="forge-empty">No repositories yet.</div> : repos.map((repo) => <button className="forge-repo-row forge-click-row" key={repo.id} onClick={() => navigate(repoPath(repo.owner, repo.name))}><div><div className="forge-repo-name">{repo.owner} / {repo.name}</div><div className="forge-page-subtitle">{repo.description || 'No description'} · {repo.default_branch}</div></div><span className="forge-badge">{repo.visibility}</span></button>)}</div></main>;
}

function App() {
  const pathname = usePathname();
  const pullMatch = pathname.match(/^\/r\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/);
  const repoMatch = pathname.match(/^\/r\/([^/]+)\/([^/]+)(?:\/.*)?$/);

  let content: React.ReactNode = <Dashboard />;
  if (pullMatch) {
    content = <main className="forge-container"><PullDetail owner={decodeURIComponent(pullMatch[1] ?? '')} repo={decodeURIComponent(pullMatch[2] ?? '')} number={Number(pullMatch[3])} /></main>;
  } else if (repoMatch) {
    content = <RepositoryPage owner={decodeURIComponent(repoMatch[1] ?? '')} repo={decodeURIComponent(repoMatch[2] ?? '')} pathname={pathname} />;
  }

  return <ThemeProvider colorMode="auto"><BaseStyles style={{ minHeight: '100vh', backgroundColor: 'var(--bgColor-default)' }}><div className="forge-shell"><AppHeader />{content}</div></BaseStyles></ThemeProvider>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
