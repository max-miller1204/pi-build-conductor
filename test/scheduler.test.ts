import { describe, expect, it } from "vitest";
import {
	getLaunchableTaskIds,
	reconcileTaskStates,
} from "../src/domain/scheduler.js";
import type {
	OrchestrationRun,
	TaskDefinition,
	TaskPlan,
	TaskState,
} from "../src/domain/types.js";
import { legacySecurityPolicy } from "../src/security/policy.js";

function definition(id: string, dependencies: string[] = []): TaskDefinition {
	return {
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} works`],
		allowedPaths: [`src/${id}/`],
		validationCommands: [{ command: "npm", args: ["test"] }],
	};
}

function runWith(
	states: Record<string, TaskState>,
	maxConcurrentWorkers = 2,
): OrchestrationRun {
	const definitions = [
		definition("base"),
		definition("api", ["base"]),
		definition("ui", ["base"]),
		definition("release", ["api", "ui"]),
	];
	const plan: TaskPlan = {
		version: 3,
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
		title: "Build",
		tasks: definitions,
	};
	return {
		schemaVersion: 9,
		revision: 0,
		id: "run-1",
		state: "running",
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "abc",
		integrationBranch: "conductor/run-1/integration",
		request: { sourcePath: "/repo/request.md", text: "Build it" },
		securityPolicy: legacySecurityPolicy(),
		plan,
		planRevision: 1,
		planRevisions: [
			{
				number: 1,
				createdAt: "2026-01-01T00:00:00.000Z",
				source: "generated",
				plan,
				maxConcurrentWorkers,
			},
		],
		approvedPlanRevision: 1,
		tasks: Object.fromEntries(
			definitions.map((item) => [
				item.id,
				{
					definition: item,
					state: states[item.id] ?? "planned",
					attemptIds: [],
					...(states[item.id] === "succeeded"
						? { integratedCommit: `integrated-${item.id}` }
						: {}),
				},
			]),
		),
		attempts: [],
		integrationHead: "abc",
		reviewRounds: [],
		reviewAttempts: [],
		repairAttempts: [],
		blockedWorkers: [],
		finalValidationAttempts: [],
		maxConcurrentWorkers,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		approvedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("scheduler", () => {
	it("makes root tasks ready", () => {
		const run = reconcileTaskStates(runWith({}));
		expect(run.tasks.base?.state).toBe("ready");
		expect(getLaunchableTaskIds(run)).toEqual(["base"]);
	});

	it("launches ready dependents up to the concurrency limit", () => {
		const run = runWith({ base: "succeeded" });
		expect(getLaunchableTaskIds(run)).toEqual(["api", "ui"]);
	});

	it("accounts for already running work", () => {
		const run = runWith({ base: "succeeded", api: "running" }, 2);
		expect(getLaunchableTaskIds(run)).toEqual(["ui"]);
	});

	it("counts prepared attempts and excludes their tasks defensively", () => {
		const run = runWith({ base: "succeeded" }, 2);
		run.attempts.push({
			id: "api-1",
			taskId: "api",
			number: 1,
			state: "prepared",
			branch: "api",
			worktreePath: "/api",
			baseCommit: run.baseCommit,
			startedAt: run.createdAt,
		});
		expect(getLaunchableTaskIds(run)).toEqual(["ui"]);
	});

	it("does not dispatch work for non-running runs", () => {
		for (const state of ["failed", "cancelled", "integrating"] as const) {
			expect(getLaunchableTaskIds({ ...runWith({}), state })).toEqual([]);
		}
	});

	it("propagates dependency blocking through the DAG in one pass", () => {
		const run = reconcileTaskStates(runWith({ base: "failed" }));
		expect(run.tasks.api?.state).toBe("blocked");
		expect(run.tasks.ui?.state).toBe("blocked");
		expect(run.tasks.release?.state).toBe("blocked");
		expect(getLaunchableTaskIds(run)).toEqual([]);
	});

	it("blocks downstream tasks after a dependency failure", () => {
		const run = reconcileTaskStates(
			runWith({ base: "succeeded", api: "failed", ui: "succeeded" }),
		);
		expect(run.tasks.release?.state).toBe("blocked");
		expect(getLaunchableTaskIds(run)).toEqual([]);
	});
});
