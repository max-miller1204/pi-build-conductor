# pi-build-conductor

[![CI](https://github.com/max-miller1204/pi-build-conductor/actions/workflows/ci.yml/badge.svg)](https://github.com/max-miller1204/pi-build-conductor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-8a76b5)](https://pi.dev)

`pi-build-conductor` turns a change request into an isolated, dependency-aware multi-agent orchestration run for [Pi](https://pi.dev).
It plans the work, asks for explicit approval, coordinates parallel workers, validates every change, integrates accepted commits on a separate branch, runs independent review and repair passes, and produces merge-ready evidence.

For strict change workflows, the orchestrator owns the Git history and lifecycle from start to finish.
Workers never merge into the user's branch, worker-created commits are rejected, and no repository mutation begins before the plan is approved.

## Features

- Provides plan-only, read-only investigation, and strict change workflows.
- Builds and edits a repository-validated task DAG from a request file.
- Schedules typed investigation, change, command, and approval steps with explicit dependencies, locks, timeouts, retries, and least-authority capabilities.
- Routes declared outputs through immutable, hash-bound artifacts and gives dependent steps only their explicit inputs.
- Runs two to four implementation, review, and repair workers concurrently.
- Gives mutating workers dedicated branches and worktrees, while read-only workers use detached branchless worktrees.
- Dispatches tasks deterministically as their dependencies become ready.
- Restricts each implementation task to explicitly approved repository paths and validation commands.
- Inspects worker diffs, runs focused checks, and creates orchestrator-owned commits.
- Integrates accepted commits in dependency order on `conductor/<run-id>/integration` without touching the checked-out branch.
- Runs fresh correctness, security, maintainability, test, and documentation reviews.
- Automatically repairs critical, high, and high-confidence medium findings, then ensures all five review categories cover the final integration head.
- Runs the approved complete validation suite in a detached worktree at the exact integration head.
- Persists atomic run state, immutable plan revisions, bounded worker journals, validation evidence, and merge-ready reports.
- Recovers safely after interruption and supports inspection, retry, cancellation, and conservative cleanup.
- Freezes capability profiles into every new run and verifies the resulting least-authority tool policy with the compatible Pi server.
- Supports optional fail-closed [Nono](https://github.com/always-further/nono) sandboxing for validation commands.

## Requirements and compatibility

| Component | Supported version | Notes |
| --- | --- | --- |
| Node.js | 22.19.0 or newer | Enforced by `package.json` |
| Pi coding agent | 0.83.0 | Pi core packages are declared as `*` peers as required by Pi package conventions, while release tests use this exact version |
| Pi server | [`b713633`](https://github.com/max-miller1204/pi/commit/b713633149eae9f14bac029af4938b6476d8202d), based on Pi 0.83.0 | Required for worker launch policy version 1 and ESM RPC entry resolution |
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
git checkout b713633149eae9f14bac029af4938b6476d8202d
npm ci --ignore-scripts
npm run build
npm exec --workspace packages/server -- server serve
```

The orchestrator connects to `$PI_SERVER_DIR/server.sock` when `PI_SERVER_DIR` is set.
Otherwise it uses `${PI_CONFIG_DIR:-$HOME/.pi}/server/server.sock`.

## Quick start

Create a request that describes the outcome, constraints, and acceptance criteria:

```md
# Add health checks

Add a health endpoint to the API.
Keep the existing routing style, add focused tests, and update the operator documentation.
The complete test and lint suite must pass.
```

Start Pi in a clean Git worktree with a model selected, then run:

```text
/orchestrate docs/health-check-request.md
```

The orchestrator generates a plan unless `docs/health-check-request.md.plan.json` exists.
Add `docs/health-check-request.md.envelope.json` to approve the run's authority before any plan exists; the run is then frozen under exactly that envelope.
Review the final approval summary and confirm its authority envelope before approving.
Repository mutation starts only after explicit approval.

When the run completes, inspect its integration branch and evidence:

```text
/orchestrate-show <run-id>
```

The user branch remains at its original commit.
Merge or cherry-pick the integration branch only after reviewing the result.

## How an orchestration run works

1. The orchestrator verifies that the current Git worktree is clean and reads the request.
2. It loads a plan sidecar or asks the selected Pi model to produce a dependency DAG.
3. It validates the plan and stores the first immutable revision under the repository's Git common directory.
4. The interactive editor can change tasks, dependencies, order, paths, commands, title, and worker limit.
5. A final approval screen shows the exact plan revision and the authority envelope the run is frozen under: its outcome, acceptance criteria, repository capabilities and mutable paths, forbidden actions and external effects, sandbox policy, validation expectations, and decisions reserved for the user. An authored envelope is that source; without one, the authority the approved plan implies is read back into the same shape.
6. After approval, the orchestrator creates a separate integration branch and dispatches ready tasks to isolated worktrees.
7. It monitors worker events, answers blocked UI requests conservatively, enforces timeouts, and records bounded activity journals.
8. It rejects unexpected Git state, out-of-scope changes, conflicts, worker commits, and checks that mutate worker output.
9. It creates validated task commits and cherry-picks them onto the integration branch in deterministic dependency order.
10. Five fresh read-only reviewers inspect the integrated result.
11. Important findings go through isolated repair, after which all five review categories cover the resulting integration head.
12. The approved final commands run in a detached worktree at the exact integration head.
13. Completion requires passing checks, strict linear integration history, a clean validation worktree, and proof that the user's branch and worktree were untouched.

Before approval, repository profiling reads only committed Git objects and any planning worker has read-only authority.
The orchestrator persists restart-safe metadata and valid plan revisions, but does not create integration refs or mutating worktrees, start mutating workers, or run plan validation commands.

## Commands

| Command | Purpose |
| --- | --- |
| `/orchestrate <request-file>` | Create, review, approve, and start an orchestration run |
| `/orchestrate-plan <request-file>` | Propose an evidence-backed plan without executing it |
| `/orchestrate-investigate <request-file>` | Investigate repository questions and synthesize a read-only report |
| `/orchestrate-list` | List repository-scoped runs and open the interactive inspector |
| `/orchestrate-show <run-id>` | Show the run summary and merge-ready evidence |
| `/orchestrate-show <run-id> step <step-id>` | Show one workflow step and its attempts |
| `/orchestrate-show <run-id> attempt <attempt-id>` | Show one attempt, its Git state, checks, and bounded output tail |
| `/orchestrate-follow <run-id> [attempt-id]` | Replay or follow a worker activity journal |
| `/orchestrate-resume <run-id>` | Reconcile and continue an interrupted run |
| `/orchestrate-retry <run-id> [step-id]` | Retry safe failed step work or failed final validation |
| `/orchestrate-cancel <run-id>` | Stop active work and retain inspectable state |
| `/orchestrate-prune <run-id>` | Remove only proven-clean disposable resources from a terminal run |

Every command is also available under its legacy `/build*` name as a temporary alias.
The plan-only and investigation commands require a clean repository, inspect only committed `HEAD` from detached branchless worktrees, and store their results as artifacts without creating an integration branch.
Use `/orchestrate-resume`, not `/orchestrate-retry`, after a process or daemon interruption.
Resume first reconciles durable attempts, commits, artifacts, branches, and worktrees before launching new work.
An interrupted engine step is adopted only when its commit, declared outputs, and required passing validation evidence can be proved; otherwise resume runs that step and its blocked descendants again.

Step-phase retry creates new attempts for all failed steps in the retry set and their blocked descendants while preserving history.
Final-validation retry creates a new detached attempt for the already approved complete suite.

Inspection reads a run from whichever record executed it.
A run started by the workflow engine is read from its durable workflow snapshot and published artifacts, so its steps, review rounds, findings, and attempts are the engine's own record rather than a copy of it; `step <step-id>` names an engine step such as `implementation`, `review-2-security`, or `repair-1`, and `task <task-id>` remains accepted as a compatibility alias.
A run that executed under the legacy orchestrator is read from the stored run and keeps the same vocabulary, but its review and repair phases cannot be retried, because restarting one needs round coordination that lifecycle never had.

Cancellation is idempotent.
Pruning retains the integration branch, source-evidence branches, snapshots, journals, dirty worktrees, and any resource whose commit cannot be proven safe to remove.

## Authority envelope sidecar

Add `<request-file>.envelope.json` to approve the run's authority before its work is known.

The envelope is then the source the run derives from, and it is frozen when the run is created.
Its capabilities narrow every worker profile and tool allowlist, its approved paths bound every mutating step, its withheld paths are rejected against observed worker output even inside an approved subtree, and its required commands must appear in the plan's final validation.

```json
{
  "version": 1,
  "outcome": "Add health checks to the service",
  "acceptanceCriteria": [
    "The documented status payload is served",
    "npm run check passes"
  ],
  "repositories": [
    {
      "root": "/home/you/service",
      "mutation": {
        "capabilities": ["read-repository", "mutate-repository", "execute-commands"],
        "allowedPaths": ["src/", "test/", "docs/health.md"],
        "forbiddenPaths": ["src/generated/"]
      }
    }
  ],
  "forbiddenActions": ["Never change the release workflow"],
  "externalEffects": "forbidden",
  "sandbox": { "workers": "worktree-only", "validation": "none" },
  "validation": {
    "required": [{ "command": "npm", "args": ["run", "check"] }],
    "perChange": true
  },
  "escalation": {
    "conditions": [
      "add-repository",
      "widen-mutation-authority",
      "change-acceptance-criteria",
      "skip-required-validation",
      "external-effect"
    ],
    "reservedDecisions": ["Choosing the published endpoint path"]
  }
}
```

Every absent optional field resolves to the least authority it can express, and an unknown field is rejected rather than ignored, so a misspelled deny list fails loudly instead of silently widening authority.
The reserved escalation conditions are a floor an envelope cannot declare its way below, and only one repository may be named until multi-repository parent orchestration lands.

A plan that would mutate outside the approved paths, mutate a withheld path, declare a capability the envelope withholds, drop a required validation command, or run in a repository the envelope does not name is refused when the run is created, and refused again for any later plan revision.
The approval summary shows the frozen envelope and its digest.

Without this sidecar a run still freezes an envelope: the authority its approved plan already implies, read back and stated in the same shape.

A run frozen under an envelope can also grow inside it.
A running step may propose further steps, and they are admitted only when the frozen envelope already allows them, so a session decides what work is needed while the user keeps deciding what authority it holds.
Growth is append-only and bounded: approved steps, their order, and the validation the run settles on never change, each admitted step is recorded on the run timeline with the step that proposed it and why, and a graph that grew is durable and recoverable exactly like one that was approved whole.
A run with no frozen envelope cannot grow at all.

## Plan sidecar

Add `<request-file>.plan.json` to provide a deterministic plan instead of generating one with the model.
The live `/orchestrate` path continues to accept task-plan sidecar schema version 3 during the staged engine migration:

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
      "validationCommands": [
        {
          "command": "npm",
          "args": ["run", "lint:docs"]
        }
      ]
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

The reusable engine can translate this legacy schema into version 4 change steps.
Its version 4 workflow schema also supports investigation, command, and approval steps.
Steps can declare inputs, outputs, capabilities, path and resource locks, timeouts, and bounded retries; omitted fields use least-authority defaults for their step kind.

The plan editor supports node creation, editing, renaming, removal, and reordering; dependency editing; final-command editing; worker-limit selection; full JSON editing; and restoration from immutable revision history.
Every candidate is validated before persistence.
Invalid candidates cannot be approved and never enter plan history.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `PI_ORCHESTRATOR_MAX_CONCURRENT_WORKERS` | `2` | Initial worker limit, from 2 through 4; the approved plan can change it |
| `PI_ORCHESTRATOR_WORKER_TIMEOUT_MS` | `3600000` | Timeout for one worker execution |
| `PI_ORCHESTRATOR_VALIDATION_TIMEOUT_MS` | `600000` | Timeout for each focused task or repair command |
| `PI_ORCHESTRATOR_FINAL_VALIDATION_TIMEOUT_MS` | `1800000` | Timeout for each final validation command |
| `PI_ORCHESTRATOR_WORKER_UI_POLICY` | `decline` | `decline` rejects confirmations and cancels other dialogs; `cancel` cancels all supported dialogs |
| `PI_ORCHESTRATOR_VALIDATION_SANDBOX` | `none` | Validation mode: `none` or `nono` |
| `PI_ORCHESTRATOR_NONO_PATH` | unset | Absolute path to Nono, required only when the sandbox mode is `nono` |
| `PI_SERVER_DIR` | Pi server config directory | Directory containing `server.sock` |
| `PI_CONFIG_DIR` | `$HOME/.pi` | Pi configuration root and orchestrator worktree root |

Every `PI_ORCHESTRATOR_*` setting also accepts its legacy `PI_BUILD_*` name as a temporary alias, and conflicting values fail closed.
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
Every repair that changes the integration head is followed by all five fresh reviews.
When a repair changes no bytes, the next round adopts the previous findings for that identical commit instead of launching redundant reviewers.
The run allows at most two successful repair and re-review cycles.

## Security

> [!WARNING]
> Git worktrees isolate source history, not the operating system.
> Worker Pi processes are unsandboxed and retain host filesystem and network reachability.

The compatible server applies the versioned worker discovery restrictions described in
the [`SECURITY.md` worker-authority section](SECURITY.md#worker-authority).
The orchestrator freezes capability profiles at run creation, narrows them to each step's declarations, and verifies the resulting server tool-policy attestation before accepting a worker.
Read-only profiles cannot use Bash or mutation tools, while change and repair profiles retain only the command and mutation tools their approved work requires.
No capability profile grants deployment, publishing, cloud administration, or remote mutation authority.

Focused and final commands receive a fresh temporary home, reduced credential-free environment, disabled Git credential prompting, bounded output, and process-group termination.
That reduced environment is not a filesystem or network sandbox.

Set `PI_ORCHESTRATOR_VALIDATION_SANDBOX=nono` and `PI_ORCHESTRATOR_NONO_PATH=/absolute/path/to/nono` to sandbox validation.
The orchestrator grants the worktree read-only access, grants a temporary runtime directory, blocks network access, and fails without an unsandboxed fallback if Nono cannot start.

Run the orchestrator under a dedicated low-privilege account or in a disposable virtual machine for untrusted repositories.
Remove cloud, package registry, SSH, signing, and deployment credentials from the execution environment.
Do not put secrets in requests, repository files, prompts, worker output, or attempt logs.

Read [`SECURITY.md`](SECURITY.md) before approving a run.
It defines the complete trust model, worker authority, validation boundary, residual risks, and vulnerability reporting process.
Merge-ready evidence proves recorded Git and validation facts, not the absence of host, credential, network, cloud, or external side effects.

## State, branches, and worktrees

Run state is stored outside the checked-out tree at:

```text
<git-common-dir>/pi-orchestrator/runs/<run-id>.json
```

Worker journals are stored below the same run directory in `output/` and are capped at 5 MiB each.
A legacy `<git-common-dir>/pi-build-conductor` directory is migrated to the new location automatically the first time a command touches run storage.
Immutable workflow artifacts are stored by run below `<git-common-dir>/pi-orchestrator/artifacts/`.
Workflow engine runs, including new `/orchestrate` change runs, execute from versioned snapshots below `<git-common-dir>/pi-orchestrator/workflow-runs/`, which are the authoritative execution record and allow recovery after a restart.
For change runs, the corresponding `runs/` record holds only what the snapshot does not: the request, plan history, approval, security policy, final-validation attempts, and the run's terminal outcome and merge-ready evidence.
No execution state is copied onto it: steps, attempts, and review rounds are read from the engine snapshot, while review findings are read from their published workflow artifacts.
Runs with legacy execution state and no workflow snapshot remain on the legacy execution path and are read from the stored run itself.
Orchestrator worktrees are stored at:

```text
${PI_CONFIG_DIR:-$HOME/.pi}/orchestrator/worktrees/<repository-hash>/
```

Worktrees created before the rename stay under `${PI_CONFIG_DIR:-$HOME/.pi}/build-conductor/worktrees/` and remain fully recoverable and prunable there, because moving an existing Git worktree would break its metadata.

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
