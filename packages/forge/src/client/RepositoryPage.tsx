import React, { useEffect, useState } from 'react';
import { Spinner, UnderlineNav } from '@primer/react';
import {
  BellIcon,
  CodeIcon,
  GearIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  PackageIcon,
  PlayIcon,
  RepoIcon,
} from '@primer/octicons-react';
import type { CiRun, Issue, Notification, Pull, Release, RepoRecord } from './model';
import { execute, navigate, repoPath } from './api';
import { CodeTab } from './CodeTab';
import { IssuesTab } from './IssuesTab';
import { PullsTab } from './PullsTab';
import { ActionsTab } from './ActionsTab';
import { ReleasesTab } from './ReleasesTab';
import { NotificationsTab } from './NotificationsTab';
import { SettingsTab } from './SettingsTab';

export type RepoTab = 'code' | 'issues' | 'pulls' | 'actions' | 'releases' | 'notifications' | 'settings';

function tabFromPath(pathname: string): RepoTab {
  const segment = pathname.split('/').filter(Boolean)[3];
  if (segment === 'issues' || segment === 'pulls' || segment === 'actions' || segment === 'releases' || segment === 'notifications' || segment === 'settings') return segment;
  return 'code';
}

export function RepositoryPage({ owner, repo, pathname }: { owner: string; repo: string; pathname: string }) {
  const [meta, setMeta] = useState<RepoRecord | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [runs, setRuns] = useState<CiRun[]>([]);
  const [releaseCount, setReleaseCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const tab = tabFromPath(pathname);

  async function refreshSummary() {
    const [repository, issueRows, pullRows, ciRows, releases, unread] = await Promise.all([
      execute<RepoRecord>('repo.get', { owner, repo }),
      execute<Issue[]>('issue.list', { owner, repo }),
      execute<Pull[]>('pull.list', { owner, repo }),
      execute<CiRun[]>('ci.list', { owner, repo }).catch(() => []),
      execute<Release[]>('release.list', { owner, repo }).catch(() => []),
      execute<Notification[]>('notification.list', { owner, repo, unreadOnly: true, limit: 200 }).catch(() => []),
    ]);
    setMeta(repository);
    setIssues(issueRows);
    setPulls(pullRows);
    setRuns(ciRows);
    setReleaseCount(releases.length);
    setUnreadCount(unread.length);
  }

  useEffect(() => {
    setMeta(null);
    setError(null);
    void refreshSummary().catch(setError);
  }, [owner, repo]);

  if (error) return <main className="forge-container"><div className="forge-card forge-empty">{error instanceof Error ? error.message : String(error)}</div></main>;
  if (!meta) return <main className="forge-container"><div className="forge-loading"><Spinner /></div></main>;

  const openIssues = issues.filter((item) => item.state === 'open').length;
  const openPulls = pulls.filter((item) => item.state === 'open').length;
  const go = (next: RepoTab) => navigate(repoPath(owner, repo, next === 'code' ? '' : `/${next}`));

  return <main className="forge-container"><div className="forge-repo-header"><div><div className="forge-repo-title"><RepoIcon size={20} /><a href="/" className="forge-owner" onClick={(event) => { event.preventDefault(); navigate('/'); }}>{owner}</a><span className="forge-muted">/</span><a href={repoPath(owner, repo)} className="forge-title-link" onClick={(event) => { event.preventDefault(); navigate(repoPath(owner, repo)); }}>{repo}</a><span className="forge-badge">{meta.visibility}</span></div><div className="forge-page-subtitle">{meta.description || 'No description provided.'}{meta.website ? <> · <a href={meta.website}>{meta.website}</a></> : null}</div></div></div><div className="forge-tabs"><UnderlineNav aria-label="Repository"><UnderlineNav.Item leadingVisual={<CodeIcon />} aria-current={tab === 'code' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('code'); }}>Code</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<IssueOpenedIcon />} counter={openIssues} aria-current={tab === 'issues' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('issues'); }}>Issues</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<GitPullRequestIcon />} counter={openPulls} aria-current={tab === 'pulls' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('pulls'); }}>Pull requests</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<PlayIcon />} counter={runs.length} aria-current={tab === 'actions' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('actions'); }}>Actions</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<PackageIcon />} counter={releaseCount} aria-current={tab === 'releases' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('releases'); }}>Releases</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<BellIcon />} counter={unreadCount} aria-current={tab === 'notifications' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('notifications'); }}>Notifications</UnderlineNav.Item><UnderlineNav.Item leadingVisual={<GearIcon />} aria-current={tab === 'settings' ? 'page' : undefined} onSelect={(event) => { event.preventDefault(); go('settings'); }}>Settings</UnderlineNav.Item></UnderlineNav></div>{tab === 'code' ? <CodeTab owner={owner} repo={repo} meta={meta} /> : null}{tab === 'issues' ? <IssuesTab owner={owner} repo={repo} issues={issues} refresh={refreshSummary} /> : null}{tab === 'pulls' ? <PullsTab owner={owner} repo={repo} pulls={pulls} defaultBranch={meta.default_branch} refresh={refreshSummary} /> : null}{tab === 'actions' ? <ActionsTab owner={owner} repo={repo} runs={runs} defaultBranch={meta.default_branch} refresh={refreshSummary} /> : null}{tab === 'releases' ? <ReleasesTab owner={owner} repo={repo} /> : null}{tab === 'notifications' ? <NotificationsTab owner={owner} repo={repo} /> : null}{tab === 'settings' ? <SettingsTab owner={owner} repo={repo} meta={meta} onChanged={refreshSummary} /> : null}</main>;
}
