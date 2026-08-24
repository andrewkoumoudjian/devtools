import type { ForgeEnv } from './env';
import { capabilityRegistry as coreRegistry } from './capabilities';
import { featureCapabilities } from './feature-capabilities';
import { artifactNativeCapabilities } from './artifact-native-capabilities';
import { buildRepoContext, type ContextTarget } from './context';
import { getRepoRecord } from './db';

export type ForgeCapabilityContext = { env: ForgeEnv };

const featureList = [...featureCapabilities, ...artifactNativeCapabilities];
const features = new Map(featureList.map((capability) => [capability.name, capability]));
const aliases: Record<string, string> = {
  'issue.create': 'issue.create.enriched',
  'pull.create': 'pull.create.enriched',
};
const hiddenFeatures = new Set(Object.values(aliases));

function canonicalName(name: string): string {
  return aliases[name] ?? name;
}

function repoCoordinates(name: string, rawInput: unknown): { owner: string; repo: string; ref?: string; target?: ContextTarget } | null {
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const input = rawInput as Record<string, unknown>;
  if (typeof input.owner !== 'string' || typeof input.repo !== 'string') return null;

  let target: ContextTarget | undefined;
  if (typeof input.pullNumber === 'number') target = { kind: 'pull', number: input.pullNumber };
  else if (typeof input.issueNumber === 'number') target = { kind: 'issue', number: input.issueNumber };
  else if (typeof input.number === 'number' && name.startsWith('pull.')) target = { kind: 'pull', number: input.number };
  else if (typeof input.number === 'number' && name.startsWith('issue.')) target = { kind: 'issue', number: input.number };

  return {
    owner: input.owner,
    repo: input.repo,
    ref: typeof input.ref === 'string' ? input.ref : undefined,
    target,
  };
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
  const extra = Array.from(features.values())
    .filter((capability) => !hiddenFeatures.has(capability.name) && !coreNames.has(capability.name))
    .map((capability) => summary(capability));
  return [...core, ...extra];
}

export const forgeRegistry = {
  list() {
    return allSummaries().sort((a, b) => a.name.localeCompare(b.name));
  },

  search(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return allSummaries()
      .map((item) => ({
        ...item,
        score: terms.reduce(
          (score, term) => score + (item.name.toLowerCase().includes(term) ? 4 : 0) + (item.description.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  },

  describe(name: string) {
    const resolved = canonicalName(name);
    const feature = features.get(resolved) ?? features.get(name);
    if (feature) {
      return { name, description: feature.description, mutates: feature.mutates, inputSchema: feature.inputSchema };
    }
    return coreRegistry.describe(name);
  },

  async execute(ctx: ForgeCapabilityContext, name: string, rawInput: unknown) {
    const resolved = canonicalName(name);
    const feature = features.get(resolved) ?? features.get(name);
    if (feature) {
      const input = feature.parse(rawInput);
      return feature.execute(ctx, input as never);
    }
    return coreRegistry.execute(ctx, name, rawInput);
  },

  async executeForAgent(ctx: ForgeCapabilityContext, name: string, rawInput: unknown) {
    const result = await this.execute(ctx, name, rawInput);
    if (name.startsWith('context.')) return { result, context: result };

    const coordinates = repoCoordinates(name, rawInput);
    if (!coordinates) return { result };

    try {
      const repo = await getRepoRecord(ctx.env, coordinates.owner, coordinates.repo);
      const context = await buildRepoContext(ctx.env, repo, {
        ref: coordinates.ref,
        target: coordinates.target,
        agentName: 'remote-agent',
      });
      return { result, context };
    } catch (error) {
      return {
        result,
        contextError: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
