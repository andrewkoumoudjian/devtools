import React, { useEffect, useMemo, useState } from 'react';
import { BranchName, Button, Heading, Spinner } from '@primer/react';
import { CodeIcon, CopyIcon, GitCommitIcon, SearchIcon, TagIcon, XIcon } from '@primer/octicons-react';
import { createArtifactsClient } from 'artifacts-viewer/client';
import { ArtifactRepoViewer, CodeView } from 'artifacts-viewer/react';
import type { RepoRecord, Commit, GitRefs, FileSearch, CodeSearch, LastCommit } from './model';
import { execute } from './api';
import { Markdown } from './Markdown';

const artifactsClient = createArtifactsClient({ apiPath: '/artifacts' });

type CloneInfo = { plaintext: string; expiresAt?: string };
type Readme = { path: string; content: string } | null;
type FileView = { path: string; ref: string; size: number; text: string };

function setQuery(values: Record<string, string | null>) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState({}, '', `${url.pathname}${url.search}`);
}

export function CodeTab({ owner, repo, meta }: { owner: string; repo: string; meta: RepoRecord }) {
  const initial = new URL(location.href);
  const [ref, setRef] = useState(initial.searchParams.get('ref') || meta.default_branch);
  const [path, setPath] = useState(initial.searchParams.get('path') || '');
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [readme, setReadme] = useState<Readme>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [lastCommit, setLastCommit] = useState<LastCommit | null>(null);
  const [clone, setClone] = useState<CloneInfo | null>(null);
  const [showCommits, setShowCommits] = useState(false);
  const [searchMode, setSearchMode] = useState<'files' | 'code' | null>(null);
  const [query, setQueryValue] = useState('');
  const [fileResults, setFileResults] = useState<FileSearch | null>(null);
  const [codeResults, setCodeResults] = useState<CodeSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    void Promise.all([
      execute<GitRefs>('git.refs', { owner, repo }).then(setRefs),
      execute<Commit[]>('git.log', { owner, repo, ref, limit: 50 }).then(setCommits),
      execute<Readme>('readme.get', { owner, repo, ref }).then(setReadme),
    ]).catch(setError);
  }, [owner, repo, ref]);

  useEffect(() => {
    if (!path) {
      setFile(null);
      setLastCommit(null);
      return;
    }
    setError(null);
    void Promise.all([
      execute<FileView>('fs.read', { owner, repo, ref, path }),
      execute<LastCommit | null>('file.last_commit', { owner, repo, ref, path }),
    ]).then(([nextFile, nextCommit]) => {
      setFile(nextFile);
      setLastCommit(nextCommit);
    }).catch(setError);
  }, [owner, repo, ref, path]);

  const latest = commits?.[0];
  const branchCount = refs?.branches.length ?? 0;
  const tagCount = refs?.tags.length ?? 0;

  const refOptions = useMemo(() => {
    if (!refs) return [];
    return [
      ...refs.branches.map((item) => ({ label: item.name, value: item.name, kind: 'branch' as const })),
      ...refs.tags.map((item) => ({ label: item.name, value: item.name, kind: 'tag' as const })),
    ];
  }, [refs]);

  function changeRef(next: string) {
    setRef(next);
    setPath('');
    setFile(null);
    setQuery({ ref: next === meta.default_branch ? null : next, path: null });
  }

  function openFile(nextPath: string) {
    setPath(nextPath);
    setSearchMode(null);
    setQuery({ ref: ref === meta.default_branch ? null : ref, path: nextPath });
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim() || !searchMode) return;
    setSearching(true);
    setError(null);
    try {
      if (searchMode === 'files') {
        setFileResults(await execute<FileSearch>('fs.search', { owner, repo, ref, query, limit: 100 }));
        setCodeResults(null);
      } else {
        setCodeResults(await execute<CodeSearch>('code.search', { owner, repo, ref, query, limit: 100 }));
        setFileResults(null);
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setSearching(false);
    }
  }

  async function createCloneToken() {
    try {
      setError(null);
      setClone(await execute<CloneInfo>('repo.token.create', { owner, repo, scope: 'read', ttl: 3600 }));
    } catch (cause) {
      setError(cause);
    }
  }

  if (error) {
    return <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div>;
  }

  return (
    <section>
      <div className="forge-code-toolbar">
        <div className="forge-toolbar-left">
          <label className="forge-ref-picker">
            <span className="forge-sr-only">Branch or tag</span>
            <select className="forge-select forge-ref-select" value={ref} onChange={(event) => changeRef(event.target.value)}>
              {refOptions.length === 0 ? <option value={ref}>{ref}</option> : null}
              {refs?.branches.length ? <optgroup label={`Branches (${branchCount})`}>{refs.branches.map((item) => <option key={`b-${item.name}`} value={item.name}>{item.name}</option>)}</optgroup> : null}
              {refs?.tags.length ? <optgroup label={`Tags (${tagCount})`}>{refs.tags.map((item) => <option key={`t-${item.name}`} value={item.name}>{item.name}</option>)}</optgroup> : null}
            </select>
          </label>
          <span className="forge-ref-summary"><BranchName>{ref}</BranchName> · {branchCount} branches · {tagCount} tags</span>
        </div>
        <div className="forge-toolbar-right">
          <Button leadingVisual={SearchIcon} onClick={() => { setSearchMode('files'); setFileResults(null); setCodeResults(null); }}>Go to file</Button>
          <Button leadingVisual={CodeIcon} onClick={() => { setSearchMode('code'); setFileResults(null); setCodeResults(null); }}>Search code</Button>
          <Button leadingVisual={GitCommitIcon} onClick={() => setShowCommits((value) => !value)}>Commits{commits ? ` (${commits.length})` : ''}</Button>
          <Button variant="primary" onClick={createCloneToken}>Code</Button>
        </div>
      </div>

      {searchMode ? (
        <div className="forge-search-panel forge-card">
          <form className="forge-search-form" onSubmit={runSearch}>
            <SearchIcon />
            <input className="forge-input" autoFocus value={query} onChange={(event) => setQueryValue(event.target.value)} placeholder={searchMode === 'files' ? 'Find a file in this repository…' : 'Search literal code text…'} />
            <Button type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</Button>
            <Button type="button" leadingVisual={XIcon} onClick={() => setSearchMode(null)}>Close</Button>
          </form>
          {fileResults ? <div className="forge-search-results">{fileResults.matches.length === 0 ? <div className="forge-empty">No matching files.</div> : fileResults.matches.map((match) => <button className="forge-search-result" key={match.path} onClick={() => openFile(match.path)}><span>{match.path}</span><span className="forge-muted">{match.type}</span></button>)}</div> : null}
          {codeResults ? <div className="forge-search-results">{codeResults.matches.length === 0 ? <div className="forge-empty">No code matches.</div> : codeResults.matches.map((match, index) => <button className="forge-search-result forge-code-match" key={`${match.path}-${match.line}-${index}`} onClick={() => openFile(match.path)}><span><strong>{match.path}:{match.line}</strong><code>{match.text}</code></span></button>)}{codeResults.truncated ? <div className="forge-search-note">Search hit its deterministic scan budget. Narrow the query to continue.</div> : null}</div> : null}
        </div>
      ) : null}

      {clone ? (
        <div className="forge-clone">
          <strong>Clone this repository</strong>
          {meta.artifact?.remote ? <div className="forge-secret">{meta.artifact.remote} <Button leadingVisual={CopyIcon} onClick={() => void navigator.clipboard.writeText(meta.artifact?.remote ?? '')}>Copy</Button></div> : null}
          <div className="forge-muted" style={{ marginTop: 10 }}>Username: <code>x</code>. One-hour read token:</div>
          <div className="forge-secret">{clone.plaintext} <Button leadingVisual={CopyIcon} onClick={() => void navigator.clipboard.writeText(clone.plaintext)}>Copy</Button></div>
        </div>
      ) : null}

      {showCommits ? (
        <div className="forge-card">
          <div className="forge-list-head"><strong>Commit history</strong><span className="forge-muted">{ref}</span></div>
          {commits === null ? <div className="forge-loading"><Spinner /></div> : commits.length === 0 ? <div className="forge-empty">No commits on this ref.</div> : commits.map((commit) => <div className="forge-commit-row" key={commit.hash}><div><div className="forge-list-title">{commit.message?.split('\n')[0] || '(no message)'}</div><div className="forge-list-meta">{commit.author?.name || 'unknown author'}</div></div><span className="forge-sha">{commit.hash.slice(0, 10)}</span></div>)}
        </div>
      ) : path ? (
        <>
          <div className="forge-file-header">
            <div><Button onClick={() => openFile('')}>Repository</Button> <span className="forge-muted">/ {path}</span></div>
            {lastCommit ? <div className="forge-file-last-commit"><GitCommitIcon /> <span>{lastCommit.message?.split('\n')[0]}</span><span className="forge-sha">{lastCommit.hash.slice(0, 10)}</span></div> : null}
          </div>
          <div className="forge-card forge-file-code">{file ? <CodeView name={path.split('/').at(-1) || path} contents={file.text} options={{ themeType: 'system' }} /> : <div className="forge-loading"><Spinner /></div>}</div>
        </>
      ) : (
        <>
          {latest ? <div className="forge-latest-commit"><div><strong>{latest.author?.name || 'unknown author'}</strong> <span className="forge-muted">{latest.message?.split('\n')[0]}</span></div><span className="forge-sha">{latest.hash.slice(0, 10)}</span></div> : null}
          <div className="forge-viewer forge-artifacts-viewer">
            <ArtifactRepoViewer
              client={artifactsClient}
              repoName={meta.artifact_name}
              gitRef={ref}
              colorMode="system"
              onSelect={(selection) => {
                if (selection.path && selection.type !== 'tree' && selection.type !== 'gitlink') {
                  setLastCommit(null);
                  void execute<LastCommit | null>('file.last_commit', { owner, repo, ref, path: selection.path }).then(setLastCommit).catch(() => setLastCommit(null));
                }
              }}
              buildHref={(selection) => selection.path && selection.type !== 'tree' && selection.type !== 'gitlink'
                ? `?${new URLSearchParams({ ...(ref === meta.default_branch ? {} : { ref }), path: selection.path }).toString()}`
                : '#'}
            />
          </div>
          {readme ? <div className="forge-card forge-readme"><div className="forge-list-head"><strong>{readme.path}</strong><span className="forge-muted"><TagIcon /> rendered from {ref}</span></div><Markdown source={readme.content} /></div> : null}
        </>
      )}
    </section>
  );
}
