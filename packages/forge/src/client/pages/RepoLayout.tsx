import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { api, execute } from "../api";
import type { Refs } from "../api";
import type { RepoRecord } from "../model";
import { useData } from "../data";
import { RouteBoundary, Skeleton } from "../components/Loading";
import { CodeSample, CopyButton } from "../components/CopyButton";
import "../clone.css";

function CloneMenu({ full, meta }: { full: string; meta: RepoRecord }) {
  const [open, setOpen] = useState(false); const [token, setToken] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const onDoc = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); }; document.addEventListener("mousedown", onDoc); return () => document.removeEventListener("mousedown", onDoc); }, [open]);
  const remote = meta.artifact?.remote ?? "";
  async function mint() { try { setError(null); const result = await execute<{ plaintext: string }>("repo.token.create", { owner: meta.owner, repo: meta.name, scope: "read", ttl: 3600 }); setToken(result.plaintext); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  return <div className="clone-menu" ref={ref}><button type="button" className="btn btn-primary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>Clone</button>{open && <div className="clone-pop"><Suspense fallback={<Skeleton title={false} rows={4} />}><div className="clone-setup"><div className="small strong">Artifacts remote</div>{remote ? <CodeSample code={remote} /> : <div className="muted small">Remote unavailable.</div>}<div className="clone-actions"><button className="btn btn-small" onClick={mint}>Generate 1-hour read token</button>{token && <CopyButton text={token} label="Copy token" />}</div>{token && <CodeSample code={`git clone ${remote}`} copy={`git clone ${remote}`} />}{error && <div className="flash error small">{error}</div>}<div className="muted small">Git username is <code>x</code>; use the generated token as the password.</div></div></Suspense></div>}</div>;
}

export interface RepoCtx { owner: string; name: string; full: string; refs: Refs; meta: RepoRecord }
const Ctx = createContext<RepoCtx | null>(null);
export function useRepo(): RepoCtx { const context = useContext(Ctx); if (!context) throw new Error("useRepo outside RepoLayout"); return context; }

export function RepoLayout() {
  const { owner = "", repo = "" } = useParams(); const full = `${owner}/${repo}`; const { pathname } = useLocation();
  const meta = useData(`repo:${full}`, () => api.repo(full));
  useEffect(() => { document.title = `${full} · Forge`; return () => { document.title = "Forge"; }; }, [full]);
  const active = (segment: string) => segment === "code" ? !/(\/commits?(\/|$)|\/issues(\/|$)|\/pulls(\/|$)|\/actions(\/|$)|\/releases(\/|$)|\/notifications(\/|$)|\/settings(\/|$))/.test(pathname) : pathname.includes(`/${segment}`);
  return <><div className="repo-head"><h1 className="repo-title"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="muted"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" /></svg><Link to={`/${owner}`}>{owner}</Link><span className="muted">/</span><Link to={`/${full}`} className="strong">{repo}</Link><span className="pill">{meta.visibility}</span></h1><CloneMenu full={full} meta={meta} /><nav className="tabs"><NavLink to={`/${full}`} className={() => active("code") ? "tab active" : "tab"} end>Code</NavLink><NavLink to={`/${full}/commits`} className={() => active("commits") ? "tab active" : "tab"}>Commits</NavLink><NavLink to={`/${full}/issues`} className={() => active("issues") ? "tab active" : "tab"}>Issues</NavLink><NavLink to={`/${full}/pulls`} className={() => active("pulls") ? "tab active" : "tab"}>Pull requests</NavLink><NavLink to={`/${full}/actions`} className={() => active("actions") ? "tab active" : "tab"}>Actions</NavLink><NavLink to={`/${full}/releases`} className={() => active("releases") ? "tab active" : "tab"}>Releases</NavLink><NavLink to={`/${full}/notifications`} className={() => active("notifications") ? "tab active" : "tab"}>Notifications</NavLink><NavLink to={`/${full}/settings`} className={() => active("settings") ? "tab active" : "tab"}>Settings</NavLink></nav></div><RouteBoundary fallback={<Skeleton title={false} rows={8} />}><RepoBody owner={owner} repo={repo} full={full} meta={meta} /></RouteBoundary></>;
}
function RepoBody({ owner, repo, full, meta }: { owner: string; repo: string; full: string; meta: RepoRecord }) { const refs = useData(`refs:${full}`, () => api.refs(full)); const context = useMemo(() => ({ owner, name: repo, full, refs, meta }), [owner, repo, full, refs, meta]); return <Ctx.Provider value={context}><Outlet /></Ctx.Provider>; }
