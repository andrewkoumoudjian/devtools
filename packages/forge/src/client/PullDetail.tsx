import React, { useEffect, useState } from 'react';
import { Button, Heading, Spinner, StateLabel, UnderlineNav } from '@primer/react';
import { CheckCircleFillIcon, CommentDiscussionIcon, DiffIcon, GitPullRequestIcon, PersonAddIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { CiRun, PullDetail as PullDetailModel, PullDiff } from './model';
import { execute, navigate, repoPath } from './api';

function stateLabel(state: PullDetailModel['state']) {
  return <StateLabel status={state === 'merged' ? 'pullMerged' : state === 'closed' ? 'pullClosed' : 'pullOpened'}>{state}</StateLabel>;
}

function CheckRun({ run }: { run: CiRun }) {
  const passed = run.status === 'success';
  const failed = run.status === 'failure';
  return <div className="forge-check-row">{passed ? <CheckCircleFillIcon /> : failed ? <XCircleFillIcon /> : <span className="forge-dot" />}<div><strong>{run.ref}</strong><div className="forge-list-meta">{run.sha?.slice(0, 10) || 'no sha'} · {run.status}</div>{run.steps?.map((step) => <div className="forge-check-step" key={step.id}><span>{step.name}</span><span className="forge-muted">{step.status}{step.exit_code !== null ? ` · exit ${step.exit_code}` : ''}</span></div>)}</div></div>;
}

export function PullDetail({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const [pull, setPull] = useState<PullDetailModel | null>(null);
  const [tab, setTab] = useState<'conversation' | 'files' | 'checks'>('conversation');
  const [diff, setDiff] = useState<PullDiff | null>(null);
  const [checks, setChecks] = useState<{ sha: string | null; checks: CiRun[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reviewers, setReviewers] = useState('');

  async function load() {
    setPull(await execute<PullDetailModel>('pull.get', { owner, repo, number }));
  }

  useEffect(() => { void load().catch(setError); }, [owner, repo, number]);

  useEffect(() => {
    if (tab === 'files' && diff === null) void execute<PullDiff>('pull.diff', { owner, repo, number }).then(setDiff).catch(setError);
    if (tab === 'checks' && checks === null) void execute<{ sha: string | null; checks: CiRun[] }>('pull.checks', { owner, repo, number }).then(setChecks).catch(setError);
  }, [tab, owner, repo, number]);

  async function addComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('pull.comment', { owner, repo, number, body: String(data.get('body') ?? ''), author: String(data.get('author') ?? 'user') });
      event.currentTarget.reset();
      await load();
    } catch (cause) { setError(cause); }
  }

  async function submitReview(state: 'approved' | 'changes_requested' | 'commented', event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await execute('pull.review', { owner, repo, number, state, body: String(data.get('body') ?? ''), author: String(data.get('author') ?? 'reviewer') });
      event.currentTarget.reset();
      await load();
    } catch (cause) { setError(cause); }
  }

  async function requestReviewers() {
    const values = reviewers.split(',').map((value) => value.trim()).filter(Boolean);
    if (!values.length) return;
    try {
      await execute('pull.reviewers.request', { owner, repo, number, reviewers: values });
      setReviewers('');
      await load();
    } catch (cause) { setError(cause); }
  }

  async function updateState(state: 'open' | 'closed') {
    try {
      await execute('pull.update', { owner, repo, number, state });
      await load();
    } catch (cause) { setError(cause); }
  }

  if (error) return <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div>;
  if (!pull) return <div className="forge-loading"><Spinner /></div>;

  const conversation = pull.conversation?.conversation ?? [];
  const requested = pull.reviewers ?? pull.conversation?.reviewRequests ?? [];

  return (
    <section>
      <Button onClick={() => navigate(repoPath(owner, repo))}>← Back to repository</Button>
      <div className="forge-pr-head">
        <div><Heading as="h1">{pull.title} <span className="forge-muted">#{pull.number}</span></Heading><div className="forge-pr-meta">{stateLabel(pull.state)} <strong>{pull.author}</strong> wants to merge <code>{pull.head_ref}</code> into <code>{pull.base_ref}</code>{pull.head_sha ? <> · <span className="forge-sha">{pull.head_sha.slice(0, 10)}</span></> : null}</div></div>
        <div>{pull.state === 'open' ? <Button onClick={() => void updateState('closed')}>Close pull request</Button> : pull.state === 'closed' ? <Button onClick={() => void updateState('open')}>Reopen</Button> : null}</div>
      </div>

      <div className="forge-tabs forge-pr-tabs"><UnderlineNav aria-label="Pull request"><UnderlineNav.Item leadingVisual={<CommentDiscussionIcon />} aria-current={tab === 'conversation' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('conversation'); }}>Conversation</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<DiffIcon />} counter={diff?.filesChanged} aria-current={tab === 'files' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('files'); }}>Files changed</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<GitPullRequestIcon />} counter={checks?.checks.length ?? pull.checks?.length} aria-current={tab === 'checks' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); setTab('checks'); }}>Checks</UnderlineNav.Item></UnderlineNav></div>

      {tab === 'conversation' ? <div className="forge-pr-layout"><div className="forge-pr-main"><div className="forge-card forge-pr-description"><div className="forge-list-head"><strong>{pull.author}</strong><span className="forge-muted">opened this pull request</span></div><div className="forge-prose">{pull.body || <span className="forge-muted">No description provided.</span>}</div></div>{conversation.map((item) => <div className="forge-timeline-item" key={item.id}><div className="forge-timeline-marker"><CommentDiscussionIcon /></div><div className="forge-card"><div className="forge-list-head"><strong>{item.author}</strong><span className="forge-muted">{item.kind}{item.review_state ? ` · ${item.review_state}` : ''} · {item.created_at}</span></div><div className="forge-prose">{item.path ? <div className="forge-inline-location">{item.path}{item.line ? `:${item.line}` : ''}</div> : null}{item.body || <span className="forge-muted">No review body.</span>}</div></div></div>)}<div className="forge-card"><form className="forge-form" onSubmit={addComment}><Heading as="h3">Add to conversation</Heading><input className="forge-input" name="author" placeholder="Your name" defaultValue="user" /><textarea className="forge-textarea" name="body" placeholder="Leave a comment" required /><Button type="submit" variant="primary">Comment</Button></form></div><div className="forge-card"><form className="forge-form" onSubmit={(event) => void submitReview('commented', event)}><Heading as="h3">Submit review</Heading><input className="forge-input" name="author" placeholder="Reviewer" defaultValue="reviewer" /><textarea className="forge-textarea" name="body" placeholder="Review summary" /><div className="forge-form-actions"><Button type="button" onClick={(event) => { const form = event.currentTarget.closest('form'); if (form) void submitReview('changes_requested', { preventDefault() {}, currentTarget: form } as unknown as React.FormEvent<HTMLFormElement>); }}>Request changes</Button><Button type="button" variant="primary" onClick={(event) => { const form = event.currentTarget.closest('form'); if (form) void submitReview('approved', { preventDefault() {}, currentTarget: form } as unknown as React.FormEvent<HTMLFormElement>); }}>Approve</Button><Button type="submit">Comment review</Button></div></form></div></div><aside className="forge-pr-sidebar"><div className="forge-card"><div className="forge-list-head"><strong>Reviewers</strong><PersonAddIcon /></div><div className="forge-sidebar-body">{requested.length === 0 ? <div className="forge-muted">No reviewers requested.</div> : requested.map((request) => <div key={request.reviewer} className="forge-reviewer">{request.reviewer}</div>)}<div className="forge-field"><input className="forge-input" value={reviewers} onChange={(event) => setReviewers(event.target.value)} placeholder="alice,bob" /><Button onClick={() => void requestReviewers()} disabled={!reviewers.trim()}>Request</Button></div></div></div>{pull.labels?.length ? <div className="forge-card"><div className="forge-list-head"><strong>Labels</strong></div><div className="forge-sidebar-body forge-labels">{pull.labels.map((label) => <span className="forge-label" key={label.id} style={{ borderColor: `#${label.color}` }}>{label.name}</span>)}</div></div> : null}</aside></div> : null}

      {tab === 'files' ? <div>{diff === null ? <div className="forge-loading"><Spinner /></div> : <><div className="forge-code-toolbar"><div><Heading as="h2">Files changed</Heading><div className="forge-page-subtitle">{diff.filesChanged} files · {diff.base.ref} → {diff.head.ref}</div></div>{diff.truncated ? <span className="forge-badge">truncated file list</span> : null}</div>{diff.changes.length === 0 ? <div className="forge-card forge-empty">No changes between these refs.</div> : diff.changes.map((change) => <div className="forge-card forge-diff-card" key={change.path}><div className="forge-list-head"><strong>{change.path}</strong><span className="forge-badge">{change.status}</span></div>{change.binary ? <div className="forge-empty">Binary file changed.</div> : change.truncated ? <div className="forge-empty">Text diff exceeds the configured Artifacts read budget.</div> : <pre className="forge-diff"><code>{change.patch || 'No textual changes.'}</code></pre>}</div>)}</>}</div> : null}

      {tab === 'checks' ? <div><div className="forge-code-toolbar"><div><Heading as="h2">Checks</Heading><div className="forge-page-subtitle">Cloudflare Workflows + Sandbox checks for {checks?.sha?.slice(0, 10) || pull.head_sha?.slice(0, 10) || 'the head ref'}.</div></div></div>{checks === null ? <div className="forge-loading"><Spinner /></div> : checks.checks.length === 0 ? <div className="forge-card forge-empty">No CI checks for this head SHA.</div> : <div className="forge-card forge-checks">{checks.checks.map((run) => <CheckRun key={run.id} run={run} />)}</div>}</div> : null}
    </section>
  );
}
