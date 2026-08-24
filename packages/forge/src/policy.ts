import type { ForgeEnv } from './env';
import type { RepoRecord } from './db';
import { artifactText } from './artifacts';
import { getRepoSettings } from './product';

export type AgentAccessMode = 'read-only' | 'write-capable';
export type CodeownersRule = {
  pattern: string;
  owners: string[];
  teams: string[];
  unsupportedOwners: string[];
  unsupportedPattern: boolean;
};

const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
const ESCAPED = '\u0000';

export async function resolveAgentAccess(
  env: ForgeEnv,
  repo: RepoRecord,
  requested: AgentAccessMode | undefined,
): Promise<{ mode: AgentAccessMode; reason: string }> {
  const settings = await getRepoSettings(env, repo);
  if (requested === 'read-only') return { mode: 'read-only', reason: 'caller requested read-only access' };
  if (!settings.agent_write_enabled) return { mode: 'read-only', reason: 'repository agent writes are disabled' };
  return { mode: 'write-capable', reason: 'repository policy permits agent writes' };
}

function splitLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of line.trim()) {
    if (escaped) {
      current += `${ESCAPED}${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') { escaped = true; continue; }
    if (char === '#' && !current) break;
    if (/\s/.test(char)) {
      if (current) { fields.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (current) fields.push(current);
  return fields;
}

function unsupportedPattern(pattern: string) {
  if (pattern.startsWith('!') || pattern.startsWith(`${ESCAPED}#`)) return true;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === ESCAPED) { index += 1; continue; }
    if (pattern[index] === '[' || pattern[index] === ']') return true;
  }
  return false;
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const line of content.split('\n')) {
    const fields = splitLine(line);
    if (!fields.length) continue;
    const owners: string[] = [];
    const teams: string[] = [];
    const unsupportedOwners: string[] = [];
    for (const owner of fields.slice(1)) {
      if (/^@[\w-]+(?:\/[\w-]+)?$/.test(owner)) {
        if (owner.includes('/')) teams.push(owner.slice(1).toLowerCase());
        else owners.push(owner.slice(1).toLowerCase());
      } else unsupportedOwners.push(owner);
    }
    rules.push({ pattern: fields[0]!, owners, teams, unsupportedOwners, unsupportedPattern: unsupportedPattern(fields[0]!) });
  }
  return rules;
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}

function literalDirectoryChars(segment: string) {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] === ESCAPED) { index += 1; continue; }
    if (segment[index] !== '*' && segment[index] !== '?') return true;
  }
  return false;
}

export function codeownersPatternRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.startsWith('!')) return null;
  const anchored = pattern.startsWith('/');
  const directoryPattern = pattern.endsWith('/');
  let normalized = pattern.replace(/^\/+/, '');
  if (!normalized) return null;
  const slashless = !normalized.replace(/\/+$/, '').includes('/');
  if (directoryPattern) normalized += '**';
  const finalSegment = normalized.split('/').at(-1) || '';
  const descendantMatch = !directoryPattern && (!/[*?]/.test(finalSegment) || literalDirectoryChars(finalSegment));
  const anyParentPrefix = !anchored && (slashless || normalized.startsWith('**/'));

  let source = '';
  for (let index = 0; index < normalized.length;) {
    if (normalized[index] === ESCAPED) {
      const escapedChar = normalized[index + 1] || '';
      source += escapeRegex(escapedChar);
      index += escapedChar ? 2 : 1;
      continue;
    }
    if (normalized.startsWith('**/', index)) { source += '(?:.*/)?'; index += 3; continue; }
    if (normalized.startsWith('**', index) && index + 2 === normalized.length && normalized[index - 1] === '/') { source += '.*'; index += 2; continue; }
    const char = normalized[index]!;
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
    index += 1;
  }

  source = anyParentPrefix ? `(?:^|.*/)${source}` : `^${source}`;
  if (descendantMatch) source += '(?:/.*)?';
  return new RegExp(`${source}$`);
}

export function matchingCodeownersRule(rules: CodeownersRule[], path: string) {
  let matched: CodeownersRule | null = null;
  for (const rule of rules) {
    const regex = codeownersPatternRegex(rule.pattern);
    if (regex?.test(path)) matched = rule;
  }
  return matched;
}

export function evaluateCodeowners(
  rules: CodeownersRule[],
  paths: string[],
  actor: string,
  actorTeams: string[] = [],
) {
  const actorName = actor.replace(/^@/, '').toLowerCase();
  const teams = new Set(actorTeams.map((team) => team.replace(/^@/, '').toLowerCase()));
  const evaluations = paths.map((path) => {
    const rule = matchingCodeownersRule(rules, path);
    if (!rule) return { path, allowed: false, reason: 'no CODEOWNERS rule matched', rule: null };
    if (rule.unsupportedPattern || rule.unsupportedOwners.length) return { path, allowed: false, reason: 'CODEOWNERS rule uses unsupported syntax', rule };
    if (!rule.owners.length && !rule.teams.length) return { path, allowed: false, reason: 'ownerless CODEOWNERS rule requires explicit repository write authorization', rule };
    const allowed = rule.owners.includes(actorName) || rule.teams.some((team) => teams.has(team));
    return { path, allowed, reason: allowed ? 'actor matches CODEOWNERS' : 'actor is not a matching CODEOWNER', rule };
  });
  return { allowed: evaluations.every((item) => item.allowed), evaluations };
}

export async function loadCodeowners(env: ForgeEnv, repo: RepoRecord, ref: string) {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const content = await artifactText(env, repo.artifact_name, ref, path, 256_000);
      return { path, rules: parseCodeowners(content) };
    } catch {
      // Try the next canonical location.
    }
  }
  return null;
}
