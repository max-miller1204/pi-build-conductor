# pi-build-conductor

`pi-build-conductor` is a Pi package for turning a build handoff into isolated, dependency-aware implementation work.

The current vertical slice reads a handoff, generates or loads a validated task DAG, lets the user edit and explicitly approve it, creates isolated Git branches and a worktree, and launches the first ready worker through the official experimental Pi orchestrator.

## Status

This repository is an early MVP.

Implemented:

- `/build <handoff-file>` Pi command
- Planning through the selected Pi model
- Optional `<handoff-file>.plan.json` sidecar loading
- Editable plan and explicit approval gate
- DAG validation and deterministic scheduling
- Durable, atomic run-state storage and interrupted-attempt recovery
- Git branch and worktree isolation
- A narrow `WorkerBackend` interface
- An adapter for the official orchestrator JSONL socket API
- Launch of one ready implementation worker
- Tests for DAG validation, scheduling, recovery, Git isolation, and worker launch

Sequential integration, worker completion tracking, automatic commits, reviewer agents, and final full-suite validation are the next implementation stages.

## Architecture

- `src/domain` contains run, task, attempt, and DAG state without process or UI dependencies.
- `src/storage` persists versioned run snapshots under the repository's Git common directory.
- `src/git` owns branch, commit, cherry-pick, and worktree operations.
- `src/workers` isolates the experimental orchestrator protocol behind `WorkerBackend`.
- `src/planning` calls the selected Pi model and validates its JSON plan.
- `src/conductor.ts` coordinates durable state transitions, Git isolation, and worker launch.
- `src/extension.ts` provides the `/build` command and approval UI.

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

From an upstream Pi source checkout, it can currently be built and started with:

```bash
npm install
npm run build
node packages/orchestrator/dist/cli.js serve
```

Keep that service running before invoking `/build`.

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
8. Creates a separate task branch and worktree under `~/.pi/build-conductor/worktrees/`.
9. Spawns an independent Pi instance through the official orchestrator and sends the task prompt.
10. Shows the run, worker, branch, and worktree in Pi's live status widget.

## Plan sidecar format

```json
{
  "version": 1,
  "title": "Example build",
  "tasks": [
    {
      "id": "implementation",
      "title": "Implement the feature",
      "description": "Add the smallest complete implementation.",
      "dependencies": [],
      "acceptanceCriteria": ["Focused tests pass"]
    }
  ]
}
```

## Safety guarantees

- The conductor never checks out or merges into the user's current branch.
- `/build` refuses to start from a dirty worktree.
- No Git or worker side effects occur before explicit plan approval.
- Every worker receives a separate branch and worktree.
- Worker prompts forbid branch switching, merging, and commits.
- Run state is written atomically outside the checked-out file tree.
- Active attempts are marked interrupted and retryable during recovery.
- Integration is designed to occur sequentially on a separate integration branch.
- The current MVP does not claim a branch is merge-ready because final reviews and full validation are not implemented yet.

## Development

```bash
npm run format:check
npm run typecheck
npm test
```

The package intentionally does not depend on Herdr.

Herdr may be added later as an optional visibility backend without changing the conductor's scheduling or Git ownership model.
