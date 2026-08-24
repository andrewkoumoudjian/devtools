/** Human-readable formatting helpers (ported from walgit/web). */
export function relTime(iso: string): string {
  let value = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const steps: [number, string][] = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"], [Infinity, "year"]];
  for (const [divisor, name] of steps) {
    if (Math.abs(value) < divisor) return `${value} ${name}${Math.abs(value) === 1 ? "" : "s"} ago`;
    value = Math.round(value / divisor);
  }
  return iso;
}

export function fmtSize(n: number): string {
  if (n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
