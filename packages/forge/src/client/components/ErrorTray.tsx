import { dismissError, useErrors } from "../data";
export function ErrorTray() {
  const errors = useErrors();
  if (errors.length === 0) return null;
  return <div className="error-tray" role="alert" aria-live="assertive">{errors.map((error) => <div key={error.id} className="error-item"><div className="error-text">{error.status ? <span className="pill">HTTP {error.status}</span> : null} {error.text}</div><button type="button" className="btn small" onClick={() => dismissError(error.id)} aria-label="Dismiss">×</button></div>)}{errors.length > 1 && <button type="button" className="btn small dismiss-all" onClick={() => dismissError()}>dismiss all</button>}</div>;
}
