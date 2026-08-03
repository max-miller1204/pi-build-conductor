# Authority envelope approval-gate transcript

This transcript was generated from the committed product code through
`renderApprovalSummary(createOrchestrationRun(...))` for a two-step mutating
plan.

```text
Run run-authority-envelope-review: Publish the versioned inter-extension worklist API
Plan revision: 1 | Tasks: 2 | Dependencies: 1
DAG layers: 1: service | 2: protocol
Worker limit: 2 | Approved paths: 2 | Focused checks: 2
Integration branch: conductor/run-authority-envelope-review/integration
Authority envelope:
Outcome: "Publish the versioned inter-extension worklist API"
Acceptance criteria:
  - "Every tool call routes through the service"
  - "Errors are typed and actionable"
Repositories:
  "/workspace/pi-build-conductor"
    capabilities: read-repository, mutate-repository, execute-commands
    mutable paths:
      - "src/service/"
      - "src/protocol/"
Forbidden actions: none
Sandbox: workers worktree-only; validation no OS sandbox, host network available
Required validation:
  - "npm run check"
Per-change validation: required before integration
Reserved for the user, always escalated:
  - add-repository: work in a repository this envelope does not name
  - widen-mutation-authority: mutate a path or exercise a capability this envelope does not grant
  - change-acceptance-criteria: add, drop, or reinterpret an approved acceptance criterion
  - skip-required-validation: settle without a required validation command
  - external-effect: deploy, publish, administer, or mutate anything remote
External effects forbidden: no deployment, publishing, cloud administration, or remote mutation authority exists in any capability profile
Step authority:
- service (Centralize the application service) paths: src/service/
  authority: change step; capabilities: read-repository, execute-commands, mutate-repository; tools: read, grep, find, ls, bash, edit, write; external effects: forbidden
  check: npm test -- service
- protocol (Add the protocol envelope) paths: src/protocol/
  authority: change step; capabilities: read-repository, execute-commands, mutate-repository; tools: read, grep, find, ls, bash, edit, write; external effects: forbidden
  check: npm test -- protocol
External effects forbidden: no deployment, publishing, cloud administration, or remote mutation authority exists in any capability profile
Final validation:
- npm run check
Security boundary:
Policy: v2 (configured)
Workers: worktree-only; role allowlists enforced by compatible server; resources disabled; host network
Worker credentials: host-credentials-available-to-worker; agent tools may access host secrets because workers are not OS-sandboxed
Validation: no OS sandbox, host network available; temporary-home-reduced
Blocked worker UI: decline
Worker authority: capability profiles frozen at run creation; external effects forbidden
After approval: create worktree-isolated workers, integrate validated commits, run five independent reviews and repairs, then run final validation.
WARNING: validation executes untrusted repository code without an OS sandbox.
Prompt instructions and post-run diff checks cannot prevent host or external side effects.
Merge-ready evidence proves recorded Git and validation state, not the absence of external side effects.
Only orchestrator metadata has been persisted. No Git refs, worktrees, workers, or validation commands have started.
```

The public validator was also exercised directly for fail-closed defaults,
digest identity, and rejection boundaries:

```text
FAIL-CLOSED DEFAULTS
{
  "mutation": {
    "capabilities": [
      "read-repository"
    ],
    "allowedPaths": [],
    "forbiddenPaths": []
  },
  "externalEffects": "forbidden",
  "perChange": true,
  "escalation": [
    "add-repository",
    "widen-mutation-authority",
    "change-acceptance-criteria",
    "skip-required-validation",
    "external-effect"
  ]
}

DIGEST IDENTITY
original=fe4dad01550ddb8b69ca8ecaa980f9cbc78d884052d1c3a5815b9dffac108cc7
reordered=fe4dad01550ddb8b69ca8ecaa980f9cbc78d884052d1c3a5815b9dffac108cc7
changed=93639815e414088630d7c2c808928e2da71ac4a26f6692888df47461756895e0
missing read-repository: REJECTED — repositories[0].mutation.capabilities must include read-repository whenever any capability is granted
reserved escalation subset: REJECTED — escalation.conditions must reserve every condition, and omits external-effect
second repository: REJECTED — repositories may name only one repository; adding another is an escalation this orchestrator cannot yet satisfy
```
