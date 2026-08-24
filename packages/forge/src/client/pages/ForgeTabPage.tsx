import { useParams } from "react-router-dom";
import { execute } from "../api";
import { useData, invalidate } from "../data";
import { useRepo } from "./RepoLayout";
import type { CiRun, Issue, Notification, Pull, Release } from "../model";
import { IssuesTab } from "../IssuesTab";
import { PullsTab } from "../PullsTab";
import { ActionsTab } from "../ActionsTab";
import { ReleasesTab } from "../ReleasesTab";
import { NotificationsTab } from "../NotificationsTab";
import { SettingsTab } from "../SettingsTab";
import { PullDetail } from "../PullDetail";

export type ForgeTab = "issues" | "pulls" | "actions" | "releases" | "notifications" | "settings";
export function ForgeTabPage({ tab }: { tab: ForgeTab }) {
  const { owner, name: repo, full, meta } = useRepo();
  const refreshKey = `forge:${full}:`;
  const refresh = async () => { invalidate(refreshKey); };
  if (tab === "issues") { const issues = useData(`${refreshKey}issues`, () => execute<Issue[]>("issue.list", { owner, repo })); return <div className="forge-embedded"><IssuesTab owner={owner} repo={repo} issues={issues} refresh={refresh} /></div>; }
  if (tab === "pulls") { const pulls = useData(`${refreshKey}pulls`, () => execute<Pull[]>("pull.list", { owner, repo })); return <div className="forge-embedded"><PullsTab owner={owner} repo={repo} pulls={pulls} defaultBranch={meta.default_branch} refresh={refresh} /></div>; }
  if (tab === "actions") { const runs = useData(`${refreshKey}actions`, () => execute<CiRun[]>("ci.list", { owner, repo }).catch(() => [])); return <div className="forge-embedded"><ActionsTab owner={owner} repo={repo} runs={runs} defaultBranch={meta.default_branch} refresh={refresh} /></div>; }
  if (tab === "releases") { useData(`${refreshKey}releases`, () => execute<Release[]>("release.list", { owner, repo }).catch(() => [])); return <div className="forge-embedded"><ReleasesTab owner={owner} repo={repo} /></div>; }
  if (tab === "notifications") { useData(`${refreshKey}notifications`, () => execute<Notification[]>("notification.list", { owner, repo, limit: 200 }).catch(() => [])); return <div className="forge-embedded"><NotificationsTab owner={owner} repo={repo} /></div>; }
  return <div className="forge-embedded"><SettingsTab owner={owner} repo={repo} meta={meta} onChanged={refresh} /></div>;
}
export function ForgePullDetailPage() { const { owner, name: repo } = useRepo(); const { number = "0" } = useParams(); return <div className="forge-embedded"><PullDetail owner={owner} repo={repo} number={Number(number)} /></div>; }
