# Security policy

## Security model

`pi-build-conductor` coordinates model-driven workers and executes repository-provided validation commands.
Repository contents, handoff text, model output, review output, and validation scripts are untrusted data.
The conductor process, selected Git executable, compatible server service, configured Nono executable, provider process, and host operating system are trusted components.
A compromised trusted component can exceed every boundary described here.

A Git worktree is a source-integrity boundary, not an operating-system sandbox.
Worktree separation helps the conductor identify and reject unexpected repository changes.
It does not prevent a worker or validation process from reading host files, using the network, changing other directories, or affecting external systems.
Prompt instructions and post-run diff inspection are defense in depth and are not security boundaries.

## Immutable run policy

Every new run stores a versioned security policy before approval.
The policy is immutable for the lifetime of the run, including retries and recovery after restart.
Approval, worker prompts, worker launches, validation, run inspection, and merge-ready evidence use this stored policy rather than current environment defaults.
Legacy runs are migrated with an explicit `legacy-migrated` policy that does not claim controls that were not recorded at creation time.
Runs approved before the server migration keep their persisted `orchestrator-allowlist-v1` tool policy and stay enforced as worker launch policy version 1.

## Worker authority

The compatible server commit pinned in `package.json` supports worker launch policy version 1.
The conductor checks that support before approval and requires an exact applied-policy attestation after each spawn.
A missing capability or mismatched attestation fails closed and never falls back to an unrestricted worker.

The compatible server disables project and user extension discovery, skills, prompt templates, and context files for policy-controlled workers.
It enables only the fixed built-in tool allowlist for the worker role.

| Role | Enabled tools |
| --- | --- |
| Implementation | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` |
| Review | `read`, `grep`, `find`, `ls` |
| Repair | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` |

Review workers have no Bash or mutation tool.
Implementation and repair workers retain Bash and mutation tools because they must modify and check repository code.
The conductor still rejects branch movement, worker-created commits, conflicts, and changes outside approved repository paths before accepting work.
These checks detect repository mutations after execution and cannot undo host or external side effects.

Workers must not push, publish, deploy, mutate remote APIs or cloud resources, access credential stores, escalate privileges, or change external branches and worktrees.
Worker UI requests cannot expand authority.
Confirmations are declined by default, while selection, input, and editor requests are cancelled.
`PI_BUILD_WORKER_UI_POLICY=cancel` cancels all supported blocking dialog types.
The chosen UI policy is frozen into the run.

## Worker sandbox and credentials

Worker Pi processes are not OS-sandboxed in policy version 1.
They use separate Git worktrees and enforced tool allowlists, but they retain host filesystem and network reachability.
The server process also retains the provider credentials needed to call the selected model.
Those credentials and other host credential stores may be reachable through implementation and repair tools.
Do not run workers on a host that contains credentials or resources they must not be able to reach.
Use a dedicated account, container, virtual machine, or disposable machine when stronger isolation is required.

Handoffs, task descriptions, repository files, worker output, and attempt logs are not safe places for secrets.
The conductor does not intentionally place secret values in prompts or reports, but it cannot reliably redact secrets that untrusted code or a model reads and emits.

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

Set `PI_BUILD_VALIDATION_SANDBOX=nono` to run focused and final validation commands through Nono.
Set `PI_BUILD_NONO_PATH` to the absolute path of the audited `nono` executable.
The conductor uses a generated, conductor-owned Nono profile with a fixed `nono run --profile <profile> --allow-cwd --allow <temporary-runtime> --block-net` wrapper.
The profile injects isolated child runtime paths and admits only the reduced environment allowlist.
Nono receives a separate control home outside the granted runtime so its protected audit and state directories are never exposed to the validation process.
On Nix systems, the immutable `/nix/store` is granted read-only so approved executables and their runtime closures can load.
The worktree is read-only and the temporary runtime is writable, while Nono blocks network access and applies its filesystem sandbox.
The conductor does not accept arbitrary wrapper arguments or profiles.
A missing executable, unsupported setup, or sandbox launch failure fails validation without running the original command directly.
There is no automatic unsandboxed fallback.

The default is `PI_BUILD_VALIDATION_SANDBOX=none` for compatibility.
Approval and reports display a warning when validation is unsandboxed.
Builds that require network access must currently use the explicitly reported unsandboxed mode.

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
Run the server and conductor under a dedicated low-privilege account.
Remove ambient cloud, package registry, SSH, signing, and deployment credentials from the execution host.
Use a disposable environment for untrusted repositories.
Inspect retained failed worktrees and bounded logs without executing their contents.
Rotate any credential that may have been exposed to a worker or unsandboxed command.

## Reporting vulnerabilities

Do not include live credentials, private repository contents, or sensitive logs in a public report.
Report security issues to the repository owner through a private GitHub security advisory when available.
Include the conductor version, compatible server commit, security policy shown in the run report, operating system, and a minimal reproduction.
