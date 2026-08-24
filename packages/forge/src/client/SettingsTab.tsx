import React, { useEffect, useState } from 'react';
import { Button, Heading, Spinner } from '@primer/react';
import { CpuIcon, GearIcon, PeopleIcon } from '@primer/octicons-react';
import type { RepoContext, RepoRecord, RepoSettings } from './model';
import { execute } from './api';

type SettingsResult = RepoSettings;

export function SettingsTab({ owner, repo, meta, onChanged }: { owner: string; repo: string; meta: RepoRecord; onChanged: () => Promise<void> }) {
  const [settings, setSettings] = useState<RepoSettings | null>(null);
  const [context, setContext] = useState<RepoContext | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const [nextSettings, nextContext] = await Promise.all([
      execute<RepoSettings>('repo.settings.get', { owner, repo }),
      execute<RepoContext>('context.snapshot', { owner, repo, ref: meta.default_branch }),
    ]);
    setSettings(nextSettings);
    setContext(nextContext);
  }

  useEffect(() => { void load().catch(setError); }, [owner, repo, meta.default_branch]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setError(null);
      setSaved(false);
      const result = await execute<SettingsResult>('repo.settings.update', {
        owner,
        repo,
        description: String(data.get('description') ?? ''),
        website: String(data.get('website') ?? ''),
        visibility: String(data.get('visibility') ?? 'private'),
        mergeMethod: String(data.get('mergeMethod') ?? 'squash'),
        deleteHeadOnMerge: data.get('deleteHeadOnMerge') === 'on',
        issuesEnabled: data.get('issuesEnabled') === 'on',
        pullsEnabled: data.get('pullsEnabled') === 'on',
        actionsEnabled: data.get('actionsEnabled') === 'on',
        releasesEnabled: data.get('releasesEnabled') === 'on',
        agentWriteEnabled: data.get('agentWriteEnabled') === 'on',
        contextRecentCommits: Number(data.get('contextRecentCommits') ?? 20),
        contextRecentEvents: Number(data.get('contextRecentEvents') ?? 50),
      });
      setSettings(result);
      setSaved(true);
      await Promise.all([onChanged(), load()]);
    } catch (cause) { setError(cause); }
  }

  if (error) return <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div>;
  if (!settings) return <div className="forge-loading"><Spinner /></div>;

  return <section><div className="forge-code-toolbar"><div><Heading as="h2">Settings</Heading><div className="forge-page-subtitle">Repository policy, product surfaces, merge behavior, and agent write scope.</div></div>{saved ? <span className="forge-badge">Saved</span> : null}</div><div className="forge-settings-layout"><form className="forge-card forge-form" onSubmit={save}><Heading as="h3"><GearIcon /> General</Heading><div className="forge-field"><label>Description</label><input className="forge-input" name="description" defaultValue={meta.description} /></div><div className="forge-field"><label>Website</label><input className="forge-input" name="website" defaultValue={meta.website ?? ''} /></div><div className="forge-field"><label>Visibility</label><select className="forge-select" name="visibility" defaultValue={meta.visibility}><option value="private">Private</option><option value="public">Public</option></select></div><div className="forge-field"><label>Default merge method</label><select className="forge-select" name="mergeMethod" defaultValue={settings.merge_method}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select></div><div className="forge-setting-toggles"><label className="forge-checkbox"><input type="checkbox" name="issuesEnabled" defaultChecked={Boolean(settings.issues_enabled)} /> Issues</label><label className="forge-checkbox"><input type="checkbox" name="pullsEnabled" defaultChecked={Boolean(settings.pulls_enabled)} /> Pull requests</label><label className="forge-checkbox"><input type="checkbox" name="actionsEnabled" defaultChecked={Boolean(settings.actions_enabled)} /> Actions</label><label className="forge-checkbox"><input type="checkbox" name="releasesEnabled" defaultChecked={Boolean(settings.releases_enabled)} /> Releases</label><label className="forge-checkbox"><input type="checkbox" name="deleteHeadOnMerge" defaultChecked={Boolean(settings.delete_head_on_merge)} /> Delete head branch after merge</label></div><Heading as="h3"><CpuIcon /> Agent context</Heading><p className="forge-muted">Every repo-scoped MCP/Code Mode call receives a deterministic RepoContext. Mutable agent workspaces refresh the same context under <code>.git/forge/</code> before each command.</p><label className="forge-checkbox"><input type="checkbox" name="agentWriteEnabled" defaultChecked={Boolean(settings.agent_write_enabled)} /> Permit write-capable agent sessions</label><div className="forge-two-column"><div className="forge-field"><label>Recent commits in context</label><input className="forge-input" type="number" min="1" max="100" name="contextRecentCommits" defaultValue={settings.context_recent_commits} /></div><div className="forge-field"><label>Recent context events</label><input className="forge-input" type="number" min="1" max="200" name="contextRecentEvents" defaultValue={settings.context_recent_events} /></div></div><Button type="submit" variant="primary">Save changes</Button></form><aside><div className="forge-card"><div className="forge-list-head"><strong>Shared agent context</strong><CpuIcon /></div>{context ? <div className="forge-sidebar-body"><div className="forge-context-kv"><span>Ref</span><code>{context.authority.ref}</code><span>Head</span><code>{context.authority.headSha?.slice(0, 12) || 'unknown'}</code><span>Instructions</span><strong>{context.instructions.length}</strong><span>Active agents</span><strong>{context.activeAgents.length}</strong><span>Open issues</span><strong>{context.openIssues.length}</strong><span>Open PRs</span><strong>{context.openPullRequests.length}</strong></div></div> : <div className="forge-loading"><Spinner /></div>}</div><div className="forge-card"><div className="forge-list-head"><strong><PeopleIcon /> Active agents</strong></div>{context?.activeAgents.length ? context.activeAgents.map((agent) => <div className="forge-management-row" key={agent.id}><div><strong>{agent.agent_name}</strong><div className="forge-list-meta">{agent.ref}{agent.target_kind && agent.target_number ? ` · ${agent.target_kind} #${agent.target_number}` : ''}</div></div><span className="forge-badge">{agent.access_mode}</span></div>) : <div className="forge-empty">No active agent sessions.</div>}</div><div className="forge-card"><div className="forge-list-head"><strong>Repository instructions</strong></div>{context?.instructions.length ? context.instructions.map((instruction) => <div className="forge-management-row" key={instruction.path}><code>{instruction.path}</code></div>) : <div className="forge-empty">No AGENTS.md / CLAUDE.md / Copilot instructions found.</div>}</div></aside></div></section>;
}
