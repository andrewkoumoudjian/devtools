const SEGMENT = /^[A-Za-z0-9._-]+$/;
const SEP = '__';

export function assertForgeName(value: string, label: string): string {
  if (!value || !SEGMENT.test(value) || value.includes(SEP)) {
    throw new Error(`${label} must contain only letters, digits, '.', '_' or '-' and may not contain '${SEP}'`);
  }
  return value;
}

export function artifactRepoName(owner: string, repo: string): string {
  return `${assertForgeName(owner, 'owner')}${SEP}${assertForgeName(repo, 'repo')}`;
}

export function splitArtifactRepoName(stored: string): { owner: string; repo: string } | null {
  const i = stored.indexOf(SEP);
  if (i <= 0 || stored.indexOf(SEP, i + SEP.length) !== -1) return null;
  const owner = stored.slice(0, i);
  const repo = stored.slice(i + SEP.length);
  if (!owner || !repo) return null;
  return { owner, repo };
}
