import React, { useEffect, useState } from 'react';
import { Button, Heading, Spinner } from '@primer/react';
import { CheckCircleFillIcon, ChevronDownIcon, ChevronRightIcon, PlayIcon, SyncIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { CiRun, CiStep, Commit } from './model';
import { execute } from './api';

type StepLog = { step: CiStep; stdout: string; stderr: string };

function statusIcon(status: string) {
  if (status === 'success') return <CheckCircleFillIcon />;
  if (status === 'failure') return <XCircleFillIcon />;
  return <PlayIcon />;
}

export function ActionsTab({ owner, repo, runs, defaultBranch, refresh }: { owner: string; repo: string; runs: CiRun[]; defaultBranch: string; refresh: () => Promise<void> }) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedRun, setSelectedRun] = useState<CiRun | null>(null);
  const [selectedStep, setSelectedStep] = useState<StepLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => { void execute<Commit[]>('git.log', { owner, repo, ref: defaultBranch, limit: 1 }).then(setCommits).catch(setError); }, [owner, repo, defaultBranch]);

  async function runLatest() {
    const latest = commits[0];
    if (!latest) return;
    try {
      setError(null);
      await execute('ci.run', { owner, repo, ref: defaultBranch, sha: latest.hash });
      await refresh();
    } catch (cause) { setError(cause); }
  }

  async function openRun(run: CiRun) {
    setLoading(true);
    setSelectedStep(null);
    try {
      setSelectedRun(await execute<CiRun>('ci.get', { owner, repo, runId: run.id }));
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  async function openStep(run: CiRun, step: CiStep) {
    setLoading(true);
    try {
      setSelectedStep(await execute<StepLog>('ci.step.log', { owner, repo, runId: run.id, stepId: step.id }));
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  return (
    <section>
      {error ? <div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div> : null}
      <div className="forge-code-toolbar"><div><Heading as="h2">Actions</Heading><div className="forge-page-subtitle">Cloudflare Workflows + Sandbox CI with persisted D1 checks and R2 step logs.</div></div><Button variant="primary" leadingVisual={SyncIcon} onClick={() => void runLatest()} disabled={!commits[0]}>Run latest</Button></div>
      <div className="forge-actions-layout">
        <div className="forge-card">
          <div className="forge-list-head"><strong>Workflow runs</strong><span className="forge-muted">{runs.length}</span></div>
          {runs.length === 0 ? <div className="forge-empty">No CI runs recorded yet.</div> : runs.map((run) => <button className="forge-list-row forge-click-row" key={run.id} onClick={() => void openRun(run)}>{statusIcon(run.status)}<div><div className="forge-list-title">{run.ref.replace(/^refs\/heads\//, '')}</div><div className="forge-list-meta">{run.sha?.slice(0, 10) || 'no sha'} · {run.created_at}</div></div><span className="forge-badge">{run.status}</span></button>)}
        </div>
        <div>
          {loading && !selectedRun ? <div className="forge-loading"><Spinner /></div> : selectedRun ? <div className="forge-card"><div className="forge-list-head"><div><strong>{selectedRun.ref.replace(/^refs\/heads\//, '')}</strong><div className="forge-list-meta">{selectedRun.sha?.slice(0, 10)} · workflow {selectedRun.workflow_instance_id}</div></div><span className="forge-badge">{selectedRun.status}</span></div>{(selectedRun.steps ?? []).length === 0 ? <div className="forge-empty">Steps have not been recorded yet.</div> : selectedRun.steps?.map((step) => <button className="forge-action-step" key={step.id} onClick={() => void openStep(selectedRun, step)}>{selectedStep?.step.id === step.id ? <ChevronDownIcon /> : <ChevronRightIcon />}{statusIcon(step.status)}<span>{step.name}</span><span className="forge-muted">{step.status}{step.exit_code !== null ? ` · exit ${step.exit_code}` : ''}</span></button>)}</div> : <div className="forge-card forge-empty">Select a workflow run to inspect every step and its logs.</div>}
          {selectedStep ? <div className="forge-card forge-log-card"><div className="forge-list-head"><strong>{selectedStep.step.name} logs</strong><span className="forge-muted">exit {selectedStep.step.exit_code ?? '—'}</span></div><div className="forge-log-stream"><div className="forge-log-label">stdout</div><pre>{selectedStep.stdout || '(empty)'}</pre></div><div className="forge-log-stream"><div className="forge-log-label">stderr</div><pre>{selectedStep.stderr || '(empty)'}</pre></div></div> : null}
        </div>
      </div>
    </section>
  );
}
