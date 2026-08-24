import type { ForgeEnv } from './env';
import { capabilityRegistry as coreRegistry } from './capabilities';
import { featureCapabilities } from './feature-capabilities';
import { artifactNativeCapabilities } from './artifact-native-capabilities';
import { uiGitCapabilities } from './ui-git-capabilities';
import { memoryCapabilities } from './memory-capabilities';
import { policyCapabilities } from './policy-capabilities';
import { workspaceCapabilities } from './workspace-capabilities';
import { workspaceProcessCapabilities } from './workspace-process-capabilities';
import type { ContextTarget } from './context';
import { agentContextEnvelope, type AgentContextRequest } from './agent-context';
import { getRepoRecord } from './db';

export type ForgeCapabilityContext = { env: ForgeEnv };
export type ForgeBatchItem = { name: string; input?: unknown };

const featureList = [
  ...featureCapabilities,
  ...artifactNativeCapabilities,
  ...uiGitCapabilities,
  ...memoryCapabilities,
  ...policyCapabilities,
  ...workspaceCapabilities,
  ...workspaceProcessCapabilities,
];
const features = new Map(featureList.map((capability) => [capability.name, capability]));
const aliases: Record<string, string> = {
  'issue.create': 'issue.create.enriched',
  'pull.create': 'pull.create.enriched',
};
const hiddenFeatures = new Set(Object.values(aliases));

function canonicalName(name: string): string { return aliases[name] ?? name; }

type RepoCoordinates = {
  owner: string;
  repo: string;
  ref?: string;
  target?: ContextTarget;
  path?: string;
  accessMode?: 'read-only' | 'write-capable';
};

function repoCoordinates(name: string, rawInput: unknown): RepoCoordinates | null {
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const input = rawInput as Record<string, unknown>;
  if (typeof input.owner !== 'string' || typeof input.repo !== 'string') return null;
  let target: ContextTarget | undefined;
  if (typeof input.pullNumber === 'number') target = { kind: 'pull', number: input.pullNumber };
  else if (typeof input.issueNumber === 'number') target = { kind: 'issue', number: input.issueNumber };
  else if (typeof input.number === 'number' && name.startsWith('pull.')) target = { kind: 'pull', number: input.number };
  else if (typeof input.number === 'number' && name.startsWith('issue.')) target = { kind: 'issue', number: input.number };
  else if ((input.targetKind === 'issue' || input.targetKind === 'pull') && typeof input.targetNumber === 'number') target = { kind: input.targetKind, number: input.targetNumber };
  return {
    owner: input.owner,
    repo: input.repo,
    ref: typeof input.ref === 'string' ? input.ref : typeof input.branch === 'string' ? input.branch : undefined,
    target,
    path: typeof input.path === 'string' ? input.path : undefined,
    accessMode: input.accessMode === 'read-only' || input.accessMode === 'write-capable' ? input.accessMode : undefined,
  };
}

function memoryQueryFrom(name: string, rawInput: unknown) {
  if (name.startsWith('memory.')) return undefined;
  if (typeof rawInput !== 'object' || rawInput === null) return name;
  const input = rawInput as Record<string, unknown>;
  const values = [name, input.path, input.query, input.command, input.message, input.ref, input.branch]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return values.join(' ').slice(0, 1_200);
}

function coordinatesFromContext(base: RepoCoordinates, context: unknown): RepoCoordinates {
  if (typeof context !== 'object' || context === null) return base;
  const authority = (context as { authority?: unknown }).authority;
  if (typeof authority !== 'object' || authority === null) return base;
  const value = authority as Record<string, unknown>;
  const targetValue = value.target;
  const target = typeof targetValue === 'object' && targetValue !== null
    && (((targetValue as Record<string, unknown>).kind === 'issue') || ((targetValue as Record<string, unknown>).kind === 'pull'))
    && typeof (targetValue as Record<string, unknown>).number === 'number'
    ? targetValue as ContextTarget
    : base.target;
  const access = value.agentAccess ?? value.workingTree;
  return { ...base, ref: typeof value.ref === 'string' ? value.ref : base.ref, target, accessMode: access === 'read-only' || access === 'write-capable' ? access : base.accessMode };
}

function summary(capability: { name: string; description: string; mutates: boolean }, displayName = capability.name) {
  return { name: displayName, description: capability.description, mutates: capability.mutates };
}
function allSummaries() {
  const core = coreRegistry.list().map((entry) => {
    const replacement = aliases[entry.name] ? features.get(aliases[entry.name]!) : features.get(entry.name);
    return replacement ? summary(replacement, entry.name) : entry;
  });
  const coreNames = new Set(core.map((entry) => entry.name));
  const extra = Array.from(features.values()).filter((capability) => !hiddenFeatures.has(capability.name) && !coreNames.has(capability.name)).map((capability) => summary(capability));
  return [...core, ...extra];
}
function contextFromResult(result: unknown) { if (typeof result !== 'object' || result === null || !('context' in result)) return undefined; return (result as { context?: unknown }).context; }
function withoutEmbeddedContext(result: unknown) { if (typeof result !== 'object' || result === null || Array.isArray(result) || !('context' in result)) return result; const { context: _context, ...rest } = result as Record<string, unknown>; return rest; }
function capabilityDescription(name: string) {
  const resolved = canonicalName(name);
  const feature = features.get(resolved) ?? features.get(name);
  if (feature) return { name, description: feature.description, mutates: feature.mutates, inputSchema: feature.inputSchema };
  return coreRegistry.describe(name);
}

export const forgeRegistry = {
  list() { return allSummaries().sort((a, b) => a.name.localeCompare(b.name)); },
  search(query: string, includeSchemas = true) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return allSummaries().map((item) => ({ ...item, score: terms.reduce((score, term) => score + (item.name.toLowerCase().includes(term) ? 4 : 0) + (item.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((item) => includeSchemas ? { ...item, inputSchema: capabilityDescription(item.name).inputSchema } : item);
  },
  describe(name: string) { return capabilityDescription(name); },
  async execute(ctx: ForgeCapabilityContext, name: string, rawInput: unknown) {
    const resolved = canonicalName(name);
    const feature = features.get(resolved) ?? features.get(name);
    if (feature) { const input = feature.parse(rawInput); return feature.execute(ctx, input as never); }
    return coreRegistry.execute(ctx, name, rawInput);
  },
  async executeForAgent(ctx: ForgeCapabilityContext, name: string, rawInput: unknown, contextRequest: AgentContextRequest = {}) {
    const result = await this.execute(ctx, name, rawInput);
    if (name.startsWith('context.')) return { result };
    const base = repoCoordinates(name, rawInput);
    if (!base) return { result };
    const embeddedContext = contextFromResult(result);
    const coordinates = embeddedContext === undefined ? base : coordinatesFromContext(base, embeddedContext);
    const cleanResult = embeddedContext === undefined ? result : withoutEmbeddedContext(result);
    if ((contextRequest.mode ?? 'minimal') === 'none') return { result: cleanResult };
    try {
      const repo = await getRepoRecord(ctx.env, coordinates.owner, coordinates.repo);
      const context = await agentContextEnvelope(ctx.env, repo, {
        ref: coordinates.ref, target: coordinates.target, path: coordinates.path, memoryQuery: memoryQueryFrom(name, rawInput), agentName: 'remote-agent', accessMode: coordinates.accessMode,
      }, contextRequest);
      return context === undefined ? { result: cleanResult } : { result: cleanResult, context };
    } catch (error) {
      return { result: cleanResult, contextError: error instanceof Error ? error.message : String(error) };
    }
  },
  async executeBatchForAgent(ctx: ForgeCapabilityContext, items: ForgeBatchItem[], contextRequest: AgentContextRequest = { mode: 'none' }) {
    const results: unknown[] = new Array(items.length);
    let index = 0;
    while (index < items.length) {
      const item = items[index]!;
      const mutates = Boolean(capabilityDescription(item.name).mutates);
      if (mutates) { results[index] = await this.executeForAgent(ctx, item.name, item.input ?? {}, contextRequest); index += 1; continue; }
      const start = index;
      while (index < items.length && !capabilityDescription(items[index]!.name).mutates) index += 1;
      const group = items.slice(start, index);
      const resolved = await Promise.all(group.map((entry) => this.executeForAgent(ctx, entry.name, entry.input ?? {}, contextRequest)));
      for (let offset = 0; offset < resolved.length; offset += 1) results[start + offset] = resolved[offset];
    }
    return { results };
  },
};
