# pi-build-conductor

`pi-build-conductor` is a Pi package for turning a build handoff into isolated, dependency-aware implementation work.

The current vertical slice reads a handoff, generates or loads a validated task DAG, lets the user edit and explicitly approve it, launches a bounded pool of isolated workers, integrates validated task commits, and runs independent review and repair passes through the official experimental Pi orchestrator.

## Status

This repository is an early MVP.

Implemented:

- `/build <handoff-file>`, `/build-resume <run-id>`, and `/build-cancel <run-id>` Pi commands
- Planning through the selected Pi model
- Optional `<handoff-file>.plan.json` sidecar loading
- Editable plan and explicit approval gate
- DAG validation and deterministic scheduling
- Durable, atomic run-state storage and interrupted-attempt recovery
- Git branch and worktree isolation
- A narrow `WorkerBackend` interface
- An adapter for the official orchestrator JSONL socket API
- Deterministic launch and live lifecycle monitoring with a worker limit configured from two through four
- Dependency-aware pool refill as tasks succeed and unblock downstream work
- Duplicate-dispatch prevention and durable active-attempt invariants
- Worker completion and failure detection through orchestrator events and status checks
- Execution timeouts, explicit cancellation, and deterministic process cleanup
- Approved per-task path scopes and focused validation commands
- Conductor-controlled diff inspection, focused checks, and coherent task commits
- Durable changed-file, diff fingerprint, check, and commit evidence
- Deterministic sequential cherry-pick integration on a separate branch
- Dependency worktrees refreshed from the latest integrated dependency commits
- Conflict-safe detached integration without changing the user branch
- Five fresh independent reviewer agents for correctness, security, maintainability, tests, and documentation
- Strict, versioned, bounded reviewer reports with deterministic finding identifiers
- Deterministic finding prioritization and isolated repair attempts for important findings
- Conductor-owned repair validation, commits, integration, and fresh post-repair review rounds
- Successful worktree cleanup with failed worktrees retained for inspection
- Live Pi status and widget updates for task, review, repair, and terminal state
- Tests for DAG validation, scheduling, recovery, Git isolation, validation, conductor-owned commits, integration, review, repair, worker launch, completion, failure, timeout, and cancellation

Final full-suite validation and merge-ready evidence are the next implementation stage.

## Architecture

- `src/domain` contains run, task, attempt, and DAG state without process or UI dependencies.
- `src/storage` persists versioned run snapshots under the repository's Git common directory.
- `src/git` owns branch, diff inspection, commit, cherry-pick, and worktree operations.
- `src/validation` enforces approved task scope and runs focused checks without a shell.
- `src/workers` isolates the experimental orchestrator protocol behind `WorkerBackend`.
- `src/planning` calls the selected Pi model and validates its JSON plan.
- `src/review` defines reviewer prompts, the structured report protocol, and deterministic repair policy.
- `src/conductor.ts` coordinates durable state transitions, Git isolation, worker launch, review, and repair.
- `src/extension.ts` provides the build, approval, and recovery commands.

The orchestrator adapter is based on the first-party API at upstream commit [`c889eb8`](https://github.com/earendil-works/pi/blob/c889eb8809a0f40ccd937dc915b10147bec39115/packages/orchestrator/src/ipc/protocol.ts).

All assumptions about that experimental API are confined to `src/workers/orchestrator-backend.ts`.

## Installation

Requirements:

- Node.js 22.19 or newer
- Pi 0.80.10 or newer
- Git
- The first-party `@earendil-works/pi-orchestrator` service

Install directly from GitHub:

```bash
pi install git:github.com/max-miller1204/pi-build-conductor
```

For local development:

```bash
git clone https://github.com/max-miller1204/pi-build-conductor.git
cd pi-build-conductor
npm install
npm run check
pi -e .
```

The upstream orchestrator package is experimental and is not currently published to the public npm registry.

Use the maintained [`orchestrator-compat`](https://github.com/max-miller1204/pi/tree/orchestrator-compat) branch until the required fixes are available upstream:

```bash
git clone --branch orchestrator-compat https://github.com/max-miller1204/pi.git
cd pi
npm ci --ignore-scripts
npm run build
npm exec --workspace packages/orchestrator -- orchestrator serve
```

The fork's `main` branch remains synchronized with `earendil-works/pi`.
The compatibility branch resolves `@earendil-works/pi-coding-agent/rpc-entry` with ESM import conditions and restores the packaged `orchestrator` CLI executable.

The optional upstream smoke test exercises a real service from spawn through shutdown.

## MVP workflow

Run:

```text
/build docs/handoff.md
```

The command performs these steps:

1. Reads the handoff and verifies that the current Git worktree is clean.
2. Loads `docs/handoff.md.plan.json` when present, otherwise asks the selected Pi model to generate a plan.
3. Validates task identifiers, dependencies, and cycle freedom.
4. Opens the JSON plan for editing.
5. Requires explicit approval.
6. Saves restart-safe run state under `.git/pi-build-conductor/runs/`.
7. Creates `conductor/<run-id>/integration` without checking it out.
8. Selects ready tasks in deterministic plan order, up to the configured concurrency limit.
9. Creates a separate task branch and worktree under `~/.pi/build-conductor/worktrees/` for each selected task.
10. Spawns an independent Pi instance for each task through the official orchestrator and sends its task prompt.
11. Streams concurrent worker activity into Pi's live status UI.
12. Detects terminal Pi events and stops each worker process before inspecting its output.
13. Verifies the assigned branch and base commit, rejects conflicts or out-of-scope changes, and records a diff fingerprint.
14. Runs `git diff --check` and the exact focused validation commands approved in the plan.
15. Re-inspects the worktree to reject checks that changed worker output.
16. Creates one conductor-owned task commit, records its hash and validation evidence, and removes the successful worktree while retaining its branch.
17. Retains failed worktrees for inspection and blocks dependent tasks after validation or commit failure.
18. Cherry-picks validated commits onto the integration branch in deterministic topological order.
19. Starts dependent task worktrees from the refreshed integration head after their dependencies land.
20. Aborts conflicting cherry-picks without advancing the integration branch or changing the user branch.
21. Refills available slots only after successful validation, commit creation, cleanup, and required dependency integration unblock downstream work.
22. Starts a review round at the exact recorded integration head after every task commit is integrated.
23. Launches fresh correctness, security, maintainability, tests, and documentation reviewers in isolated worktrees under the same configured worker bound.
24. Rejects reviewer output unless it is a clean, versioned, bounded report for the expected category and integration commit.
25. Prioritizes critical and high findings, plus high-confidence medium findings, for automatic repair.
26. Defers lower-priority findings as explicit remaining risks rather than silently discarding them.
27. Launches a fresh isolated repair worker for all prioritized findings, validates its changes against the union of approved paths and focused commands, and creates a conductor-owned repair commit.
28. Integrates the repair commit without changing the user branch, then repeats all five reviews with fresh workers at the repaired head.
29. Stops after two repair attempts and fails the run if a third review round still reports important findings.

Worker executions time out after one hour by default.
Set `PI_BUILD_WORKER_TIMEOUT_MS` to a positive duration in milliseconds to override that limit.
Each validation command times out after ten minutes by default.
Set `PI_BUILD_VALIDATION_TIMEOUT_MS` to a positive duration in milliseconds to override that limit.
The worker pool defaults to two concurrent workers.
Set `PI_BUILD_MAX_CONCURRENT_WORKERS` to an integer from two through four to change the bound.

Cancel a running build and stop its active workers with:

```text
/build-cancel <run-id>
```

After an interrupted conductor session, run:

```text
/build-resume <run-id>
```

Recovery checks the official orchestrator and stops all still-live task, review, and repair workers from interrupted attempts.
Uncommitted in-flight attempts become interrupted and retryable.
Succeeded reviewer reports remain durable, while interrupted categories are relaunched with fresh workers.
A validating task attempt with a recorded task commit is verified and cleanup is retried without creating a duplicate commit.
A repair attempt with passing evidence and a recorded source commit is verified, cleanup is retried, and an already-created integration commit is reconciled without recommitting.
Recovery fails safely when the integration branch cannot be proven to contain the exact single-parent repair commit.
Broader restart idempotency and orphan-resource reconciliation remain part of the dedicated restart-hardening stage.

## Review and repair policy

Each reviewer must return exactly one JSON report between `BEGIN_PI_BUILD_REVIEW_REPORT` and `END_PI_BUILD_REVIEW_REPORT` markers.
The report identifies version 1, the expected review category, the exact integration base commit, a summary, and up to 50 findings.
Each finding includes severity, confidence, title, description, repository-relative paths, and a recommendation.
Malformed reports, mismatched categories or commits, unsafe paths, duplicate findings, reviewer failures, and modified reviewer worktrees fail the review phase.

Critical and high findings always require automatic repair.
Medium findings require automatic repair when reviewer confidence is high.
Other findings are persisted as deferred risks.
Important findings are sorted deterministically by severity, confidence, review category, and finding identifier before they are sent to the repair worker.
The review phase fails rather than truncating or automatically repairing when more than 100 findings cross the automatic-repair threshold.
Important findings outside the plan's approved path scope fail review and require a new approved plan instead of expanding repair authority automatically.
A repair runs the de-duplicated union of the plan's focused validation commands, not a repository-wide validation suite.
After repair integration, every review category runs again with a fresh worker and fresh worktree.
At most two successful repair and re-review cycles are allowed before remaining important findings fail the run.
A failed repair worker fails the run immediately, while interrupted repairs may be relaunched during recovery.

## Plan sidecar format

```json
{
  "version": 2,
  "title": "Example build",
  "tasks": [
    {
      "id": "implementation",
      "title": "Implement the feature",
      "description": "Add the smallest complete implementation.",
      "dependencies": [],
      "acceptanceCriteria": ["Focused tests pass"],
      "allowedPaths": ["src/feature/", "test/feature.test.ts"],
      "validationCommands": [
        {
          "command": "npm",
          "args": ["test", "--", "test/feature.test.ts"]
        }
      ]
    }
  ]
}
```

## Safety guarantees

- The conductor never checks out or merges into the user's current branch.
- `/build` and `/build-resume` refuse to start from a dirty worktree.
- Git state is checked again immediately before branch or worktree side effects.
- No Git or worker side effects occur before explicit plan approval.
- Every task, reviewer, and repair worker receives a separate branch and worktree.
- Reviewers are fresh agents that did not implement the run and are instructed to leave their worktrees unchanged.
- Reviewer worktrees are accepted only when their branch, commit, and clean state still match the allocated review snapshot.
- Dependencies gate dispatch, and newly unblocked tasks are selected in deterministic plan order.
- The configured two-to-four worker limit includes prepared, launched, running, and validating task, review, and repair attempts.
- Worker prompts forbid branch switching, merging, and commits.
- Worker-created commits, branch switches, base resets, conflicts, Git submodules, and empty diffs are rejected.
- Both sides of a rename must stay within the plan's approved path scope.
- Task commits use a controlled temporary index, bypass repository hooks, and reject clean filters that would alter validated bytes.
- Validation commands execute directly without a shell, receive a reduced environment, have bounded output and time, and may not modify the validated snapshot.
- Focused validation executes repository code and is not a security sandbox.
- Run state is written atomically outside the checked-out file tree.
- Active uncommitted attempts are marked interrupted and retryable during recovery.
- A conductor-owned commit and its passing evidence are persisted before successful worktree cleanup.
- Failed validation worktrees are retained for inspection.
- Successful task branches and source commits are retained after integration.
- Completed, failed, cancelled, and timed-out attempts always request worker process cleanup.
- Validated task commits are cherry-picked sequentially in deterministic topological order on the separate integration branch.
- Dependent task worktrees start from the refreshed integration head after all dependencies land.
- Cherry-picks use detached temporary worktrees and an atomic compare-and-swap branch update, so conflicts leave the integration branch at its last good commit.
- The user branch is never checked out, merged, reset, or advanced by integration.
- Critical and high findings and high-confidence medium findings require isolated automatic repair.
- Lower-priority findings remain persisted as deferred risks for final evidence.
- Every successful repair is followed by all five fresh independent reviews.
- A `reviewed` run has no unresolved important findings, but is not yet merge-ready because full-suite validation is not implemented.

## Development

```bash
npm run format:check
npm run typecheck
npm test
```

With a compatible official orchestrator service running:

```bash
PI_ORCHESTRATOR_SMOKE_SOCKET=/path/to/orchestrator.sock npm run test:upstream
```

The package intentionally does not depend on Herdr.

Herdr may be added later as an optional visibility backend without changing the conductor's scheduling or Git ownership model.
