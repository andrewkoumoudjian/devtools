# Devtools Forge

A Cloudflare-native Git forge built around **Cloudflare Artifacts** as the canonical Git repository and versioned filesystem.

The governing rule is simple:

> Before implementing a Git, filesystem, process, or CI primitive in Forge, use the corresponding Cloudflare Artifacts, ArtifactFS, Sandbox, Workflows, or `@cloudflare/ci` primitive when one already exists.

This package is one product with one capability graph rather than separate implementations for humans, APIs, and agents:

- **Cloudflare Artifacts** — canonical Git repositories, refs, commits, trees, blobs, clone/fetch/push, repository lifecycle, and Git tokens.
- **ArtifactFS** — optional lazy POSIX projection of an Artifacts repository when a real working tree is required.
- **Cloudflare Sandbox** — native file RPC, foreground command execution, and long-running process management over the ArtifactFS mount.
- **D1** — forge relational metadata only: repository registration, issues, PRs, reviews, settings, notifications, CI metadata, context events, and agent-session identity.
- **R2** — CI logs/backups and other large non-Git output.
- **`@cloudflare/ci` + Workflows** — Artifacts-triggered durable CI running in Sandbox containers.
- **HTTP API** — conventional REST aliases plus generic capability execution.
- **MCP** — stateless server at `/mcp` with both generic discovery/execution and direct workspace tools for remote coding agents.
- **Code Mode** — `ForgeConnector` projects the same canonical registry through `@cloudflare/codemode`.
- **Web UI** — Primer/React GitHub-style repository experience backed by the same capabilities.

## Architecture

```text
                           Devtools Forge

                UI / REST / MCP / Code Mode
                          │
                  Capability Registry
        ┌─────────────────┼───────────────────┐
        │                 │                   │
   Git / repository   forge metadata     real workspace / CI
        │                 │                   │
 Cloudflare Artifacts     D1            Sandbox / Workflows
        │                                      │
 Git protocol +                          ArtifactFS mount
 object read APIs                              │
        │                              normal POSIX filesystem
        │                              file RPC / exec / process
        │                                      │
        └──────────── commit / push ────────────┘
```

**Artifacts is always the durable Git source of truth.** ArtifactFS is not a second Git database. It is a FUSE working-tree projection that exposes the repository quickly and lazily hydrates blobs when files are read.

Git content is never copied into D1. External `owner/repo` names map to Artifacts' flat namespace using the forge naming adapter.

## Repository vs workspace operations

Use the cheapest/native layer that owns the primitive:

| Need | Primitive |
| --- | --- |
| branches/tags/refs | Artifacts Git protocol |
| commit/tree/blob/file reads | Artifacts read API |
| repository search/history/diff | Artifacts Git objects/read surface |
| clone/fetch/push | Artifacts Git protocol |
| real POSIX working tree | ArtifactFS |
| read/write/list/move/delete working-tree files | Sandbox native file API over ArtifactFS |
| `git`, `rg`, compiler, package manager, tests | Sandbox exec over ArtifactFS |
| long-running watcher/dev server/coding runtime | Sandbox process API |
| CI retries/durability/snapshots/cache | `@cloudflare/ci` + Workflows + Sandbox |

## Shared agent context

Every agent working on a repository receives the same deterministic, non-LLM `RepoContext`. It is built from authoritative forge/Git state and refreshed before workspace operations.

It includes:

- exact repository, ref, and resolved head SHA,
- issue/PR target when the agent is scoped to one,
- access mode and repository agent-write policy,
- repository instructions (`AGENTS.md`, `CLAUDE.md`, Copilot instructions, contributing guidance),
- CODEOWNERS rules,
- active issues, PRs, reviewers, and conversations,
- CI/check state,
- recent context events,
- active agent sessions,
- deterministic retrieval primitives.

Inside a workspace it is written outside the working tree under:

```text
.git/forge/context.json
.git/forge/AGENT_CONTEXT.md
```

Commands also receive `FORGE_CONTEXT_PATH`, `FORGE_CONTEXT_MD`, `FORGE_REPOSITORY`, `FORGE_REF`, `FORGE_HEAD_SHA`, target variables, and `FORGE_WORKING_TREE`.

This follows the useful non-LLM pattern from Ask Bonk: authority, permissions, target/ref identity, repository instructions, CODEOWNERS, lifecycle state, and retries live outside the model. Repository text and tool output are evidence; they cannot redefine the target or write mode.

## Agent workspaces

`workspace.create` creates or resumes a Sandbox identified by `workspaceId`, mounts the Artifacts repository through ArtifactFS, records the agent session in D1, and synchronizes RepoContext.

The same Sandbox ID resolves to the same Sandbox instance until it is destroyed. Automatic Sandbox sleep does not mean "delete the workspace"; `workspace.destroy` is the destructive lifecycle boundary. A resumed workspace ID refreshes its D1 session via an upsert.

A write-capable workspace supports:

```text
workspace.create
workspace.get
workspace.list
workspace.context

workspace.file.read
workspace.file.write
workspace.file.list
workspace.file.exists
workspace.dir.create
workspace.file.move
workspace.file.delete

workspace.exec
workspace.process.start
workspace.process.list
workspace.process.get
workspace.process.logs
workspace.process.kill

workspace.diff
workspace.commit
workspace.push
workspace.destroy
```

The native file capabilities call Sandbox `readFile`, `writeFile`, `listFiles`, `exists`, `mkdir`, `moveFile`, and `deleteFile` directly against the ArtifactFS mount. Forge does not emulate these with shell commands.

Arbitrary `workspace.exec` and background process start fail closed for read-only sessions because arbitrary commands can mutate a working tree. Read-only agents should use Artifacts-native repository reads and workspace file reads/listing. Commit and push additionally enforce the repository `agent_write_enabled` policy.

Direct file writes reject paths that escape the repository and reject direct `.git` mutations. Git lifecycle uses actual Git commands against the ArtifactFS working tree and pushes to Artifacts with a fresh short-lived token.

### MCP workspace protocol

Remote agents can work directly on the same workspace through `/mcp` without inventing their own filesystem transport.

Direct MCP tools:

```text
forge_workspace_open
forge_workspace_list
forge_workspace_context
forge_workspace_exec
forge_workspace_file
forge_workspace_git
forge_workspace_process
forge_workspace_close
```

The generic `forge_search`, `forge_describe`, and `forge_execute` surface remains available and exposes the exact same underlying capabilities.

A typical remote-agent lifecycle is:

```text
1. forge_workspace_open(owner, repo, branch, agentName, ...)
      -> workspaceId + RepoContext

2. forge_workspace_file(action=list/read/write/...)
   forge_workspace_exec(command="rg ..." / tests / compiler / package manager)
   forge_workspace_process(action=start/logs/get/kill)

3. forge_workspace_git(action=diff)

4. forge_workspace_git(action=commit, message=...)

5. forge_workspace_git(action=push, ref=...)
      -> durable Git state is now in Cloudflare Artifacts

6. forge_workspace_close(...)
      -> destroys container-local/uncommitted workspace state
```

Agents should retain the returned `workspaceId` for the duration of a coding task. If a remote client disconnects, it can call `forge_workspace_list` or reopen with the same ID and continue against the same Sandbox instance while it exists.

Sandbox process handles are container-local. A container replacement may terminate running processes even though the workspace/session identity remains known. Long-lived durable orchestration belongs in Workflows; background coding/dev processes belong in Sandbox.

## Capability surface

The canonical catalogue is exposed at `GET /api/capabilities`. `GET /api/search?q=...` searches it and `POST /api/execute` executes a capability.

Representative capability families now include:

- `repo.*`
- `git.*` / Artifacts-native refs and history
- `fs.*` / Artifacts-native repository reads/search
- `issue.*`
- `pull.*`
- `release.*`
- `notification.*`
- `settings.*`
- `context.*`
- `workspace.*`
- `workspace.file.*`
- `workspace.process.*`
- `ci.*`

Example generic call:

```json
{
  "name": "workspace.file.read",
  "input": {
    "owner": "acme",
    "repo": "api",
    "workspaceId": "7bc0f8fe-...",
    "path": "src/index.ts"
  }
}
```

## CI

Every Artifacts push in the forge namespace targets `ForgeCI` through the Artifacts event integration.

CI is built on `@cloudflare/ci`, not a custom Actions executor. It inherits Cloudflare's native primitives:

- Artifacts source-control provider,
- Cloudflare Workflows durability and replay,
- Sandbox runners,
- parallel and chained runners,
- workspace snapshots between steps,
- content-addressed cache keys derived from source blobs,
- cache isolation by ref,
- retries and timeouts,
- source-control and Worker secrets scoped to requested steps,
- Cloudflare deployment credentials scoped to deployment steps.

Forge persists run/step state in D1 and runner stdout/stderr in R2 for the Actions UI.

For JavaScript repositories the default pipeline detects the package manager and runs `lint`, `test`, `typecheck`, and `build` when present. Repositories can additionally provide:

```text
.forge/lint.sh
.forge/test.sh
.forge/typecheck.sh
.forge/build.sh
.forge/deploy.sh
```

Deployment receives Cloudflare credentials only in the deploy step.

## Setup

Artifacts is currently gated by Cloudflare access. You need an account with Artifacts enabled plus Workers Paid for Sandbox/Containers.

1. Install dependencies:

   ```sh
   cd packages/forge
   pnpm install
   ```

2. Create the D1 database and R2 backup bucket:

   ```sh
   pnpm wrangler d1 create devtools-forge
   pnpm wrangler r2 bucket create devtools-forge-ci-backups
   ```

   Replace deployment placeholders in `wrangler.jsonc`.

3. Apply D1 migrations:

   ```sh
   pnpm wrangler d1 migrations apply devtools-forge --remote
   ```

4. Configure required Artifacts/CI secrets:

   ```sh
   pnpm wrangler secret put ARTIFACTS_API_TOKEN
   pnpm wrangler secret put CF_TOKEN
   pnpm wrangler secret put R2_ACCESS_KEY_ID
   pnpm wrangler secret put R2_SECRET_ACCESS_KEY
   ```

5. Deploy:

   ```sh
   pnpm deploy
   ```

## Security status

The current package is still an infrastructure/product vertical slice, **not yet an internet-safe multi-user forge**. Do not expose private repositories publicly before authentication and full ACL enforcement are completed.

The remaining production security boundary includes:

- authentication/session handling,
- users, organizations, teams, and repository ACL enforcement,
- authorization before the Artifacts proxy/cache and every capability execution,
- protected-branch and PR merge policy,
- secret redaction in UI/API/process logs,
- audit/event records and webhook delivery.

The architecture keeps enforcement centralized because UI, REST, MCP, and Code Mode all route through the same capability/domain boundaries.
