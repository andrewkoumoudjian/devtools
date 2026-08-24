import { Suspense, lazy } from "react";
const Renderer = lazy(() => import("./MarkdownRenderer"));
export function Markdown({ source }: { source: string }) {
  return <div className="markdown-body"><Suspense fallback={<pre className="code-block">{source}</pre>}><Renderer source={source} /></Suspense></div>;
}
