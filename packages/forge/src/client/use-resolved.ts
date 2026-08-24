import { api, type Resolved } from "./api";
import { useData } from "./data";

export function useResolved<T>(repo: string, rest: string, fetcher: (resolved: Resolved) => Promise<T>): { r: Resolved; data: T } {
  const resolved = useData(`resolve:${repo}:${rest}`, () => api.resolve(repo, rest));
  const data = useData(`sha:${repo}:${resolved.sha}:${resolved.path}:${resolved.kind}`, () => fetcher(resolved), Infinity);
  return { r: resolved, data };
}
