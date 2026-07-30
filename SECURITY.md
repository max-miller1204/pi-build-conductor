# Security policy

## Security model

`pi-build-conductor` coordinates model-driven workers and executes repository-provided validation commands.
Repository contents, request text, model output, review output, and validation scripts are untrusted data.
The orchestrator process, selected Git executable, compatible server service, configured Nono executable, provider process, and host operating system are trusted components.
A compromised trusted component can exceed every boundary described here.

A Git worktree is a source-integrity boundary, not an operating-system sandbox.
Worktree separation helps the orchestrator identify and reject unexpected repository changes.
It does not prevent a worker or validation process from reading host files, using the network, changing other directories, or affecting external systems.
Prompt instructions and post-run diff inspection are defense in depth and are not security boundaries.

## Immutable run policy

Every durable change run stores a versioned security policy before approval.
The policy is immutable for the lifetime of the run, including retries and recovery after restart.
Approval, worker prompts, worker launches, validation, run inspection, and merge-ready evidence use this stored policy rather than current environment defaults.
Engine-backed read-only commands snapshot their capability profiles for one execution and do not expose retry or recovery.
Legacy runs are migrated with an explicit `legacy-migrated` policy that does not claim controls that were not recorded at creation time.
Runs approved before the server migration keep their persisted `orchestrator-allowlist-v1` tool policy and stay enforced as worker launch policy version 1.

## Worker authority

The compatible server commit pinned in `package.json` supports worker launch policy version 1.
The orchestrator checks that support before approval and requires an exact applied-policy attestation after each spawn.
A missing capability or mismatched attestation fails closed and never falls back to an unrestricted worker.

The compatible server disables project and user extension discovery, skills, and prompt templates for policy-controlled workers.
Worker launch policy version 1 does not suppress Pi's `SYSTEM.md` or `APPEND_SYSTEM.md` context files; those files remain discoverable even when `resourceDiscovery` is `disabled`.
Worker processes also do not inherit the session's `--models` scope.
The extension therefore launches each worker with the active session model or, when none is active, the first scoped model; an empty scope leaves model selection to the worker default.
New runs freeze the complete capability-profile set at creation.
Each workflow step selects an allowed profile and may only narrow its capabilities further.
The compatible server enforces the exact derived tool allowlist:

| Capability | Enabled tools |
| --- | --- |
| Read repository | `read`, `grep`, `find`, `ls` |
| Execute commands | `bash` |
| Mutate repository | `edit`, `write` |

Investigation and review profiles have only read-repository authority.
Change and repair profiles may also receive command and mutation authority, while command profiles cannot mutate and approval profiles receive no worker tools.
Deployment, publishing, cloud administration, and remote mutation are not expressible capabilities.
The local validator rejects any repository mutation observed from a profile without `mutate-repository`.
The orchestrator still rejects branch movement, worker-created commits, conflicts, and changes outside approved repository paths before accepting work.
These checks detect repository mutations after execution and cannot undo host or external side effects.

Workers must not push, publish, deploy, mutate remote APIs or cloud resources, access credential stores, escalate privileges, or change external branches and worktrees.
Worker UI requests cannot expand authority.
Confirmations are declined by default, while selection, input, and editor requests are cancelled.
`PI_ORCHESTRATOR_WORKER_UI_POLICY=cancel` cancels all supported blocking dialog types.
The chosen UI policy is frozen into the run.

## Worker sandbox and credentials

Worker Pi processes are not OS-sandboxed by worker launch policy version 1.
They use separate Git worktrees and enforced tool allowlists, but they retain host filesystem and network reachability.
The server process also retains the provider credentials needed to call the selected model.
Those credentials and other host credential stores may be reachable through worker tools.
Do not run workers on a host that contains credentials or resources they must not be able to reach.
Use a dedicated account, container, virtual machine, or disposable machine when stronger isolation is required.

Requests, task descriptions, repository files, worker output, and attempt logs are not safe places for secrets.
The orchestrator does not intentionally place secret values in prompts or reports, but it cannot reliably redact secrets that untrusted code or a model reads and emits.

## Validation boundary

Validation always executes commands directly without a shell.
Arguments are passed literally.
Each command receives a fresh temporary `HOME`, XDG directories, and temporary directory.
Only required platform variables, `PATH`, and locale variables are carried into the command environment.
Common provider key variables, `SSH_AUTH_SOCK`, and the operator's home path are not inherited.
Git credential prompting is disabled.
The temporary runtime directory is removed after the complete process group exits.

Reduced environment handling is not a filesystem sandbox.
An unsandboxed command can still use absolute paths, inspect process-visible resources, or use the host network.

Set `PI_ORCHESTRATOR_VALIDATION_SANDBOX=nono` to run focused and final validation commands through Nono.
Set `PI_ORCHESTRATOR_NONO_PATH` to the absolute path of the audited `nono` executable.
The orchestrator uses a generated, orchestrator-owned Nono profile with a fixed `nono run --profile <profile> --allow-cwd --allow <temporary-runtime> --block-net` wrapper.
The profile injects isolated child runtime paths and admits only the reduced environment allowlist.
Nono receives a separate control home outside the granted runtime so its protected audit and state directories are never exposed to the validation process.
On Nix systems, the immutable `/nix/store` is granted read-only so approved executables and their runtime closures can load.
The worktree is read-only and the temporary runtime is writable, while Nono blocks network access and applies its filesystem sandbox.
The orchestrator does not accept arbitrary wrapper arguments or profiles.
A missing executable, unsupported setup, or sandbox launch failure fails validation without running the original command directly.
There is no automatic unsandboxed fallback.

The default is `PI_ORCHESTRATOR_VALIDATION_SANDBOX=none` for compatibility.
The legacy `PI_BUILD_*` spellings remain temporary aliases as documented in the README configuration table.
Approval and reports display a warning when validation is unsandboxed.
Runs that require network access must currently use the explicitly reported unsandboxed mode.

Nono is an optional third-party dependency and has its own platform and kernel limitations.
Review Nono's documentation and threat model before relying on it for hostile code.
For high-risk repositories, use Nono inside a disposable virtual machine or equivalent stronger isolation.

## Network policy

Workers currently use the host network because model-provider access is required and worker processes are not separately network-sandboxed.
Nono validation uses blocked network access.
Unsandboxed validation uses the host network.
The exact boundary is stored per run and recorded with every newly executed validation check.

## Merge-ready evidence

Merge-ready evidence proves the recorded integration commit chain, final review summaries, deferred findings, final validation results, immutable security policy, and untouched user Git worktree at the time of verification.
It does not prove that workers or repository code caused no host, credential, network, cloud, remote API, or other external side effects.
It does not turn prompt instructions, tool allowlists, worktrees, or post-execution checks into an OS sandbox.

## Operator guidance

Review the security section in the final approval summary before approving a run.
Prefer Nono validation when the approved commands do not need network access.
Run the server and orchestrator under a dedicated low-privilege account.
Remove ambient cloud, package registry, SSH, signing, and deployment credentials from the execution host.
Use a disposable environment for untrusted repositories.
Inspect retained failed worktrees and bounded logs without executing their contents.
Rotate any credential that may have been exposed to a worker or unsandboxed command.

## Reporting vulnerabilities

Do not include live credentials, private repository contents, or sensitive logs in a public report.
Report security issues to the repository owner through a private GitHub security advisory when available.
Include the orchestrator version, compatible server commit, security policy shown in the run report, operating system, and a minimal reproduction.
