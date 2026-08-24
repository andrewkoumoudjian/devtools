import { useState } from "react";
import { Link } from "react-router-dom";
import { execute } from "../api";
import { invalidate, useData } from "../data";
import { Box } from "../components/Layout";
import { CodeSample } from "../components/CopyButton";
import type { RepoRecord } from "../model";

type Created = { repository: RepoRecord; remote: string; initialToken: unknown };

async function listRepositories() {
  const repos = await execute<RepoRecord[]>("repo.list");
  return repos.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
}

export function Owners() {
  const repos = useData("repositories", listRepositories);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createRepository(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    try {
      const result = await execute<Created>("repo.create", {
        owner: String(data.get("owner") ?? ""),
        repo: String(data.get("repo") ?? ""),
        description: String(data.get("description") ?? ""),
        visibility: String(data.get("visibility") ?? "private"),
      });
      setCreated(result);
      invalidate("repositories");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <>
    <div className="repo-index-head">
      <div>
        <h1 className="page-title">Repositories</h1>
        <p className="repo-index-subtitle">Git repositories backed by Cloudflare Artifacts.</p>
      </div>
      <button className="btn btn-primary" onClick={() => { setShowCreate((value) => !value); setCreated(null); }}>
        + New repository
      </button>
    </div>

    {showCreate && <Box title="Create a new repository">
      <form className="forge-form" onSubmit={createRepository}>
        <div className="forge-two-column">
          <label className="forge-field">Owner<input name="owner" className="forge-input" required /></label>
          <label className="forge-field">Repository name<input name="repo" className="forge-input" required /></label>
        </div>
        <label className="forge-field">Description<textarea name="description" className="forge-textarea" /></label>
        <label className="forge-field">Visibility<select name="visibility" className="forge-select"><option value="private">Private</option><option value="public">Public</option></select></label>
        {error && <div className="flash error">{error}</div>}
        {created && <div><p><strong>Repository created.</strong> The initial Git token is shown once.</p><CodeSample code={`${created.remote}\n${typeof created.initialToken === "string" ? created.initialToken : JSON.stringify(created.initialToken)}`} /></div>}
        <div className="forge-form-actions"><button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create repository</button></div>
      </form>
    </Box>}

    <Box className="repo-index-box">
      {repos.length === 0 ? <div className="pad muted">No repositories yet.</div> : <ul className="list repo-index-list">
        {repos.map((repo) => <li key={repo.id} className="repo-index-row">
          <div className="repo-index-main">
            <Link to={`/${repo.owner}/${repo.name}`} className="repo-index-name">{repo.owner} / {repo.name}</Link>
            <div className="repo-index-meta">{repo.description || "No description"} <span aria-hidden>·</span> {repo.default_branch}</div>
          </div>
          <span className="pill">{repo.visibility}</span>
        </li>)}
      </ul>}
    </Box>
  </>;
}
