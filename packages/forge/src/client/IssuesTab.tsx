import React, { useEffect, useMemo, useState } from 'react';
import { Button, Heading, StateLabel } from '@primer/react';
import { IssueClosedIcon, IssueOpenedIcon, MilestoneIcon, PlusIcon, TagIcon } from '@primer/octicons-react';
import type { Issue, Label, Milestone } from './model';
import { execute } from './api';

function labelStyle(label: Label): React.CSSProperties {
  return { borderColor: `#${label.color}`, boxShadow: `inset 0 0 0 1px #${label.color}` };
}

export function IssuesTab({ owner, repo, issues, refresh }: { owner: string; repo: string; issues: Issue[]; refresh: () => Promise<void> }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [labels, setLabels] = useState<Label[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [creating, setCreating] = useState(false);
  const [manage, setManage] = useState<'labels' | 'milestones' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const rows = useMemo(() => issues.filter((item) => item.state === state), [issues, state]);

  async function loadMetadata() {
    const [labelRows, milestoneRows] = await Promise.all([
      execute<Label[]>('label.list', { owner, repo }),
      execute<Milestone[]>('milestone.list', { owner, repo }),
    ]);
    setLabels(labelRows);
    setMilestones(milestoneRows);
  }

  useEffect(() => { void loadMetadata().catch(setError); }, [owner, repo]);

  async function createIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setError(null);
      await execute('issue.create', {
        owner,
        repo,
        title: String(data.get('title') ?? ''),
        body: String(data.get('body') ?? ''),
        labels: data.getAll('labels').map(String),
        milestone: data.get('milestone') ? Number(data.get('milestone')) : undefined,
      });
      setCreating(false);
      await refresh();
    } catch (cause) { setError(cause); }
  }

  async function createLabel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('label.create', { owner, repo, name: String(data.get('name') ?? ''), color: String(data.get('color') ?? '0969da'), description: String(data.get('description') ?? '') });
      event.currentTarget.reset();
      await loadMetadata();
    } catch (cause) { setError(cause); }
  }

  async function createMilestone(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('milestone.create', { owner, repo, title: String(data.get('title') ?? ''), description: String(data.get('description') ?? ''), dueAt: String(data.get('dueAt') ?? '') || undefined });
      event.currentTarget.reset();
      await loadMetadata();
    } catch (cause) { setError(cause); }
  }

  return (
    <section>
      {error ? <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div> : null}
      <div className="forge-code-toolbar">
        <div className="forge-toolbar-left">
          <Button leadingVisual={IssueOpenedIcon} onClick={() => setState('open')}>Open</Button>
          <Button leadingVisual={IssueClosedIcon} onClick={() => setState('closed')}>Closed</Button>
          <Button leadingVisual={TagIcon} onClick={() => setManage(manage === 'labels' ? null : 'labels')}>Labels <span className="forge-counter">{labels.length}</span></Button>
          <Button leadingVisual={MilestoneIcon} onClick={() => setManage(manage === 'milestones' ? null : 'milestones')}>Milestones <span className="forge-counter">{milestones.length}</span></Button>
        </div>
        <Button variant="primary" leadingVisual={PlusIcon} onClick={() => setCreating((value) => !value)}>New issue</Button>
      </div>

      {creating ? <div className="forge-card"><form className="forge-form" onSubmit={createIssue}><Heading as="h2">New issue</Heading><div className="forge-field"><label>Title</label><input className="forge-input" name="title" required /></div><div className="forge-field"><label>Description</label><textarea className="forge-textarea" name="body" /></div>{labels.length ? <div className="forge-field"><label>Labels</label><select className="forge-select" name="labels" multiple size={Math.min(6, labels.length)}>{labels.map((label) => <option key={label.id} value={label.name}>{label.name}</option>)}</select></div> : null}{milestones.length ? <div className="forge-field"><label>Milestone</label><select className="forge-select" name="milestone"><option value="">None</option>{milestones.filter((item) => item.state === 'open').map((item) => <option key={item.id} value={item.number}>{item.title}</option>)}</select></div> : null}<div className="forge-form-actions"><Button type="button" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary">Submit issue</Button></div></form></div> : null}

      {manage === 'labels' ? <div className="forge-card forge-management"><div className="forge-list-head"><strong>Labels</strong><span className="forge-muted">Repository-wide issue and PR labels</span></div><div className="forge-management-grid"><div>{labels.length === 0 ? <div className="forge-empty">No labels.</div> : labels.map((label) => <div className="forge-management-row" key={label.id}><span className="forge-label" style={labelStyle(label)}>{label.name}</span><span className="forge-muted">{label.description}</span></div>)}</div><form className="forge-form" onSubmit={createLabel}><Heading as="h3">New label</Heading><div className="forge-field"><label>Name</label><input className="forge-input" name="name" required /></div><div className="forge-field"><label>Color</label><input className="forge-input" name="color" defaultValue="0969da" pattern="#?[0-9a-fA-F]{6}" required /></div><div className="forge-field"><label>Description</label><input className="forge-input" name="description" /></div><Button type="submit" variant="primary">Create label</Button></form></div></div> : null}

      {manage === 'milestones' ? <div className="forge-card forge-management"><div className="forge-list-head"><strong>Milestones</strong><span className="forge-muted">Group issues and pull requests by goal</span></div><div className="forge-management-grid"><div>{milestones.length === 0 ? <div className="forge-empty">No milestones.</div> : milestones.map((milestone) => <div className="forge-management-row" key={milestone.id}><div><strong>{milestone.title}</strong><div className="forge-muted">#{milestone.number}{milestone.due_at ? ` · due ${milestone.due_at}` : ''}</div></div><span className="forge-badge">{milestone.state}</span></div>)}</div><form className="forge-form" onSubmit={createMilestone}><Heading as="h3">New milestone</Heading><div className="forge-field"><label>Title</label><input className="forge-input" name="title" required /></div><div className="forge-field"><label>Description</label><textarea className="forge-textarea" name="description" /></div><div className="forge-field"><label>Due date</label><input className="forge-input" type="date" name="dueAt" /></div><Button type="submit" variant="primary">Create milestone</Button></form></div></div> : null}

      <div className="forge-card">
        <div className="forge-list-head"><strong>{state === 'open' ? 'Open' : 'Closed'} issues</strong><span className="forge-muted">{rows.length}</span></div>
        {rows.length === 0 ? <div className="forge-empty">No {state} issues.</div> : rows.map((issue) => <div className="forge-list-row" key={issue.number}>{issue.state === 'open' ? <IssueOpenedIcon /> : <IssueClosedIcon />}<div><div className="forge-list-title">{issue.title}</div><div className="forge-list-meta">#{issue.number} opened by {issue.author}</div></div><StateLabel status={issue.state === 'open' ? 'issueOpened' : 'issueClosed'} size="small">{issue.state === 'open' ? 'Open' : 'Closed'}</StateLabel></div>)}
      </div>
    </section>
  );
}
