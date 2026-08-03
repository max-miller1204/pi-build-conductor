import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowPlanDocument } from "../src/domain/plan-translation.js";
import { createOrchestrationRun, reviseRunPlan } from "../src/domain/run.js";
import {
	WORKFLOW_PLAN_SCHEMA_VERSION,
	type WorkflowPlan,
} from "../src/domain/steps.js";
import type { OrchestrationRun, TaskPlan } from "../src/domain/types.js";
import { createWorkflowRunState } from "../src/engine/workflow-state.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { loadRunView } from "../src/inspection/run-inspector.js";
import { Orchestrator } from "../src/orchestrator.js";
import { renderApprovalSummary } from "../src/planning/plan-presentation.js";
import {
	AuthorityViolationError,
	capabilityProfilesFromEnvelope,
	envelopeSidecarPath,
	freezeRunAuthority,
	planAuthorityIssues,
	readEnvelopeSidecar,
} from "../src/security/authority.js";
import { defaultCapabilityProfiles } from "../src/security/capabilities.js";
import {
	AUTHORITY_ENVELOPE_SCHEMA_VERSION,
	type AuthorityEnvelope,
	authorityEnvelopeDigest,
	envelopeFromApprovedRun,
	RESERVED_ESCALATION_CONDITIONS,
	readAuthorityEnvelopeDocument,
} from "../src/security/envelope.js";
import {
	readSecurityPolicy,
	workerLaunchPolicy,
} from "../src/security/policy.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { RunStore } from "../src/storage/run-store.js";
import { FileWorkflowStateStore } from "../src/storage/workflow-state-store.js";
import { LocalFinalValidator } from "../src/validation/final-validator.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import { EngineChangeRunner } from "../src/workflows/change-run.js";
import { ChangeRunWorkers } from "./helpers/change-run-workers.js";
import { removeTemporaryDirectories } from "./helpers/cleanup.js";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
	await removeTemporaryDirectories(directories);
});

async function createRepository() {
	const parent = await mkdtemp(join(tmpdir(), "pi-orchestrator-authority-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "README.md"), "base\n");
	await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return { parent, repositoryRoot };
}

/** The final check every plan and envelope in this file agrees on. */
const FINAL_CHECK = { command: process.execPath, args: ["-e", ""] };

function taskPlan(
	overrides: Partial<TaskPlan["tasks"][number]> = {},
): TaskPlan {
	return {
		version: 3,
		title: "Reviewed feature",
		tasks: [
			{
				id: "implementation",
				title: "Implementation",
				description: "Implement the feature",
				dependencies: [],
				acceptanceCriteria: ["Implementation exists"],
				allowedPaths: ["src/"],
				validationCommands: [FINAL_CHECK],
				...overrides,
			},
		],
		finalValidationCommands: [FINAL_CHECK],
	};
}

/**
 * The envelope document a user authors beside their request: mutation inside
 * `src/`, nothing inside `src/generated/`, and one required final check.
 */
function envelopeDocument(
	repositoryRoot: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: AUTHORITY_ENVELOPE_SCHEMA_VERSION,
		outcome: "Implement the reviewed feature",
		acceptanceCriteria: ["The feature exists and the final check passes"],
		repositories: [
			{
				root: repositoryRoot,
				mutation: {
					capabilities: [
						"read-repository",
						"mutate-repository",
						"execute-commands",
					],
					allowedPaths: ["src/"],
					forbiddenPaths: ["src/generated/"],
				},
			},
		],
		forbiddenActions: ["Never publish to npm"],
		externalEffects: "forbidden",
		sandbox: { workers: "worktree-only", validation: "none" },
		validation: { required: [FINAL_CHECK], perChange: true },
		escalation: {
			conditions: [...RESERVED_ESCALATION_CONDITIONS],
			reservedDecisions: [],
		},
		...overrides,
	};
}

interface HarnessOptions {
	/** The sidecar document, built from the real repository root. */
	envelope?: ((root: string) => Record<string, unknown>) | "none";
	plan?: TaskPlan;
}

/**
 * A real repository, a request file, and the envelope sidecar beside it, run
 * through the same path `/orchestrate` takes: read the sidecar, create the
 * run with it, then execute that run on the engine.
 */
async function createHarness(options: HarnessOptions = {}) {
	const { parent, repositoryRoot } = await createRepository();
	const git = new GitCli();
	const repository = await git.inspect(repositoryRoot);
	const requestPath = join(parent, "request.md");
	await writeFile(requestPath, "Implement the reviewed feature\n");
	const document = options.envelope ?? envelopeDocument;
	if (document !== "none") {
		await writeFile(
			envelopeSidecarPath(requestPath),
			JSON.stringify(document(repositoryRoot), null, 2),
		);
	}
	const envelope = await readEnvelopeSidecar(requestPath);
	const workers = new ChangeRunWorkers({ path: "src/review-fix.txt" });
	const store = new RunStore(join(parent, "runs"));
	const worktrees = new GitWorktreeManager(git, join(parent, "worktrees"));
	const dependencies = {
		store,
		workflowStates: new FileWorkflowStateStore(join(parent, "workflow-runs")),
		artifacts: new ArtifactStore(join(parent, "artifacts")),
		workers,
		git,
		worktrees,
		validator: new LocalTaskValidator(git),
		finalValidator: new LocalFinalValidator(git),
		securityPolicy: readSecurityPolicy({}),
	};
	const orchestrator = new Orchestrator({
		store,
		git,
		worktrees,
		workers,
		validator: dependencies.validator,
		finalValidator: dependencies.finalValidator,
	});
	return {
		parent,
		repositoryRoot,
		requestPath,
		repository,
		git,
		store,
		workers,
		dependencies,
		envelope,
		create: () =>
			orchestrator.createRun({
				repository,
				requestPath,
				requestText: "Implement the reviewed feature",
				plan: options.plan ?? taskPlan(),
				...(envelope ? { envelope } : {}),
			}),
		runner: new EngineChangeRunner(dependencies),
		view: (runId: string) =>
			loadRunView(
				{
					runs: store,
					workflowStates: dependencies.workflowStates,
					artifacts: dependencies.artifacts,
				},
				runId,
			),
	};
}

/** An authored envelope for a repository root, without touching the disk. */
function authoredEnvelopeFor(
	repositoryRoot: string,
	overrides: Record<string, unknown> = {},
): AuthorityEnvelope {
	return readAuthorityEnvelopeDocument(
		envelopeDocument(repositoryRoot, overrides),
	);
}

function runWith(
	repositoryRoot: string,
	envelope: AuthorityEnvelope | undefined,
	plan: TaskPlan = taskPlan(),
	id = "run-authority",
): OrchestrationRun {
	return createOrchestrationRun({
		id,
		repositoryRoot,
		baseBranch: "main",
		baseCommit: "a".repeat(40),
		integrationBranch: `conductor/${id}/integration`,
		request: { sourcePath: "/tmp/request.md", text: "Implement" },
		securityPolicy: readSecurityPolicy({}),
		...(envelope ? { envelope } : {}),
		plan,
		maxConcurrentWorkers: 2,
		now: "2026-08-03T00:00:00.000Z",
	});
}

function violationIssues(build: () => unknown): string[] {
	try {
		build();
	} catch (error) {
		if (error instanceof AuthorityViolationError) {
			return error.issues;
		}
		throw error;
	}
	throw new Error("expected the approved authority envelope to refuse this");
}

describe("the authority envelope frozen at run creation", () => {
	it("executes a live run under the authority the user authored", async () => {
		const harness = await createHarness();
		const created = await harness.create();

		expect(created.authority).toMatchObject({
			source: "authored",
			digest: authorityEnvelopeDigest(harness.envelope as AuthorityEnvelope),
		});
		expect(created.authority?.envelope).toEqual(harness.envelope);
		// Every worker profile is the one the envelope grants, not the maximum
		// the step kinds allow.
		expect(created.securityPolicy.workers.capabilityProfiles).toEqual(
			capabilityProfilesFromEnvelope(
				harness.envelope as AuthorityEnvelope,
				harness.repositoryRoot,
			),
		);
		const summary = renderApprovalSummary(created);
		expect(summary).toContain("Authority envelope (approved before planning");
		expect(summary).toContain('Outcome: "Implement the reviewed feature"');
		expect(summary).toContain('      - "src/generated/"');

		const launch = await harness.runner.approveAndLaunch(
			created,
			harness.repository,
		);
		const completed = await launch.completion;

		expect(completed.state).toBe("completed");
		expect(completed.mergeReadyEvidence).toBeDefined();
		// The withheld path reaches the worker that could write it, because a
		// path inside an approved subtree cannot be withheld by narrowing.
		const changePrompt = harness.workers.prompts.find((prompt) =>
			prompt.includes("You are the change worker"),
		);
		expect(changePrompt).toContain("src/generated/");
		expect(changePrompt).toContain("Never create, modify, or delete these");
	});

	it("refuses a change that reaches a path the envelope withholds", async () => {
		const harness = await createHarness();
		harness.workers.changeFile = "src/generated/leak.txt";
		const created = await harness.create();

		const launch = await harness.runner.approveAndLaunch(
			created,
			harness.repository,
		);
		const settled = await launch.completion;

		expect(settled.state).toBe("failed");
		expect(settled.mergeReadyEvidence).toBeUndefined();
		const attempt = settled.attempts.find(
			(candidate) => candidate.unitId === "implementation",
		);
		expect(attempt?.state).toBe("failed");
		expect(attempt?.error).toContain(
			"changed paths the approved envelope withholds",
		);
		expect(attempt?.error).toContain("src/generated/leak.txt");
	});

	it("narrows every worker profile to the capabilities the envelope grants", async () => {
		const harness = await createHarness({
			envelope: (root) =>
				envelopeDocument(root, {
					repositories: [
						{
							root,
							mutation: {
								capabilities: ["read-repository", "mutate-repository"],
								allowedPaths: ["src/"],
								forbiddenPaths: [],
							},
						},
					],
				}),
		});
		const created = await harness.create();

		const profiles = created.securityPolicy.workers.capabilityProfiles;
		expect(profiles?.change.capabilities).toEqual([
			"read-repository",
			"mutate-repository",
		]);
		expect(profiles?.change.tools).not.toContain("bash");
		expect(profiles?.command.capabilities).toEqual(["read-repository"]);
		expect(profiles?.review.capabilities).toEqual(["read-repository"]);
		// The launch policy the server enforces carries the same narrowing.
		expect(
			workerLaunchPolicy(created.securityPolicy, "implementation")?.tools,
		).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
	});

	it("refuses a plan that would mutate outside the approved paths", async () => {
		const envelope = authoredEnvelopeFor("/repo");
		const issues = violationIssues(() =>
			runWith(
				"/repo",
				envelope,
				taskPlan({ allowedPaths: ["docs/", "src/app/"] }),
			),
		);
		expect(issues).toEqual([
			"Step implementation would mutate docs/, which the approved envelope does not allow",
		]);
	});

	it("refuses a plan that would mutate a withheld path directly", async () => {
		const envelope = authoredEnvelopeFor("/repo");
		const issues = violationIssues(() =>
			runWith(
				"/repo",
				envelope,
				taskPlan({ allowedPaths: ["src/generated/"] }),
			),
		);
		expect(issues).toEqual([
			"Step implementation would mutate src/generated/, which the approved envelope withholds",
		]);
	});

	it("refuses a plan that never runs a required validation command", async () => {
		const envelope = authoredEnvelopeFor("/repo");
		const plan = taskPlan();
		const issues = violationIssues(() =>
			runWith("/repo", envelope, {
				...plan,
				finalValidationCommands: [{ command: "npm", args: ["run", "lint"] }],
			}),
		);
		expect(issues).toEqual([
			`The plan never runs the required validation command ${FINAL_CHECK.command} -e ""`,
		]);
	});

	it("reserves skipping the per-change validation the envelope requires", () => {
		const envelope = authoredEnvelopeFor("/repo");
		const plan: WorkflowPlan = {
			version: WORKFLOW_PLAN_SCHEMA_VERSION,
			title: "Reviewed feature",
			steps: [
				{
					kind: "change",
					id: "implementation",
					title: "Implementation",
					description: "Implement the feature",
					dependencies: [],
					acceptanceCriteria: ["Implementation exists"],
					allowedPaths: ["src/"],
					validationCommands: [],
				},
			],
			finalValidationCommands: [FINAL_CHECK],
		};

		expect(planAuthorityIssues(plan, envelope, "/repo")).toEqual([
			expect.objectContaining({
				code: "per_change_validation_missing",
				condition: "skip-required-validation",
				message:
					"Step implementation would integrate without the per-change validation the approved envelope requires",
			}),
		]);
	});

	it("refuses a step that declares a capability the envelope withholds", async () => {
		const envelope = authoredEnvelopeFor("/repo", {
			repositories: [
				{
					root: "/repo",
					mutation: {
						capabilities: ["read-repository", "mutate-repository"],
						allowedPaths: ["src/"],
						forbiddenPaths: [],
					},
				},
			],
		});
		// A generalized workflow plan can declare its own authority, which is
		// exactly what the envelope has to bound.
		const issues = violationIssues(() =>
			freezeRunAuthority({
				repositoryRoot: "/repo",
				securityPolicy: readSecurityPolicy({}),
				envelope,
				plan: {
					version: WORKFLOW_PLAN_SCHEMA_VERSION,
					title: "Reviewed feature",
					steps: [
						{
							kind: "change",
							id: "implementation",
							title: "Implementation",
							description: "Implement the feature",
							dependencies: [],
							capabilities: [
								"read-repository",
								"mutate-repository",
								"execute-commands",
							],
							acceptanceCriteria: ["Implementation exists"],
							allowedPaths: ["src/"],
							validationCommands: [FINAL_CHECK],
						},
					],
					finalValidationCommands: [FINAL_CHECK],
				},
			}),
		);
		expect(issues).toEqual([
			"Step implementation declares execute-commands, which the approved envelope does not grant",
		]);
	});

	it("refuses a run in a repository the envelope does not name", async () => {
		const envelope = authoredEnvelopeFor("/repo");
		const issues = violationIssues(() => runWith("/other-repo", envelope));
		expect(issues).toEqual([
			"The approved envelope does not name repository /other-repo",
		]);
	});

	it("refuses an authored sandbox the run policy will not enforce", () => {
		const envelope = authoredEnvelopeFor("/repo", {
			sandbox: { workers: "worktree-only", validation: "nono" },
		});

		expect(violationIssues(() => runWith("/repo", envelope))).toEqual([
			"The approved envelope requires validation sandbox nono, but the run security policy uses none; set PI_ORCHESTRATOR_VALIDATION_SANDBOX=nono before creating the run",
		]);
	});

	it("freezes the authority a plan implies when none was authored", async () => {
		const harness = await createHarness({ envelope: "none" });
		const created = await harness.create();

		expect(created.authority?.source).toBe("derived");
		expect(created.authority?.envelope).toEqual(
			envelopeFromApprovedRun(created),
		);
		expect(created.authority?.digest).toBe(
			authorityEnvelopeDigest(envelopeFromApprovedRun(created)),
		);
		// A plan that states its own full change authority narrows nothing, so
		// this run executes with exactly the profiles it always did.
		expect(created.securityPolicy.workers.capabilityProfiles).toEqual(
			defaultCapabilityProfiles(),
		);
	});

	it("keeps an authored envelope frozen across plan revisions", async () => {
		const envelope = authoredEnvelopeFor("/repo");
		const created = runWith("/repo", envelope);
		const revised = reviseRunPlan(created, {
			plan: taskPlan({ allowedPaths: ["src/app/"] }),
			maxConcurrentWorkers: created.maxConcurrentWorkers,
			expectedPlanRevision: 1,
			now: "2026-08-03T01:00:00.000Z",
		});

		expect(revised.planRevision).toBe(2);
		expect(revised.authority).toEqual(created.authority);
		expect(
			violationIssues(() =>
				reviseRunPlan(revised, {
					plan: taskPlan({ allowedPaths: ["docs/"] }),
					maxConcurrentWorkers: created.maxConcurrentWorkers,
					expectedPlanRevision: 2,
					now: "2026-08-03T02:00:00.000Z",
				}),
			),
		).toEqual([
			"Step implementation would mutate docs/, which the approved envelope does not allow",
		]);
	});

	it("keeps a derived envelope faithful to the plan it was read from", async () => {
		const created = runWith("/repo", undefined);
		const revised = reviseRunPlan(created, {
			plan: { ...taskPlan(), title: "Reviewed feature, revised" },
			maxConcurrentWorkers: created.maxConcurrentWorkers,
			expectedPlanRevision: 1,
			now: "2026-08-03T01:00:00.000Z",
		});

		expect(revised.authority?.source).toBe("derived");
		expect(revised.authority?.envelope.outcome).toBe(
			"Reviewed feature, revised",
		);
		expect(revised.authority?.digest).not.toBe(created.authority?.digest);
		expect(revised.securityPolicy).toEqual(created.securityPolicy);
	});
});

/** Why a stored run refused to load, as the reader reports it. */
async function loadFailure(store: RunStore, runId: string): Promise<string> {
	try {
		await store.load(runId);
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause;
		return cause instanceof Error ? cause.message : String(error);
	}
	throw new Error(`expected run ${runId} to refuse to load`);
}

describe("stored authority", () => {
	async function storedRun(
		mutate: (stored: Record<string, unknown>) => Record<string, unknown>,
		options: HarnessOptions = {},
	) {
		const harness = await createHarness(options);
		// createRun persists the run, so the snapshot on disk is the real one.
		const created = await harness.create();
		const path = join(harness.parent, "runs", `${created.id}.json`);
		const stored = JSON.parse(await readFile(path, "utf8")) as Record<
			string,
			unknown
		>;
		await writeFile(path, JSON.stringify(mutate(stored), null, 2));
		return { harness, runId: created.id };
	}

	it("loads a run back with the authority it was frozen with", async () => {
		const harness = await createHarness();
		const created = await harness.create();

		const loaded = await harness.store.load(created.id);
		expect(loaded.authority).toEqual(created.authority);
	});

	it("refuses a stored envelope its digest no longer identifies", async () => {
		const { harness, runId } = await storedRun((stored) => {
			const authority = stored.authority as {
				envelope: { repositories: { mutation: { allowedPaths: string[] } }[] };
			};
			authority.envelope.repositories[0]?.mutation.allowedPaths.push("docs/");
			return stored;
		});

		await expect(loadFailure(harness.store, runId)).resolves.toMatch(
			/digest does not identify the stored envelope/,
		);
	});

	it("refuses stored profiles the approved envelope does not grant", async () => {
		// The envelope withheld command execution, so restoring the maximum
		// profiles would hand every worker back the tools it approved away.
		const { harness, runId } = await storedRun(
			(stored) => {
				const policy = stored.securityPolicy as {
					workers: { capabilityProfiles: Record<string, unknown> };
				};
				policy.workers.capabilityProfiles = defaultCapabilityProfiles();
				return stored;
			},
			{
				envelope: (root) =>
					envelopeDocument(root, {
						repositories: [
							{
								root,
								mutation: {
									capabilities: ["read-repository", "mutate-repository"],
									allowedPaths: ["src/"],
									forbiddenPaths: [],
								},
							},
						],
					}),
			},
		);

		await expect(loadFailure(harness.store, runId)).resolves.toMatch(
			/capability profiles must be the ones the approved envelope grants/,
		);
	});

	it("refuses a stored plan that outgrew the approved envelope", async () => {
		const { harness, runId } = await storedRun((stored) => {
			const plan = stored.plan as { tasks: { allowedPaths: string[] }[] };
			const task = plan.tasks[0];
			if (task) {
				task.allowedPaths = ["docs/"];
			}
			const revisions = stored.planRevisions as {
				plan: { tasks: { allowedPaths: string[] }[] };
			}[];
			const revisionTask = revisions[0]?.plan.tasks[0];
			if (revisionTask) {
				revisionTask.allowedPaths = ["docs/"];
			}
			return stored;
		});

		await expect(loadFailure(harness.store, runId)).resolves.toMatch(
			/plan exceeds the approved authority envelope/,
		);
	});

	it("refuses a stored sandbox that disagrees with the run policy", async () => {
		const { harness, runId } = await storedRun((stored) => {
			const authority = stored.authority as {
				digest: string;
				envelope: AuthorityEnvelope;
			};
			authority.envelope.sandbox.validation = "nono";
			authority.digest = authorityEnvelopeDigest(authority.envelope);
			return stored;
		});

		await expect(loadFailure(harness.store, runId)).resolves.toMatch(
			/PI_ORCHESTRATOR_VALIDATION_SANDBOX=nono/,
		);
	});

	it("refuses a stored derived envelope that no longer matches its plan", async () => {
		const { harness, runId } = await storedRun(
			(stored) => {
				const authority = stored.authority as {
					digest: string;
					envelope: AuthorityEnvelope;
				};
				authority.envelope.outcome = "A substituted outcome";
				authority.digest = authorityEnvelopeDigest(authority.envelope);
				return stored;
			},
			{ envelope: "none" },
		);

		await expect(loadFailure(harness.store, runId)).resolves.toMatch(
			/derived envelope must match the plan it was derived from/,
		);
	});

	it("carries the frozen authority into the engine snapshot", async () => {
		const harness = await createHarness();
		const created = await harness.create();
		const launch = await harness.runner.approveAndLaunch(
			created,
			harness.repository,
		);
		await launch.completion;

		const snapshot = await harness.dependencies.workflowStates.load(created.id);
		expect(snapshot.authority).toEqual(created.authority);
	});

	it("refuses an engine snapshot whose plan exceeds its authority", async () => {
		const harness = await createHarness();
		const created = await harness.create();
		const authority = created.authority;
		if (!authority) {
			throw new Error("expected the created run to freeze an authority");
		}

		await expect(
			harness.dependencies.workflowStates.create(
				createWorkflowRunState({
					id: "run-outgrown",
					plan: {
						version: WORKFLOW_PLAN_SCHEMA_VERSION,
						title: "Reviewed feature",
						steps: [
							{
								kind: "change",
								id: "implementation",
								title: "Implementation",
								description: "Implement the feature",
								dependencies: [],
								acceptanceCriteria: ["Implementation exists"],
								allowedPaths: ["docs/"],
								validationCommands: [FINAL_CHECK],
							},
						],
						finalValidationCommands: [FINAL_CHECK],
					},
					repositoryRoot: harness.repositoryRoot,
					baseBranch: "main",
					baseCommit: "a".repeat(40),
					integrationBranch: "conductor/run-outgrown/integration",
					integrationHead: "a".repeat(40),
					capabilityProfiles: capabilityProfilesFromEnvelope(
						authority.envelope,
						harness.repositoryRoot,
					),
					authority,
					maxConcurrentWorkers: 2,
				}),
			),
		).rejects.toThrow(/plan exceeds the approved authority envelope/);
	});

	it("keeps engine snapshot authority immutable across transactions", async () => {
		const harness = await createHarness();
		const created = await harness.create();
		const authority = created.authority;
		if (!authority) {
			throw new Error("expected the created run to freeze an authority");
		}
		const state = createWorkflowRunState({
			id: "run-authority-transition",
			plan: readWorkflowPlanDocument(created.plan),
			repositoryRoot: harness.repositoryRoot,
			baseBranch: "main",
			baseCommit: "a".repeat(40),
			integrationBranch: "conductor/run-authority-transition/integration",
			integrationHead: "a".repeat(40),
			capabilityProfiles: capabilityProfilesFromEnvelope(
				authority.envelope,
				harness.repositoryRoot,
			),
			authority,
			maxConcurrentWorkers: 2,
		});
		await harness.dependencies.workflowStates.create(state);

		await expect(
			harness.dependencies.workflowStates.transaction(state.id, (current) => {
				const { authority: _authority, ...withoutAuthority } = current;
				return withoutAuthority;
			}),
		).rejects.toThrow(/cannot be dropped/);
		await expect(
			harness.dependencies.workflowStates.transaction(state.id, (current) => {
				if (!current.authority) {
					throw new Error("expected frozen authority");
				}
				const envelope = {
					...current.authority.envelope,
					outcome: "A replacement outcome",
				};
				return {
					...current,
					authority: {
						...current.authority,
						envelope,
						digest: authorityEnvelopeDigest(envelope),
					},
				};
			}),
		).rejects.toThrow(/approved authority envelope is immutable/);
	});
});

describe("the envelope sidecar", () => {
	it("reads no envelope when the user authored none", async () => {
		const harness = await createHarness({ envelope: "none" });
		expect(await readEnvelopeSidecar(harness.requestPath)).toBeUndefined();
	});

	it("fails loudly on an unreadable or invalid sidecar", async () => {
		const harness = await createHarness();
		await writeFile(envelopeSidecarPath(harness.requestPath), "{ not json");
		await expect(readEnvelopeSidecar(harness.requestPath)).rejects.toThrow(
			/Failed to load envelope sidecar/,
		);

		await writeFile(
			envelopeSidecarPath(harness.requestPath),
			JSON.stringify({ ...envelopeDocument("/repo"), unexpected: true }),
		);
		await expect(readEnvelopeSidecar(harness.requestPath)).rejects.toThrow(
			/Failed to load envelope sidecar/,
		);
	});
});
