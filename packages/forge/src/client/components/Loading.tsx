import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ApiError } from "../api";
import { useActivity, usePending } from "../data";

export function useBusy(): boolean { return usePending(); }
export function TopProgress() {
  const busy = usePending();
  const activity = useActivity();
  const pct = activity?.percent ?? (activity?.total ? (100 * (activity.done ?? 0)) / activity.total : undefined);
  return <><div className={busy ? "progress on" : "progress"} aria-hidden />{activity && <output className="activity" aria-live="polite"><span className="activity-text">{activity.text}</span>{pct !== undefined && <span className="activity-bar" aria-hidden><span style={{ width: `${Math.min(100, Math.max(0, pct)).toFixed(1)}%` }} /></span>}{pct !== undefined && <span className="muted small">{pct.toFixed(0)}%</span>}</output>}</>;
}
export function Skeleton({ rows = 6, title = true }: { rows?: number; title?: boolean }) {
  return <div className="skeleton" aria-busy="true" aria-live="polite" aria-label="Loading">{title && <div className="sk sk-title" />}<div className="box">{Array.from({ length: rows }, (_, index) => <div key={index} className="sk sk-row" style={{ width: `${55 + ((index * 37) % 40)}%` }} />)}</div></div>;
}
function ErrorBox({ error }: { error: unknown }) {
  const value = error instanceof Error ? error : new Error(String(error));
  const status = value instanceof ApiError ? value.status : undefined;
  return <div className="flash error" role="alert"><strong>{status === 404 ? "Not found" : status ? `Error ${status}` : "Error"}:</strong> {value.message}</div>;
}
type EBProps = { children: ReactNode; resetKey: string };
type EBState = { error?: unknown; key: string };
class ErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown): Partial<EBState> { return { error }; }
  static getDerivedStateFromProps(props: EBProps, state: EBState): Partial<EBState> | null { return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null; }
  componentDidCatch(error: unknown, info: ErrorInfo) { if (!(error instanceof ApiError)) console.error(error, info.componentStack); }
  render() { return this.state.error !== undefined ? <ErrorBox error={this.state.error} /> : this.props.children; }
}
export function RouteBoundary({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}><Suspense fallback={fallback ?? <Skeleton />}>{children}</Suspense></ErrorBoundary>;
}
