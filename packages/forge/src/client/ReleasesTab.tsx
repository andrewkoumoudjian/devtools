import React, { useEffect, useState } from 'react';
import { Button, Heading } from '@primer/react';
import { PackageIcon, PlusIcon, TagIcon } from '@primer/octicons-react';
import type { GitRefs, Release } from './model';
import { execute } from './api';
import { Markdown } from './Markdown';

export function ReleasesTab({ owner, repo }: { owner: string; repo: string }) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load() {
    const [releaseRows, gitRefs] = await Promise.all([
      execute<Release[]>('release.list', { owner, repo }),
      execute<GitRefs>('git.refs', { owner, repo }),
    ]);
    setReleases(releaseRows);
    setRefs(gitRefs);
  }

  useEffect(() => { void load().catch(setError); }, [owner, repo]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('release.create', {
        owner,
        repo,
        tagName: String(data.get('tagName') ?? ''),
        name: String(data.get('name') ?? ''),
        body: String(data.get('body') ?? ''),
        draft: data.get('draft') === 'on',
        prerelease: data.get('prerelease') === 'on',
      });
      setCreating(false);
      await load();
    } catch (cause) { setError(cause); }
  }

  return <section>{error ? <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div> : null}<div className="forge-code-toolbar"><div><Heading as="h2">Releases</Heading><div className="forge-page-subtitle">Release notes attached to immutable Artifacts Git tags.</div></div><Button variant="primary" leadingVisual={PlusIcon} onClick={() => setCreating((value) => !value)}>Draft a new release</Button></div>{creating ? <div className="forge-card"><form className="forge-form" onSubmit={create}><div className="forge-field"><label>Tag</label><select className="forge-select" name="tagName" required><option value="">Choose a tag</option>{refs?.tags.map((tag) => <option value={tag.name} key={tag.name}>{tag.name}</option>)}</select></div><div className="forge-field"><label>Release title</label><input className="forge-input" name="name" /></div><div className="forge-field"><label>Release notes</label><textarea className="forge-textarea" name="body" /></div><label className="forge-checkbox"><input type="checkbox" name="prerelease" /> Mark as pre-release</label><label className="forge-checkbox"><input type="checkbox" name="draft" /> Save as draft</label><div className="forge-form-actions"><Button type="button" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary">Create release</Button></div></form></div> : null}<div className="forge-release-list">{releases.length === 0 ? <div className="forge-card forge-empty">No releases yet. Push a tag to Artifacts, then create release notes here.</div> : releases.map((release) => <article className="forge-card forge-release" key={release.id}><div className="forge-release-icon"><PackageIcon size={24} /></div><div><Heading as="h2">{release.name || release.tag_name}</Heading><div className="forge-release-meta"><TagIcon /> {release.tag_name} · {release.author} · {release.published_at || release.created_at} {release.draft ? <span className="forge-badge">Draft</span> : null} {release.prerelease ? <span className="forge-badge">Pre-release</span> : null}</div>{release.body ? <Markdown source={release.body} /> : <div className="forge-muted">No release notes.</div>}</div></article>)}</div></section>;
}
