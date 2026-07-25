import { describe, expect, it } from "vitest";
import {
	createOrchestrationRun,
	restoreRunPlanRevision,
	reviseRunPlan,
} from "../src/domain/run.js";
import type { OrchestrationRun, TaskPlan } from "../src/domain/types.js";
import {
	type PlanEditorPersistence,
	type PlanEditorSnapshot,
	type PlanEditorUI,
	reviewPlanInteractively,
} from "../src/planning/plan-editor.js";

const plan: TaskPlan = {
	version: 3,
	title: "Editable build",
	tasks: [
		{
			id: "base",
			title: "Base",
			description: "Build base",
			dependencies: [],
			acceptanceCriteria: ["Base works"],
			allowedPaths: ["src/base/"],
			validationCommands: [{ command: "npm", args: ["test"] }],
		},
		{
			id: "ui",
			title: "UI",
			description: "Build UI",
			dependencies: ["base"],
			acceptanceCriteria: ["UI works"],
			allowedPaths: ["src/ui/"],
			validationCommands: [{ command: "npm", args: ["test"] }],
		},
	],
	finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
};

function createRun(): OrchestrationRun {
	return createOrchestrationRun({
		id: "run-1",
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "abc123",
		integrationBranch: "conductor/run-1/integration",
		request: { sourcePath: "/repo/request.md", text: "Build it" },
		plan,
		maxConcurrentWorkers: 2,
		now: "2026-01-01T00:00:00.000Z",
	});
}

function snapshot(run: OrchestrationRun): PlanEditorSnapshot {
	return {
		plan: run.plan,
		maxConcurrentWorkers: run.maxConcurrentWorkers,
		planRevision: run.planRevision,
		planRevisions: run.planRevisions,
	};
}

class ScriptedUI implements PlanEditorUI {
	readonly notifications: string[] = [];
	readonly editorDrafts: Array<string | undefined> = [];

	constructor(
		private readonly selections: string[],
		private readonly inputs: string[] = [],
		private readonly edits: string[] = [],
	) {}

	async select(): Promise<string | undefined> {
		return this.selections.shift();
	}

	async input(): Promise<string | undefined> {
		return this.inputs.shift();
	}

	async editor(
		_title: string,
		prefilled?: string,
	): Promise<string | undefined> {
		this.editorDrafts.push(prefilled);
		return this.edits.shift();
	}

	notify(message: string): void {
		this.notifications.push(message);
	}
}

function persistence(initial: OrchestrationRun): {
	adapter: PlanEditorPersistence;
	current: () => OrchestrationRun;
} {
	let run = initial;
	return {
		adapter: {
			async save(candidate, maxConcurrentWorkers, expectedPlanRevision) {
				run = reviseRunPlan(run, {
					plan: candidate,
					maxConcurrentWorkers,
					expectedPlanRevision,
					now: `2026-01-01T00:0${run.planRevision}:00.000Z`,
				});
				return snapshot(run);
			},
			async restore(revisionNumber, expectedPlanRevision) {
				run = restoreRunPlanRevision(
					run,
					revisionNumber,
					expectedPlanRevision,
					`2026-01-01T00:0${run.planRevision}:00.000Z`,
				);
				return snapshot(run);
			},
			async reload() {
				return snapshot(run);
			},
		},
		current: () => run,
	};
}

describe("structured plan editor", () => {
	it("shows field validation without persisting invalid edges and saves worker limits", async () => {
		const run = createRun();
		const store = persistence(run);
		const ui = new ScriptedUI(
			[
				"Edit task dependencies",
				"base: Base",
				"Set worker limit",
				"4",
				"Continue to final approval",
			],
			["base"],
		);

		const result = await reviewPlanInteractively(
			ui,
			snapshot(run),
			store.adapter,
		);

		expect(result.action).toBe("continue");
		expect(store.current().planRevision).toBe(2);
		expect(store.current().maxConcurrentWorkers).toBe(4);
		expect(store.current().plan.tasks[0]?.dependencies).toEqual([]);
		expect(ui.notifications.join("\n")).toContain("self_dependency");
	});

	it("keeps invalid JSON in the active editor until it is corrected", async () => {
		const run = createRun();
		const store = persistence(run);
		const corrected = JSON.stringify({ ...plan, title: "Corrected JSON" });
		const ui = new ScriptedUI(
			["Edit full plan JSON", "Continue to final approval"],
			[],
			["{", corrected],
		);

		await reviewPlanInteractively(ui, snapshot(run), store.adapter);

		expect(ui.editorDrafts[1]).toBe("{");
		expect(store.current().plan.title).toBe("Corrected JSON");
		expect(ui.notifications.join("\n")).toContain("invalid_json");
	});

	it("three-way merges an unsaved candidate with unrelated concurrent edits", async () => {
		let current = createRun();
		let saveCalls = 0;
		const adapter: PlanEditorPersistence = {
			async save(candidate, maxConcurrentWorkers, expectedPlanRevision) {
				saveCalls += 1;
				if (saveCalls === 1) {
					current = reviseRunPlan(current, {
						plan: {
							...current.plan,
							tasks: current.plan.tasks.map((task) =>
								task.id === "base"
									? { ...task, title: "Concurrent base edit" }
									: task,
							),
						},
						maxConcurrentWorkers,
						expectedPlanRevision,
						now: "2026-01-01T00:01:00.000Z",
					});
				}
				current = reviseRunPlan(current, {
					plan: candidate,
					maxConcurrentWorkers,
					expectedPlanRevision,
					now: "2026-01-01T00:02:00.000Z",
				});
				return snapshot(current);
			},
			async restore() {
				return snapshot(current);
			},
			async reload() {
				return snapshot(current);
			},
		};
		const ui = new ScriptedUI(
			["Edit plan title", "Continue to final approval"],
			["Candidate edit"],
		);

		await reviewPlanInteractively(ui, snapshot(current), adapter);

		expect(current.planRevision).toBe(3);
		expect(current.plan.title).toBe("Candidate edit");
		expect(current.plan.tasks[0]?.title).toBe("Concurrent base edit");
		expect(ui.notifications.join("\n")).toContain("Stale plan revision");
		expect(ui.notifications.join("\n")).toContain(
			"Merged your unsaved changes",
		);
	});

	it("lets the user resolve a concurrent worker-limit conflict independently", async () => {
		let current = createRun();
		let saveCalls = 0;
		const adapter: PlanEditorPersistence = {
			async save(candidate, maxConcurrentWorkers, expectedPlanRevision) {
				saveCalls += 1;
				if (saveCalls === 1) {
					current = reviseRunPlan(current, {
						plan: current.plan,
						maxConcurrentWorkers: 3,
						expectedPlanRevision,
						now: "2026-01-01T00:01:00.000Z",
					});
				}
				current = reviseRunPlan(current, {
					plan: candidate,
					maxConcurrentWorkers,
					expectedPlanRevision,
					now: "2026-01-01T00:02:00.000Z",
				});
				return snapshot(current);
			},
			async restore() {
				return snapshot(current);
			},
			async reload() {
				return snapshot(current);
			},
		};
		const ui = new ScriptedUI([
			"Set worker limit",
			"4",
			"Use latest worker limit (3)",
			"Continue to final approval",
		]);

		await reviewPlanInteractively(ui, snapshot(current), adapter);

		expect(current.maxConcurrentWorkers).toBe(3);
		expect(ui.notifications.join("\n")).toContain("Stale plan revision");
	});

	it("treats menu dismissal as a resumable exit, not cancellation", async () => {
		const run = createRun();
		const store = persistence(run);
		const result = await reviewPlanInteractively(
			new ScriptedUI([]),
			snapshot(run),
			store.adapter,
		);

		expect(result.action).toBe("exit");
		expect(store.current().state).toBe("awaiting_approval");
	});

	it("renames a node and all incoming dependency references atomically", async () => {
		const run = createRun();
		const store = persistence(run);
		const ui = new ScriptedUI(
			["Rename a task node", "base: Base", "Continue to final approval"],
			["foundation"],
		);

		await reviewPlanInteractively(ui, snapshot(run), store.adapter);

		expect(store.current().plan.tasks.map((task) => task.id)).toEqual([
			"foundation",
			"ui",
		]);
		expect(store.current().plan.tasks[1]?.dependencies).toEqual(["foundation"]);
	});
});
