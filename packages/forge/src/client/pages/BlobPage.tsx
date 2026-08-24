import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { File } from "@pierre/diffs/react";
import { api, client } from "../api";
import { useResolved } from "../use-resolved";
import { useRepo } from "./RepoLayout";
import { Box } from "../components/Layout";
import { fmtSize } from "../format";
import { RefBar } from "../components/RefBar";
import { Markdown } from "../components/Markdown";
export function BlobPage() { const { full } = useRepo(); const rest = useParams()["*"] ?? ""; const { r, data: blob } = useResolved(full, rest, (resolved) => api.blob(full, resolved.sha, resolved.path)); const isMd = /\.(md|markdown)$/i.test(rest); const [mode, setMode] = useState<"preview" | "code">("preview"); const lines = blob.contents ? blob.contents.split("\n").length - (blob.contents.endsWith("\n") ? 1 : 0) : 0; const rawURL = client.repo(full).urls.raw(blob.ref, blob.path); return <><RefBar refname={r.ref} refKind={r.kind} path={r.path} page="blob" /><Box className="blob" title={<div className="blob-head">{isMd && blob.contents !== undefined && <span className="seg"><button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button><button className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>Code</button></span>}<span className="muted small">{blob.contents !== undefined && `${lines} lines · `}{fmtSize(blob.size)}</span><span className="spacer" /><a className="btn small" href={rawURL} target="_blank" rel="noreferrer">Raw</a><Link className="btn small" to={`/${full}/commits/${r.ref}/${r.path}`}>History</Link></div>}>{blob.too_large && <div className="pad muted">File is too large to display.</div>}{blob.binary && <div className="pad muted">Binary file not shown.</div>}{blob.contents !== undefined && (isMd && mode === "preview" ? <div className="pad"><Markdown source={blob.contents} /></div> : <File file={{ name: blob.name, contents: blob.contents.replace(/\n$/, "") }} options={{ disableFileHeader: true, themeType: "light", overflow: "scroll" }} />)}</Box></>; }
