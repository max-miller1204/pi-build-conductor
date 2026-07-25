import { describe, expect, it } from "vitest";
import { createOrchestrationRun } from "../src/domain/run.js";
import type { TaskPlan } from "../src/domain/types.js";
import {
	formatCommand,
	renderApprovalSummary,
	renderDagOverview,
} from "../src/planning/plan-presentation.js";

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
});
