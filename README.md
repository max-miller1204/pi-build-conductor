# pi-build-conductor

[![CI](https://github.com/max-miller1204/pi-build-conductor/actions/workflows/ci.yml/badge.svg)](https://github.com/max-miller1204/pi-build-conductor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-8a76b5)](https://pi.dev)

`pi-build-conductor` turns a build handoff into an isolated, dependency-aware multi-agent implementation run for [Pi](https://pi.dev).
It plans the work, asks for explicit approval, coordinates parallel workers, validates every change, integrates accepted commits on a separate branch, runs independent review and repair passes, and produces merge-ready evidence.

The conductor owns the Git history and lifecycle from start to finish.
Workers never merge into the user's branch, worker-created commits are rejected, and no execution side effects begin before the plan is approved.

## Features

- Builds and edits a validated task DAG from a handoff file.
- Runs two to four implementation, review, and repair workers concurrently.
- Gives every worker a dedicated branch and Git worktree.
- Dispatches tasks deterministically as their dependencies become ready.
- Restricts each implementation task to explicitly approved repository paths and validation commands.
- Inspects worker diffs, runs focused checks, and creates conductor-owned commits.
- Integrates accepted commits in dependency order on `conductor/<run-id>/integration` without touching the checked-out branch.
- Runs fresh correctness, security, maintainability, test, and documentation reviews.
- Automatically repairs critical, high, and high-confidence medium findings, then repeats all reviews.
- Runs the approved complete validation suite in a detached worktree at the exact integration head.
- Persists atomic run state, immutable plan revisions, bounded worker journals, validation evidence, and merge-ready reports.
- Recovers safely after interruption and supports inspection, retry, cancellation, and conservative cleanup.
- Negotiates and verifies a fixed worker launch policy with the compatible Pi server.
- Supports optional fail-closed [Nono](https://github.com/always-further/nono) sandboxing for validation commands.

## Requirements and compatibility

| Component | Supported version | Notes |
| --- | --- | --- |
| Node.js | 22.19.0 or newer | Enforced by `package.json` |
| Pi coding agent | 0.81.1 | Pi core packages are declared as `*` peers as required by Pi package conventions, while release tests use this exact version |
| Pi server | [`c08917e`](https://github.com/max-miller1204/pi/commit/c08917e1163c4742ecb7065c099ec57cf5b6c3e5), based on Pi 0.81.1 | Required for worker launch policy version 1 and ESM RPC entry resolution |
| Git | A modern CLI with worktree support | The source repository must have at least one commit |
| Nono | Optional | Used only when validation sandboxing is enabled |

The server protocol is experimental.
All protocol-specific assumptions are isolated in [`src/workers/server-backend.ts`](src/workers/server-backend.ts).
The compatibility workflow builds and tests the exact compatible-server commit recorded in `package.json`.
Moving to another Pi or server commit requires an explicit compatibility metadata and documentation update.

## Install

Install directly from GitHub:

```sh
pi install git:github.com/max-miller1204/pi-build-conductor
```

Restart Pi after installation if it is already running.
The package is not yet published to npm, so GitHub is the supported installation source for the current release.

### Start the compatible Pi server

The first-party server package is not currently published independently to npm.
Build and run the pinned compatible commit:

```sh
git clone https://github.com/max-miller1204/pi.git
cd pi
git checkout c08917e1163c4742ecb7065c099ec57cf5b6c3e5
npm ci --ignore-scripts
npm run build
npm exec --workspace packages/server -- server serve
```

The conductor connects to `$PI_SERVER_DIR/server.sock` when `PI_SERVER_DIR` is set.
Otherwise it uses `${PI_CONFIG_DIR:-$HOME/.pi}/server/server.sock`.

## Quick start

Create a handoff that describes the outcome, constraints, and acceptance criteria:

```md
# Add health checks

Add a health endpoint to the API.
Keep the existing routing style, add focused tests, and update the operator documentation.
The complete test and lint suite must pass.
```

Start Pi in a clean Git worktree with a model selected, then run:

```text
/build docs/health-check-handoff.md
```

The conductor generates a plan unless `docs/health-check-handoff.md.plan.json` exists.
Review the DAG, approved paths, commands, worker limit, validation boundary, and security summary.
Execution starts only after explicit approval.

When the run completes, inspect its integration branch and evidence:

```text
/build-show <run-id>
```

The user branch remains at its original commit.
Merge or cherry-pick the integration branch only after reviewing the result.

## How a build runs

1. The conductor verifies that the current Git worktree is clean and reads the handoff.
2. It loads a plan sidecar or asks the selected Pi model to produce a dependency DAG.
3. It validates the plan and stores the first immutable revision under the repository's Git common directory.
4. The interactive editor can change tasks, dependencies, order, paths, commands, title, and worker limit.
5. A final approval screen shows the exact plan revision and security boundary.
6. After approval, the conductor creates a separate integration branch and dispatches ready tasks to isolated worktrees.
7. It monitors worker events, answers blocked UI requests conservatively, enforces timeouts, and records bounded activity journals.
8. It rejects unexpected Git state, out-of-scope changes, conflicts, worker commits, and checks that mutate worker output.
9. It creates validated task commits and cherry-picks them onto the integration branch in deterministic dependency order.
10. Five fresh read-only reviewers inspect the integrated result.
11. Important findings go through isolated repair and a complete fresh review round.
12. The approved final commands run in a detached worktree at the exact integration head.
13. Completion requires passing checks, strict linear integration history, a clean validation worktree, and proof that the user's branch and worktree were untouched.

Before approval, the conductor persists only restart-safe metadata and valid plan revisions.
It does not create Git refs or worktrees, start workers, or run repository commands.

## Commands

| Command | Purpose |
| --- | --- |
| `/build <handoff-file>` | Create, review, approve, and start a build |
| `/build-list` | List repository-scoped runs and open the interactive inspector |
| `/build-show <run-id>` | Show the run summary and merge-ready evidence |
| `/build-show <run-id> task <task-id>` | Show one task and its attempts |
| `/build-show <run-id> attempt <attempt-id>` | Show one attempt, its Git state, checks, and bounded output tail |
| `/build-follow <run-id> [attempt-id]` | Replay or follow a worker activity journal |
| `/build-resume <run-id>` | Reconcile and continue an interrupted run |
| `/build-retry <run-id> [task-id]` | Retry safe failed task work or failed final validation |
| `/build-cancel <run-id>` | Stop active work and retain inspectable state |
| `/build-prune <run-id>` | Remove only proven-clean disposable resources from a terminal run |

Use `/build-resume`, not `/build-retry`, after a process or daemon interruption.
Resume first reconciles server workers, attempts, commits, branches, and worktrees.

Task-phase retry creates new attempts for all failed tasks in the retry set and their blocked descendants while preserving history.
Final-validation retry creates a new detached attempt for the already approved complete suite.
Review or repair policy failures require a new approved run because retrying them could change the approved authority boundary.

Cancellation is idempotent.
Pruning retains the integration branch, source-evidence branches, snapshots, journals, dirty worktrees, and any resource whose commit cannot be proven safe to remove.

## Plan sidecar

Add `<handoff-file>.plan.json` to provide a deterministic plan instead of generating one with the model.
The current plan schema is version 3:

```json
{
  "version": 3,
  "title": "Add health checks",
  "tasks": [
    {
      "id": "health-route",
      "title": "Implement the health route",
      "description": "Add the endpoint using the existing routing conventions.",
      "dependencies": [],
      "acceptanceCriteria": [
        "The endpoint returns the documented status payload",
        "Focused route tests pass"
      ],
      "allowedPaths": [
        "src/routes/health.ts",
        "test/health.test.ts"
      ],
      "validationCommands": [
        {
          "command": "npm",
          "args": ["test", "--", "test/health.test.ts"]
        }
      ]
    },
    {
      "id": "health-docs",
      "title": "Document the health endpoint",
      "description": "Add operator-facing usage and response details.",
      "dependencies": ["health-route"],
      "acceptanceCriteria": ["The endpoint is documented"],
      "allowedPaths": ["docs/health.md"],
      "validationCommands": []
    }
  ],
  "finalValidationCommands": [
    {
      "command": "npm",
      "args": ["run", "check"]
    }
  ]
}
```

Commands are executable and argument arrays, not shell strings.
They run directly without a shell.
Paths are repository-relative and define the complete mutation scope for each task.

The plan editor supports node creation, editing, renaming, removal, and reordering; dependency editing; final-command editing; worker-limit selection; full JSON editing; and restoration from immutable revision history.
Every candidate is validated before persistence.
Invalid candidates cannot be approved and never enter plan history.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `PI_BUILD_MAX_CONCURRENT_WORKERS` | `2` | Initial worker limit, from 2 through 4; the approved plan can change it |
| `PI_BUILD_WORKER_TIMEOUT_MS` | `3600000` | Timeout for one worker execution |
| `PI_BUILD_VALIDATION_TIMEOUT_MS` | `600000` | Timeout for each focused task or repair command |
| `PI_BUILD_FINAL_VALIDATION_TIMEOUT_MS` | `1800000` | Timeout for each final validation command |
| `PI_BUILD_WORKER_UI_POLICY` | `decline` | `decline` rejects confirmations and cancels other dialogs; `cancel` cancels all supported dialogs |
| `PI_BUILD_VALIDATION_SANDBOX` | `none` | Validation mode: `none` or `nono` |
| `PI_BUILD_NONO_PATH` | unset | Absolute path to Nono, required only when the sandbox mode is `nono` |
| `PI_SERVER_DIR` | Pi server config directory | Directory containing `server.sock` |
| `PI_CONFIG_DIR` | `$HOME/.pi` | Pi configuration root and conductor worktree root |

Invalid configuration fails closed.
The chosen worker UI policy and validation boundary are frozen into each run so retries and recovery cannot silently change them.

The UI policy never selects an option, grants a confirmation, supplies text input, or provides editor content.
Blocked prompt metadata is journaled without recording titles, messages, choices, placeholders, prefills, or response values.

## Review and repair policy

Every successful task integration starts five independent reviews at the exact integration commit:

- correctness
- security
- maintainability
- tests
- documentation

Reviewers have read-only tools and must return a versioned, bounded structured report.
Critical and high findings always require repair.
High-confidence medium findings also require repair.
Lower-priority findings remain visible as deferred risks in the final evidence.

Repairs can modify only the union of paths approved by the plan and must pass the union of focused validation commands.
Every repair is followed by all five fresh reviews.
The run allows at most two successful repair and re-review cycles.

## Security

> [!WARNING]
> Git worktrees isolate source history, not the operating system.
> Implementation and repair workers are unsandboxed Pi processes with host filesystem and network reachability.

The compatible server disables worker extension, skill, prompt-template, and context-file discovery.
It applies fixed role-based tool allowlists and returns an exact launch-policy attestation that the conductor verifies before accepting a worker.
Reviewers cannot use Bash or mutation tools.
Implementation and repair workers retain Bash and mutation tools because they must change and validate code.

Focused and final commands receive a fresh temporary home, reduced credential-free environment, disabled Git credential prompting, bounded output, and process-group termination.
That reduced environment is not a filesystem or network sandbox.

Set `PI_BUILD_VALIDATION_SANDBOX=nono` and `PI_BUILD_NONO_PATH=/absolute/path/to/nono` to sandbox validation.
The conductor grants the worktree read-only access, grants a temporary runtime directory, blocks network access, and fails without an unsandboxed fallback if Nono cannot start.

Run the conductor under a dedicated low-privilege account or in a disposable virtual machine for untrusted repositories.
Remove cloud, package registry, SSH, signing, and deployment credentials from the execution environment.
Do not put secrets in handoffs, repository files, prompts, worker output, or attempt logs.

Read [`SECURITY.md`](SECURITY.md) before approving a run.
It defines the complete trust model, worker authority, validation boundary, residual risks, and vulnerability reporting process.
Merge-ready evidence proves recorded Git and validation facts, not the absence of host, credential, network, cloud, or external side effects.

## State, branches, and worktrees

Run state is stored outside the checked-out tree at:

```text
<git-common-dir>/pi-build-conductor/runs/<run-id>.json
```

Worker journals are stored below the same run directory in `output/` and are capped at 5 MiB each.
Conductor worktrees are stored at:

```text
${PI_CONFIG_DIR:-$HOME/.pi}/build-conductor/worktrees/<repository-hash>/
```

A run uses namespaced branches below `conductor/<run-id>/`.
The integration branch is retained as the merge candidate.
Successful task and repair source branches are retained as evidence.
Failed, dirty, or unexpected worktrees are retained for inspection rather than deleted optimistically.

State updates use cross-process locks, atomic replacement, monotonic revisions, and an exclusive lifecycle lease.
Recovery reconciles transitions that may have completed immediately before a crash, including worker spawn, commit creation, integration, validation, and cleanup.
It fails safely when exact ownership or commit identity cannot be proven.

## Development

```sh
git clone https://github.com/max-miller1204/pi-build-conductor.git
cd pi-build-conductor
npm ci
npm run check
```

Load the checkout directly in Pi:

```sh
pi -e .
```

Useful scripts:

```sh
npm run format:check
npm run docs:check
npm run version:check
npm run typecheck
npm test
npm run test:watch
npm run test:crash-fixture
npm run package:smoke
```

The package smoke test creates an npm tarball, installs it into a clean consumer, and asks the pinned Pi CLI for the registered commands over RPC.
CI also installs the exact pushed GitHub commit with `pi install` and verifies the pinned checkout and extension registration.

Build the pinned Pi checkout and run the credential-free server compatibility smoke locally:

```sh
PI_COMPAT_CHECKOUT=/path/to/pinned/pi npm run test:compatibility
```

Run the optional model-backed upstream tests against an already running compatible service:

```sh
PI_SERVER_SMOKE_SOCKET=/path/to/server.sock npm run test:upstream
```

The regular suite covers DAG validation, scheduling, bounded concurrency, Git isolation, worker lifecycle, review and repair, security policy, validation, crash recovery, run control, journals, and final evidence.
The automated compatibility workflow additionally builds the pinned server fork, runs its policy tests, starts the real socket service, and verifies worker policy negotiation, spawn, status, listing, and shutdown without model credentials.
The optional upstream suite exercises a model-backed prompt and takes one real Pi worker from task prompt to merge-ready evidence.

Release maintainers should follow [`RELEASING.md`](RELEASING.md).
The package uses generated GitHub release notes and keeps npm publishing disabled until the documented bootstrap and trusted-publishing controls are complete.

## License

[MIT](LICENSE)
