import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useData } from "../data";
import { Box } from "../components/Layout";
export function Repos() { const { owner = "" } = useParams(); const repos = useData(`repos:${owner}`, () => api.repos(owner)); return <><h1 className="page-title"><Link to="/">Repositories</Link> <span className="muted">/</span> {owner}</h1><Box>{repos.length === 0 && <div className="muted pad">No repositories under <code>{owner}</code>.</div>}<ul className="list">{repos.map((repo) => <li key={repo.id}><Link to={`/${owner}/${repo.name}`} className="strong">{owner}/{repo.name}</Link><div className="muted small">{repo.description || "No description"} · {repo.default_branch} · {repo.visibility}</div></li>)}</ul></Box></>; }
