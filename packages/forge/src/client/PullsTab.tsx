import React, { useEffect, useState } from 'react';
import { Button, Heading, StateLabel } from '@primer/react';
import { GitPullRequestIcon, PlusIcon } from '@primer/octicons-react';
import type { Label, Milestone, Pull } from './model';
import { execute, navigate, repoPath } from './api';

export function PullsTab({ owner, repo, pulls, defaultBranch, refresh }: { owner: string; repo: string; pulls: Pull[]; defaultBranch: string; refresh: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [labels, setLabels] = useState<Label[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void Promise.all([
      execute<Label[]>('label.list', { owner, repo }).then(setLabels),
      execute<Milestone[]>('milestone.list', { owner, repo }).then(setMilestones),
    ]).catch(setError);
  }, [owner, repo]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setError(null);
      const reviewers = String(data.get('reviewers') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      const created = await execute<Pull>('pull.create', {
        owner,
        repo,
        title: String(data.get('title') ?? ''),
        body: String(data.get('body') ?? ''),
        baseRef: String(data.get('baseRef') ?? defaultBranch),
        headRef: String(data.get('headRef') ?? ''),
        labels: data.getAll('labels').map(String),
        milestone: data.get('milestone') ? Number(data.get('milestone')) : undefined,
        reviewers,
      });
      setCreating(false);
      await refresh();
      navigate(repoPath(owner, repo, `/pulls/${created.number}`));
    } catch (cause) { setError(cause); }
  }

  return (
    <section>
      {error ? <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div> : null}
      <div className="forge-code-toolbar"><div><Heading as="h2">Pull requests</Heading><div className="forge-page-subtitle">Review branches stored in the same Artifacts Git repository.</div></div><Button variant="primary" leadingVisual={PlusIcon} onClick={() => setCreating((value) => !value)}>New pull request</Button></div>
      {creating ? <div className="forge-card"><form className="forge-form" onSubmit={submit}><div className="forge-field"><label>Title</label><input className="forge-input" name="title" required /></div><div className="forge-two-column"><div className="forge-field"><label>Base branch</label><input className="forge-input" name="baseRef" defaultValue={defaultBranch} required /></div><div className="forge-field"><label>Compare branch</label><input className="forge-input" name="headRef" required /></div></div><div className="forge-field"><label>Description</label><textarea className="forge-textarea" name="body" /></div><div className="forge-field"><label>Reviewers</label><input className="forge-input" name="reviewers" placeholder="alice,bob" /></div>{labels.length ? <div className="forge-field"><label>Labels</label><select className="forge-select" name="labels" multiple size={Math.min(6, labels.length)}>{labels.map((label) => <option key={label.id} value={label.name}>{label.name}</option>)}</select></div> : null}{milestones.length ? <div className="forge-field"><label>Milestone</label><select className="forge-select" name="milestone"><option value="">None</option>{milestones.filter((item) => item.state === 'open').map((item) => <option key={item.id} value={item.number}>{item.title}</option>)}</select></div> : null}<div className="forge-form-actions"><Button type="button" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary">Create pull request</Button></div></form></div> : null}
      <div className="forge-card">
        <div className="forge-list-head"><strong>Pull requests</strong><span className="forge-muted">{pulls.length}</span></div>
        {pulls.length === 0 ? <div className="forge-empty">No pull requests.</div> : pulls.map((pull) => <button className="forge-list-row forge-click-row" key={pull.number} onClick={() => navigate(repoPath(owner, repo, `/pulls/${pull.number}`))}><GitPullRequestIcon /><div><div className="forge-list-title">{pull.title}</div><div className="forge-list-meta">#{pull.number} {pull.head_ref} → {pull.base_ref} · {pull.author}</div></div><StateLabel status={pull.state === 'merged' ? 'pullMerged' : pull.state === 'closed' ? 'pullClosed' : 'pullOpened'} size="small">{pull.state}</StateLabel></button>)}
      </div>
    </section>
  );
}
