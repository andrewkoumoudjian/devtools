# Forge UI architecture

The original vertical slice used a hand-written HTML/CSS/JavaScript shell. That was useful for exercising the capability API, but it was not a suitable product foundation and has been removed.

The current frontend deliberately combines two existing open-source foundations:

1. **GitHub Primer React** (`primer/react`, MIT) for the visual and interaction component system. Primer is GitHub's open-source design system. Forge uses repository-oriented primitives such as `Header`, `UnderlineNav`, `BranchName`, `StateLabel`, `Button`, and Primer Octicons rather than reimplementing GitHub-looking controls.
2. **Cloudflare artifacts-viewer** (MIT) for the repository content browser. `ArtifactRepoViewer` reads the same Cloudflare Artifacts repository used by normal Git clients, through the Worker-side safe Artifacts proxy/cache.

## Product reference: Gitea

`go-gitea/gitea` is the product/interaction reference for forge information architecture because it is a mature GitHub-style forge with a complete open repository UI. We do not port its Go/template backend. We use its repository-page decomposition as a parity checklist:

- owner/repository identity and visibility in a persistent repo header;
- repository-level navigation rather than unrelated demo tabs;
- Code / Issues / Pull requests / Actions as primary repository surfaces;
- branch identity and commit history inside the Code surface;
- clone controls attached to the repository rather than a raw-token utility;
- latest-commit context adjacent to repository browsing;
- stateful issue and pull-request lists with first-class create actions;
- CI run history surfaced as a repository unit.

Gitea also makes clear what is still missing from this first Primer frontend: branch/tag switching, code search/go-to-file, per-file last-commit data, README rendering as a repository landing document, releases, settings, notifications, reviewers, labels/milestones, PR conversation/diff/checks, and complete Actions logs.

## Runtime layout

```text
Vite + React SPA
  ├─ @primer/react + @primer/octicons-react
  ├─ artifacts-viewer/react
  └─ /api/execute
          │
          ▼
      Forge Worker
       ├─ capability registry
       ├─ /artifacts safe read proxy
       ├─ /mcp
       └─ D1 / Artifacts / Workflows / Sandbox
```

The Cloudflare Vite plugin owns development/build integration. Wrangler routes `/api/*`, `/mcp`, `/artifacts/*`, and `/health` through the Worker first; all other unknown paths fall through to SPA assets with `single-page-application` handling.

## Rule

Do not add a second bespoke UI implementation. New forge product surfaces should be built as React views using Primer components and should execute through the canonical forge capability/API boundary. Repository file browsing should remain delegated to `artifacts-viewer` unless a missing capability requires extending that package boundary.
