import { Link } from "react-router-dom";
import type { CommitTrailer } from "../api";
const URL_RE = /https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g;
export function Linkified({ text }: { text: string }) {
  const parts: (string | { url: string })[] = []; let last = 0;
  for (const match of text.matchAll(URL_RE)) { const index = match.index ?? 0; if (index > last) parts.push(text.slice(last, index)); parts.push({ url: match[0] }); last = index + match[0].length; }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((part, index) => typeof part === "string" ? <span key={index}>{part}</span> : <a key={index} href={part.url} target="_blank" rel="noopener noreferrer">{part.url}</a>)}</>;
}
type Group = "Merge queue" | "People" | "Other";
function groupOf(key: string): Group { const value = key.toLowerCase(); if (["co-authored-by","assisted-by","signed-off-by","reviewed-by","acked-by","tested-by"].includes(value)) return "People"; if (value.startsWith("merge-queue-") || value.includes("ci-sha") || value.includes("ci-boundary")) return "Merge queue"; return "Other"; }
const SHA_RE = /^[0-9a-f]{40}$/; const MAIL_RE = /^(.*?)\s*<([^>]+@[^>]+)>\s*$/;
function TrailerValue({ repo, trailer }: { repo: string; trailer: CommitTrailer }) { const value = trailer.value.trim(); if (SHA_RE.test(value)) return <Link to={`/${repo}/commit/${value}`} className="sha">{value.slice(0, 12)}</Link>; const mail = value.match(MAIL_RE); if (mail) return <>{mail[1] && <span>{mail[1]} </span>}<a href={`mailto:${mail[2]}`}>&lt;{mail[2]}&gt;</a></>; return <Linkified text={value} />; }
export function Trailers({ repo, trailers, open }: { repo: string; trailers: CommitTrailer[]; open?: boolean }) {
  if (!trailers.length) return null; const groups: Group[] = ["Merge queue","People","Other"]; const grouped = new Map<Group, CommitTrailer[]>(); for (const trailer of trailers) { const group = groupOf(trailer.key); grouped.set(group, [...(grouped.get(group) ?? []), trailer]); }
  return <details className="trailers" open={open}><summary className="pill">{trailers.length} trailer{trailers.length === 1 ? "" : "s"}</summary><table className="grid trailers-table"><tbody>{groups.filter((group) => grouped.has(group)).map((group) => <FragmentRows key={group} group={group} trailers={grouped.get(group)!} repo={repo} />)}</tbody></table></details>;
}
function FragmentRows({ group, trailers, repo }: { group: Group; trailers: CommitTrailer[]; repo: string }) { return <><tr className="trailers-group"><th colSpan={2}>{group}</th></tr>{trailers.map((trailer, index) => <tr key={`${group}-${index}`}><td className="trailer-key">{trailer.key}</td><td className="trailer-value"><TrailerValue repo={repo} trailer={trailer} /></td></tr>)}</>; }
