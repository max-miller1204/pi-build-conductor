# Engine run inspection and control evidence

Captured from a real temporary Git repository by:

```text
NO_MISTAKES_CAPTURE=1 bun node_modules/vitest/vitest.mjs run test/engine-run-inspection.test.ts --reporter=verbose
```

The extension commands read the durable workflow snapshot and render the Pi
command/widget surface below.

## `/orchestrate-list`

```text
Orchestration runs (1), newest first:
2026-07-31T19:26:38.955Z | inspect-engine-run | completed | 1 succeeded | Reviewed feature
Next: /orchestrate-show <run-id>
```

## `/orchestrate-show inspect-engine-run`

```text
Run inspect-engine-run: Reviewed feature
State: completed | Execution record: engine | Snapshot revision: 3 | Schema: 9
Plan revision: 1 (approved 1) | Worker limit: 2
Steps: 1 succeeded
- implementation [succeeded] Implementation; dependencies: none; attempts: 1; integrated ac8a34cbc10642433b1af724f1a458e154d06209
Review round 3: 5/5 reports received, 0 repair-required, 0 unresolved, 0 deferred
Latest review round: succeeded; base 7fc6c7ef1c1c4ffdad4165c070e5fa487a8ec5fc
Attempts: 1 change, 2 repair, 15 review, 1 final validation
Final validation: succeeded at 7fc6c7ef1c1c4ffdad4165c070e5fa487a8ec5fc; checks 1/1
Merge-ready evidence: generated 2026-07-31T19:26:38.935Z
Next: /orchestrate-prune inspect-engine-run
```

The new step selector resolves an engine step directly:

```text
Step review-1-security (review): Independent security review (round 1)
State: succeeded | Attempts: 1
Description: Review the complete integrated result for security problems and report structured findings.
Dependencies: implementation
Attempt history:
- #1 review-1-security-1-5561a264: succeeded, worker worker-3
Next: /orchestrate-show inspect-engine-run attempt review-1-security-1-5561a264
```

The same surface resolves the repair attempt and its engine evidence:

```text
Attempt repair-1-1-a7461b20 (repair)
State: succeeded | Number: 1
Worker authority: repair; tools legacy unrestricted; resources host
Repair: round 1
Step: repair-1 - Repair the round 1 review findings
Worker: worker-7
Summary: Committed 1 changed file(s) as 7fc6c7ef1c1c4ffdad4165c070e5fa487a8ec5fc
Evidence: passed, checks 2/2
Changed files: ?? src/review-fix.txt
Next: /orchestrate-show inspect-engine-run
```

## `/orchestrate-follow inspect-engine-run`

```text
Worker output: review-2-documentation-1-3be9f399
No captured output.
```

## `/orchestrate-retry inspect-engine-run implementation`

The run was first failed by its implementation worker. The command reopened
that engine step and rendered this live widget before the retry completed:

```text
Run inspect-engine-run
Run: running
Plan revision: 1
Worker limit: 2
Steps: 1 ready
Reviews: not started
State file: /tmp/pi-orchestrator-inspection-3R1wIm/repository/.git/pi-orchestrator/runs
```

The same command then settled through the engine and updated the Pi status:

```text
Status: merge-ready validation passed
Executing run inspect-engine-run; progress appears in the run widget
Run inspect-engine-run is merge-ready on conductor/inspect-engine-run/integration at 6b27ff66d7357b5b7705d8fc0df10f2eebbd9eb2
```

## `/orchestrate-cancel inspect-engine-run` with stale stored state

For this check the projected stored run still said `running`, while the durable
workflow snapshot was `failed`. Cancellation used the engine view, preserved
the retryable failure, and recommended the valid control action:

```text
Run inspect-engine-run was already failed; no lifecycle work was changed
Run inspect-engine-run: Reviewed feature
State: failed | Execution record: engine | Snapshot revision: 4 | Schema: 9
Run error: The reviewer failed after the last store update
Next: /orchestrate-retry inspect-engine-run
```
