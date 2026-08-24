import type { GitRefs as ForgeGitRefs, RepoRecord } from "./model";

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function execute<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/api/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, input }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status);
  return payload.result as T;
}

export function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function repoPath(owner: string, repo: string, suffix = "") {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export function withRef(path: string, ref: string) {
  const url = new URL(path, location.origin);
  if (ref) url.searchParams.set("ref", ref);
  return `${url.pathname}${url.search}`;
}

const coords = (full: string) => {
  const [owner = "", repo = ""] = full.split("/", 2);
  if (!owner || !repo) throw new ApiError(`invalid repository: ${full}`);
  return { owner, repo };
};

export type RefInfo = { name: string; sha: string };
export type Refs = { head: RefInfo | null; branches: RefInfo[]; tags: RefInfo[] };
export type Resolved = { ref: string; sha: string; kind: "branch" | "tag" | "commit"; path: string };
export type CommitTrailer = { key: string; value: string };
export type Commit = {
  sha: string;
  tree: string;
  subject: string;
  body: string;
  author: string;
  author_date: string;
  committer: string;
  commit_date: string;
  parents: string[];
  trailers?: CommitTrailer[];
};
export type TreeEntry = { name: string; type: "tree" | "blob" | "commit"; sha: string; size: number };
export type Tree = { ref: string; path: string; entries: TreeEntry[]; commit?: Commit; readme?: { name: string; contents: string } };
export type Blob = { ref: string; path: string; name: string; size: number; contents?: string; binary?: boolean; too_large?: boolean };
export type FileStat = { path: string; additions: number; deletions: number };
export type CommitDetail = { commit: Commit; stats: FileStat[]; patch: string };

type NativeCommit = {
  hash: string;
  treeHash: string;
  message: string;
  author?: { name?: string; email?: string };
  committer?: { name?: string; email?: string };
  parents?: string[];
  authoredAt?: number;
  committedAt?: number;
};
type NativeTreeEntry = { name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" | "gitlink" | "exec" };
type NativeDiff = {
  changes: Array<{ path: string; binary: boolean; truncated: boolean; patch: string | null }>;
};

const iso = (value?: number) => new Date(value && value < 1_000_000_000_000 ? value * 1000 : value ?? 0).toISOString();
function parseTrailers(message: string): CommitTrailer[] {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const trailers: CommitTrailer[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      if (trailers.length) break;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(line);
    if (!match) {
      if (trailers.length) break;
      continue;
    }
    trailers.unshift({ key: match[1]!, value: match[2]! });
  }
  return trailers;
}
function mapCommit(commit: NativeCommit): Commit {
  const normalized = (commit.message ?? "").replace(/\r\n/g, "\n");
  const [subject = "(no message)", ...rest] = normalized.split("\n");
  const author = commit.author?.name || commit.author?.email || "unknown author";
  const committer = commit.committer?.name || commit.committer?.email || author;
  return {
    sha: commit.hash,
    tree: commit.treeHash,
    subject,
    body: rest.join("\n").replace(/^\n+/, ""),
    author,
    author_date: iso(commit.authoredAt ?? commit.committedAt),
    committer,
    commit_date: iso(commit.committedAt ?? commit.authoredAt),
    parents: commit.parents ?? [],
    trailers: parseTrailers(normalized),
  };
}

async function rawRefs(full: string) {
  const repository = await api.repo(full);
  const refs = await execute<ForgeGitRefs>("git.refs", coords(full)).catch(() => ({ head: null, headHash: null, branches: [], tags: [], other: [] }));
  const branches = refs.branches.map((item) => ({ name: item.name, sha: item.hash })).sort((a, b) => a.name.localeCompare(b.name));
  const tags = refs.tags.map((item) => ({ name: item.name, sha: item.hash })).sort((a, b) => a.name.localeCompare(b.name));
  const advertised = refs.head?.replace(/^refs\/heads\//, "") ?? repository.default_branch;
  const headSha = branches.find((item) => item.name === advertised)?.sha ?? refs.headHash ?? null;
  return { head: headSha ? { name: advertised, sha: headSha } : null, branches, tags } satisfies Refs;
}

async function nativeCommit(full: string, sha: string) {
  return execute<NativeCommit>("git.commit.get", { ...coords(full), hash: sha });
}

async function treeEntries(full: string, hash: string) {
  return execute<NativeTreeEntry[]>("git.tree", { ...coords(full), hash });
}

export const api = {
  owners: async () => {
    const repos = await execute<RepoRecord[]>("repo.list");
    return [...new Set(repos.map((repo) => repo.owner))].sort();
  },
  repos: async (owner: string) => (await execute<RepoRecord[]>("repo.list")).filter((repo) => repo.owner === owner).sort((a, b) => a.name.localeCompare(b.name)),
  repo: (full: string) => execute<RepoRecord>("repo.get", coords(full)),
  refs: rawRefs,
  resolve: async (full: string, rest: string): Promise<Resolved> => {
    const refs = await rawRefs(full);
    const decoded = rest.replace(/^\/+|\/+$/g, "");
    if (!decoded) {
      if (!refs.head) throw new ApiError("repository has no commits", 404);
      return { ref: refs.head.name, sha: refs.head.sha, kind: "branch", path: "" };
    }
    if (/^[0-9a-f]{40}$/i.test(decoded)) return { ref: decoded, sha: decoded, kind: "commit", path: "" };
    const candidates = [
      ...refs.branches.map((ref) => ({ ...ref, kind: "branch" as const })),
      ...refs.tags.map((ref) => ({ ...ref, kind: "tag" as const })),
    ].sort((a, b) => b.name.length - a.name.length);
    const found = candidates.find((candidate) => decoded === candidate.name || decoded.startsWith(`${candidate.name}/`));
    if (found) return { ref: found.name, sha: found.sha, kind: found.kind, path: decoded === found.name ? "" : decoded.slice(found.name.length + 1) };
    const [first = "", ...path] = decoded.split("/");
    if (/^[0-9a-f]{40}$/i.test(first)) return { ref: first, sha: first, kind: "commit", path: path.join("/") };
    throw new ApiError(`unknown Git ref in ${decoded}`, 404);
  },
  tree: async (full: string, sha: string, path: string): Promise<Tree> => {
    const commit = await nativeCommit(full, sha);
    let treeHash = commit.treeHash;
    if (path) {
      for (const segment of path.split("/").filter(Boolean)) {
        const entries = await treeEntries(full, treeHash);
        const entry = entries.find((candidate) => candidate.name === segment);
        if (!entry || entry.type !== "tree") throw new ApiError(`tree path not found: ${path}`, 404);
        treeHash = entry.hash;
      }
    }
    const entries = await treeEntries(full, treeHash);
    const mapped = entries.map<TreeEntry>((entry) => ({
      name: entry.name,
      type: entry.type === "tree" ? "tree" : entry.type === "gitlink" ? "commit" : "blob",
      sha: entry.hash,
      size: -1,
    }));
    const last = path
      ? await execute<NativeCommit | null>("file.last_commit", { ...coords(full), ref: sha, path, maxCommits: 100 }).catch(() => null)
      : commit;
    const readmeEntry = entries.find((entry) => entry.type !== "tree" && /^readme(?:\.[^/]*)?$/i.test(entry.name));
    let readme: Tree["readme"];
    if (readmeEntry) {
      const readmePath = path ? `${path}/${readmeEntry.name}` : readmeEntry.name;
      const file = await execute<{ text: string }>("fs.read", { ...coords(full), ref: sha, path: readmePath, maxBytes: 1_000_000 }).catch(() => null);
      if (file) readme = { name: readmeEntry.name, contents: file.text };
    }
    return { ref: sha, path, entries: mapped, commit: last ? mapCommit(last) : undefined, readme };
  },
  blob: async (full: string, sha: string, path: string): Promise<Blob> => {
    try {
      const file = await execute<{ path: string; ref: string; size: number; text: string }>("fs.read", { ...coords(full), ref: sha, path, maxBytes: 2_000_000 });
      const binary = file.text.includes("\u0000");
      return { ref: sha, path, name: path.split("/").at(-1) ?? path, size: file.size, contents: binary ? undefined : file.text, binary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("maxBytes")) return { ref: sha, path, name: path.split("/").at(-1) ?? path, size: 0, too_large: true };
      throw error;
    }
  },
  commits: async (full: string, sha: string, path: string, skip: number) => {
    const page = await execute<{ commits: NativeCommit[]; more: boolean }>("git.history", { ...coords(full), ref: sha, path, offset: skip, limit: 50 });
    return { commits: page.commits.map(mapCommit), more: page.more };
  },
  commit: async (full: string, sha: string): Promise<CommitDetail> => {
    const commit = await nativeCommit(full, sha);
    const mapped = mapCommit(commit);
    if (!mapped.parents.length) return { commit: mapped, stats: [], patch: "" };
    const diff = await execute<NativeDiff>("git.diff", { ...coords(full), base: mapped.parents[0], head: sha, maxFiles: 500, maxTextBytes: 1_000_000 });
    const stats = diff.changes.map((change) => {
      if (change.binary) return { path: change.path, additions: -1, deletions: -1 };
      const lines = change.patch?.split("\n") ?? [];
      return {
        path: change.path,
        additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      };
    });
    const patch = diff.changes.flatMap((change) => change.patch ? [`diff --git a/${change.path} b/${change.path}\n${change.patch}`] : []).join("\n");
    return { commit: mapped, stats, patch };
  },
};

export function refListStream(
  full: string,
  kind: "branches" | "tags",
  query: { q?: string; prefix?: string; after?: string; n?: number },
  onRef: (ref: RefInfo) => void,
  signal?: AbortSignal,
): Promise<{ more: boolean }> {
  return rawRefs(full).then((refs) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const source = kind === "branches" ? refs.branches : refs.tags;
    const needle = query.q?.trim().toLowerCase() ?? "";
    const prefix = query.prefix ?? "";
    const filtered = source.filter((ref) => (!needle || ref.name.toLowerCase().includes(needle)) && (!prefix || ref.name.startsWith(prefix)));
    const start = query.after ? Math.max(0, filtered.findIndex((ref) => ref.name === query.after) + 1) : 0;
    const selected = filtered.slice(start, start + (query.n ?? 50));
    for (const ref of selected) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      onRef(ref);
    }
    return { more: start + selected.length < filtered.length };
  });
}

export const rawUrl = (full: string, sha: string, path: string) => {
  const { owner, repo } = coords(full);
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw?ref=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`;
};

export const client = {
  repo(full: string) {
    return { urls: { raw: (sha: string, path: string) => rawUrl(full, sha, path) } };
  },
};
