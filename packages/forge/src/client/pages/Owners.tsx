import { useState } from "react";
import { Link } from "react-router-dom";
import { api, execute } from "../api";
import { invalidate, useData } from "../data";
import { Box } from "../components/Layout";
import { Hero } from "../components/Hero";
import { CodeSample } from "../components/CopyButton";
import type { RepoRecord } from "../model";

type Created = { repository: RepoRecord; remote: string; initialToken: unknown };
export function Owners() {
  const owners = useData("owners", api.owners);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function createRepository(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setError(null);
    try {
      const result = await execute<Created>("repo.create", { owner: String(data.get("owner") ?? ""), repo: String(data.get("repo") ?? ""), description: String(data.get("description") ?? ""), visibility: String(data.get("visibility") ?? "private") });
      setCreated(result); invalidate("owners");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <><Hero /><div className="row gap" style={{ marginBottom: 16 }}><h2 className="page-title" style={{ marginBottom: 0 }}>Repositories by owner</h2><span className="spacer" /><button className="btn btn-primary" onClick={() => { setShowCreate((value) => !value); setCreated(null); }}>New repository</button></div>{showCreate && <Box title="Create a new repository"><form className="forge-form" onSubmit={createRepository}><div className="forge-two-column"><label className="forge-field">Owner<input name="owner" className="forge-input" required /></label><label className="forge-field">Repository name<input name="repo" className="forge-input" required /></label></div><label className="forge-field">Description<textarea name="description" className="forge-textarea" /></label><label className="forge-field">Visibility<select name="visibility" className="forge-select"><option value="private">Private</option><option value="public">Public</option></select></label>{error && <div className="flash error">{error}</div>}{created && <div><p><strong>Repository created.</strong> The initial Git token is shown once.</p><CodeSample code={`${created.remote}\n${typeof created.initialToken === "string" ? created.initialToken : JSON.stringify(created.initialToken)}`} /></div>}<div className="forge-form-actions"><button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create repository</button></div></form></Box>}<Box>{owners.length === 0 ? <div className="pad muted">Nothing here yet. Create or import a repository to begin.</div> : <ul className="list">{owners.map((owner) => <li key={owner}><Link to={`/${owner}`} className="strong">{owner}</Link></li>)}</ul>}</Box></>;
}
