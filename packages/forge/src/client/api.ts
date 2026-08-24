export async function execute<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload.result as T;
}

export function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function repoPath(owner: string, repo: string, suffix = '') {
  return `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export function withRef(path: string, ref: string) {
  const url = new URL(path, location.origin);
  if (ref) url.searchParams.set('ref', ref);
  return `${url.pathname}${url.search}`;
}
