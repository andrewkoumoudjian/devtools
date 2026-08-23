# Devtools Forge

A Cloudflare-native Git forge built around the new **Cloudflare Artifacts** Git storage.

This package is intentionally one product with one capability graph rather than separate implementations for humans, APIs, and agents:

- **Artifacts** — Git repositories, refs, commits, trees and blobs.
- **ArtifactFS + Sandbox** — mutable POSIX working trees for coding agents and interactive jobs.
- **D1** — forge metadata: repository registration, issues, pull requests, reviews and CI run metadata.
- **`@cloudflare/ci` + Workflows** — push-triggered CI running in Sandbox containers.
- **HTTP API** — conventional REST aliases plus a generic capability execution API.
- **MCP** — stateless SDK v2 server at `/mcp` exposing `forge_search`, `forge_describe`, and `forge_execute`.
- **Code Mode** — `ForgeConnector` projects the same capability registry through `@cloudflare/codemode`.
- **Web UI** — repository dashboard, creation flow, code browser, commits, issues and pull-request views.

## Architecture

```text
                         Devtools Forge Worker
                  ┌──────────────────────────────┐
                  │ UI  REST  MCP  Code Mode     │
                  └──────────────┬───────────────┘
                                 │
                       Capability Registry
                ┌────────────────┼──────────────────┐
                │                │                  │
          repository/fs      forge metadata      workspace/CI
                │                │                  │
         Cloudflare Artifacts   D1          Workflows + Sandbox
                │                                   │
          Git smart HTTP                       ArtifactFS mount
                                                    │
                                             normal POSIX + git
```

Git content is never duplicated into D1. `owner/repo` names are represented externally as normal forge names and encoded to Artifacts' flat namespace as `owner__repo`.

## Capability surface

The initial vertical slice includes:

- `repo.list`, `repo.get`, `repo.create`, `repo.import`, `repo.delete`, `repo.token.create`
- `git.log`, `git.commit.get`, `git.tree`
- `fs.read`
- `issue.list`, `issue.create`
- `pull.list`, `pull.create`
- `workspace.create`, `workspace.exec`, `workspace.diff`, `workspace.commit`, `workspace.push`, `workspace.destroy`
- `ci.run`

`GET /api/capabilities` is the machine-readable catalogue. `GET /api/search?q=...` searches it and `POST /api/execute` executes one capability:

```json
{
  "name": "fs.read",
  "input": {
    "owner": "acme",
    "repo": "api",
    "ref": "main",
    "path": "src/index.ts"
  }
}
```

MCP deliberately exposes only three tools so the model does not ingest a schema for every operation at once. Code Mode uses the same discovery/execution shape.

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

   Replace `REPLACE_WITH_D1_DATABASE_ID` and the Cloudflare account ID placeholders in `wrangler.jsonc`.

3. Apply D1 migrations:

   ```sh
   pnpm wrangler d1 migrations apply devtools-forge --remote
   ```

4. Create the secrets used by the Artifacts REST read surface and CI deployment steps:

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

## CI

Every Artifacts push in the `devtools-forge` namespace targets `ForgeCI`. For JavaScript repositories the default pipeline detects the package manager, installs dependencies, and runs `lint`, `test`, `typecheck`, and `build` when those scripts exist.

A repository can override/extend the generic behavior with executable scripts under `.forge/`:

```text
.forge/lint.sh
.forge/test.sh
.forge/typecheck.sh
.forge/build.sh
.forge/deploy.sh
```

Deployment receives Cloudflare credentials only in the deploy step.

## Workspaces

`workspace.create` mints a one-hour write token, starts an isolated Sandbox, and mounts the Artifacts remote through ArtifactFS. The token is installed as an HTTP extra header inside the sandbox rather than embedded in the remote URL. `workspace.push` refreshes the token before pushing.

This gives coding agents a normal filesystem and normal Git commands without making a Durable Object or D1 impersonate a repository filesystem.

## Security status

This first slice is an infrastructure vertical slice, **not yet an internet-safe multi-user forge**. Do not expose private repositories publicly yet. Before public deployment the next tranche must add:

- authentication/session handling (Cloudflare Access or first-party OAuth),
- users, organizations, teams and repository ACL enforcement,
- authorization checks before the Artifacts proxy/cache and every capability execution,
- protected-branch and pull-request merge policy,
- secret redaction in UI/API logs,
- audit/event records and webhook delivery.

The architecture keeps that enforcement centralized: policy belongs immediately before `capabilityRegistry.execute()` and in the Artifacts read proxy, so UI/API/MCP/Code Mode cannot diverge.
