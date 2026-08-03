import { describe, expect, it } from "vitest";
import { readWorkflowPlanDocument } from "../src/domain/plan-translation.js";
import { createOrchestrationRun } from "../src/domain/run.js";
import { WORKFLOW_PLAN_SCHEMA_VERSION } from "../src/domain/steps.js";
import type { TaskPlan } from "../src/domain/types.js";
import {
	formatCommand,
	renderApprovalSummary,
	renderDagOverview,
	renderStepAuthorityLines,
} from "../src/planning/plan-presentation.js";
import { readSecurityPolicy } from "../src/security/policy.js";

const plan: TaskPlan = {
	version: 3,
	title: "Diamond build",
	tasks: [
		{
			id: "base",
			title: "Base",
			description: "Build the base",
			dependencies: [],
			acceptanceCriteria: ["Base works"],
			allowedPaths: ["src/base/"],
			validationCommands: [{ command: "npm", args: ["test", "--", "base"] }],
		},
		{
			id: "ui",
			title: "UI",
			description: "Build the UI",
			dependencies: ["base"],
			acceptanceCriteria: ["UI works"],
			allowedPaths: ["src/ui/"],
			validationCommands: [
				{ command: "npm", args: ["test", "--", "UI suite"] },
			],
		},
	],
	finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
};

describe("plan presentation", () => {
	it("renders a deterministic DAG overview", () => {
		expect(renderDagOverview(plan)).toContain("Layer 1: base");
		expect(renderDagOverview(plan)).toContain("Layer 2: ui");
		expect(renderDagOverview(plan)).toContain("base -> ui");
	});

	it("quotes ambiguous command arguments", () => {
		expect(
			formatCommand({ command: "npm", args: ["test", "--", "UI suite"] }),
		).toBe('npm test -- "UI suite"');
	});

	it("summarizes the exact revision, worker limit, and side-effect boundary", () => {
		const run = createOrchestrationRun({
			id: "run-1",
			repositoryRoot: "/repo",
			baseBranch: "main",
			baseCommit: "abc123",
			integrationBranch: "conductor/run-1/integration",
			request: { sourcePath: "/repo/request.md", text: "Build it" },
			plan,
			maxConcurrentWorkers: 3,
			now: "2026-01-01T00:00:00.000Z",
		});
		const summary = renderApprovalSummary(run);
		expect(summary).toContain("Plan revision: 1");
		expect(summary).toContain("Worker limit: 3");
		expect(summary).toContain("base (Base) paths: src/base/");
		expect(summary).toContain('npm test -- "UI suite"');
		expect(summary).toContain("npm run check");
		expect(summary).toContain(
			"No Git refs, worktrees, workers, or validation commands have started.",
		);
	});

	it("renders the approved capabilities and external-effect boundary for every step", () => {
		const run = createOrchestrationRun({
			id: "run-1",
			repositoryRoot: "/repo",
			baseBranch: "main",
			baseCommit: "abc123",
			integrationBranch: "conductor/run-1/integration",
			request: { sourcePath: "/repo/request.md", text: "Build it" },
			securityPolicy: readSecurityPolicy({}),
			plan,
			maxConcurrentWorkers: 3,
			now: "2026-01-01T00:00:00.000Z",
		});
		const summary = renderApprovalSummary(run);
		expect(summary).toContain("Step authority:");
		expect(summary).toContain(
			"authority: change step; capabilities: read-repository, execute-commands, mutate-repository",
		);
		expect(summary).toContain("external effects: forbidden");
		expect(summary).toContain(
			"External effects forbidden: no deployment, publishing, cloud administration",
		);
	});

	it("states the objective-level authority envelope the approval grants", () => {
		const run = createOrchestrationRun({
			id: "run-1",
			repositoryRoot: "/repo",
			baseBranch: "main",
			baseCommit: "abc123",
			integrationBranch: "conductor/run-1/integration",
			request: { sourcePath: "/repo/request.md", text: "Build it" },
			securityPolicy: readSecurityPolicy({}),
			plan,
			maxConcurrentWorkers: 3,
			now: "2026-01-01T00:00:00.000Z",
		});
		const summary = renderApprovalSummary(run);
		expect(summary).toContain("Authority envelope:");
		expect(summary).toContain("Outcome: Diamond build");
		// Acceptance criteria and reserved decisions appear nowhere else.
		expect(summary).toContain("  - Base works");
		expect(summary).toContain("  - UI works");
		expect(summary).toContain("    mutable paths: src/base/, src/ui/");
		expect(summary).toContain("Reserved for the user, always escalated:");
		expect(summary).toContain(
			"  - widen-mutation-authority: mutate a path or exercise a capability this envelope does not grant",
		);
	});

	it("marks derived authority for legacy policies without frozen profiles", () => {
		const run = createOrchestrationRun({
			id: "run-1",
			repositoryRoot: "/repo",
			baseBranch: "main",
			baseCommit: "abc123",
			integrationBranch: "conductor/run-1/integration",
			request: { sourcePath: "/repo/request.md", text: "Build it" },
			plan,
			maxConcurrentWorkers: 3,
			now: "2026-01-01T00:00:00.000Z",
		});
		expect(renderApprovalSummary(run)).toContain(
			"derived; this legacy policy predates frozen profiles",
		);
	});

	it("renders paths, limits, and per-kind checks for generalized workflow steps", () => {
		const workflowPlan = readWorkflowPlanDocument({
			version: WORKFLOW_PLAN_SCHEMA_VERSION,
			title: "Generalized",
			steps: [
				{
					id: "survey",
					kind: "investigation",
					title: "Survey",
					description: "Understand the code",
					dependencies: [],
					questions: ["Where does the server start?"],
					capabilities: ["read-repository"],
					timeoutMs: 60_000,
					retry: { maxAttempts: 2 },
					resourceLocks: ["npm-cache"],
				},
				{
					id: "verify",
					kind: "command",
					title: "Verify",
					description: "Run the build",
					dependencies: ["survey"],
					command: { command: "npm", args: ["run", "build"] },
				},
			],
		});
		const lines = renderStepAuthorityLines(
			workflowPlan,
			readSecurityPolicy({}),
		).join("\n");
		expect(lines).toContain("- survey (Survey) paths: none");
		expect(lines).toContain(
			"authority: investigation step; capabilities: read-repository; tools: read, grep, find, ls",
		);
		expect(lines).toContain(
			"limits: timeout 60000ms | retry up to 2 | resource locks: npm-cache",
		);
		expect(lines).toContain("check: npm run build");
		expect(lines).toContain(
			"authority: command step; capabilities: read-repository, execute-commands; tools: read, grep, find, ls, bash",
		);
	});
});
