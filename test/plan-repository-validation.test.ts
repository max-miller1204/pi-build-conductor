import { describe, expect, it } from "vitest";
import type { TaskDefinition, TaskPlan } from "../src/domain/types.js";
import {
	mutationScopesOverlap,
	renderPlanRepositoryIssues,
	validatePlanAgainstRepository,
} from "../src/planning/plan-repository-validation.js";
import type { DetectedValidationCommand } from "../src/planning/repository-discovery.js";

const repositoryPaths = [
	"package.json",
	"src/feature/index.ts",
	"src/feature/helper.ts",
	"src/other/index.ts",
	"test/feature.test.ts",
];

const detectedCommands: DetectedValidationCommand[] = [
	{
		label: "npm-run-check",
		command: "npm",
		args: ["run", "check"],
		source: "package.json#scripts.check",
	},
];

function task(
	overrides: Partial<TaskDefinition> & { id: string },
): TaskDefinition {
	return {
		title: overrides.id,
		description: "do the work",
		dependencies: [],
		acceptanceCriteria: ["done"],
		allowedPaths: ["src/feature/"],
		validationCommands: [{ command: "npm", args: ["run", "check"] }],
		...overrides,
	};
}

function plan(tasks: TaskDefinition[]): TaskPlan {
	return {
		version: 3,
		title: "Plan",
		tasks,
		finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
	};
}

function validate(input: TaskPlan) {
	return validatePlanAgainstRepository(input, {
		paths: repositoryPaths,
		detectedCommands,
	});
}

describe("validatePlanAgainstRepository paths", () => {
	it("accepts existing files, existing directories, and new files in existing directories", () => {
		const result = validate(
			plan([
				task({
					id: "a",
					allowedPaths: [
						"src/feature/",
						"src/feature/index.ts",
						"src/feature/created-later.ts",
						"new-root-file.md",
					],
				}),
			]),
		);
		expect(result.ok).toBe(true);
		expect(result.issues).toStrictEqual([]);
	});

	it("rejects directories that do not exist at the planned commit", () => {
		const result = validate(
			plan([task({ id: "a", allowedPaths: ["src/missing/"] })]),
		);
		expect(result.ok).toBe(false);
		expect(result.issues[0]?.code).toBe("unknown_path");
		expect(result.issues[0]?.taskIds).toStrictEqual(["a"]);
	});

	it("rejects new files whose parent directory does not exist", () => {
		const result = validate(
			plan([task({ id: "a", allowedPaths: ["src/missing/file.ts"] })]),
		);
		expect(result.ok).toBe(false);
		expect(result.issues[0]?.code).toBe("unknown_path");
		expect(result.issues[0]?.message).toContain("src/missing/");
	});
});

describe("validatePlanAgainstRepository commands", () => {
	it("warns about command binaries the repository does not define", () => {
		const result = validate(
			plan([
				task({
					id: "a",
					validationCommands: [{ command: "cargo", args: ["test"] }],
				}),
			]),
		);
		expect(result.ok).toBe(true);
		const warning = result.issues.find(
			(issue) => issue.code === "undetected_command",
		);
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toContain("cargo");
		expect(warning?.taskIds).toStrictEqual(["a"]);
	});

	it("accepts detected binaries with different focused arguments", () => {
		const result = validate(
			plan([
				task({
					id: "a",
					validationCommands: [
						{ command: "npm", args: ["test", "--", "test/feature.test.ts"] },
					],
				}),
			]),
		);
		expect(result.issues).toStrictEqual([]);
	});

	it("covers final validation commands", () => {
		const input = plan([task({ id: "a" })]);
		input.finalValidationCommands = [{ command: "tox", args: [] }];
		const result = validate(input);
		const warning = result.issues.find(
			(issue) => issue.code === "undetected_command",
		);
		expect(warning?.message).toContain("final validation");
		expect(warning?.taskIds).toStrictEqual([]);
	});
});

describe("validatePlanAgainstRepository mutation scopes", () => {
	it("rejects overlapping scopes between dependency-unordered tasks", () => {
		const result = validate(
			plan([
				task({ id: "a", allowedPaths: ["src/feature/"] }),
				task({ id: "b", allowedPaths: ["src/feature/index.ts"] }),
			]),
		);
		expect(result.ok).toBe(false);
		const conflict = result.issues.find(
			(issue) => issue.code === "conflicting_mutation_scopes",
		);
		expect(conflict?.taskIds).toStrictEqual(["a", "b"]);
		expect(conflict?.message).toContain("src/feature/");
	});

	it("accepts overlapping scopes when a dependency orders the tasks", () => {
		const result = validate(
			plan([
				task({ id: "a", allowedPaths: ["src/feature/"] }),
				task({
					id: "b",
					dependencies: ["a"],
					allowedPaths: ["src/feature/index.ts"],
				}),
			]),
		);
		expect(result.issues).toStrictEqual([]);
	});

	it("accepts overlap ordered through a transitive dependency chain", () => {
		const result = validate(
			plan([
				task({ id: "a", allowedPaths: ["src/feature/"] }),
				task({ id: "b", dependencies: ["a"], allowedPaths: ["src/other/"] }),
				task({
					id: "c",
					dependencies: ["b"],
					allowedPaths: ["src/feature/helper.ts"],
				}),
			]),
		);
		expect(result.issues).toStrictEqual([]);
	});

	it("accepts disjoint scopes on concurrent tasks", () => {
		const result = validate(
			plan([
				task({ id: "a", allowedPaths: ["src/feature/"] }),
				task({ id: "b", allowedPaths: ["src/other/", "test/feature.test.ts"] }),
			]),
		);
		expect(result.issues).toStrictEqual([]);
	});
});

describe("mutationScopesOverlap", () => {
	it.each([
		["src/a.ts", "src/a.ts", true],
		["src/", "src/a.ts", true],
		["src/a.ts", "src/", true],
		["src/", "src/", true],
		["src/", "srcond/a.ts", false],
		["src/a.ts", "src/b.ts", false],
		["src/sub/", "src/other/a.ts", false],
	])("overlap(%s, %s) = %s", (left, right, expected) => {
		expect(mutationScopesOverlap(left, right)).toBe(expected);
	});
});

describe("renderPlanRepositoryIssues", () => {
	it("renders one bounded line per issue", () => {
		const result = validate(
			plan([task({ id: "a", allowedPaths: ["src/missing/"] })]),
		);
		const lines = renderPlanRepositoryIssues(result.issues);
		expect(lines).toHaveLength(result.issues.length);
		expect(lines[0]).toMatch(/^- \[error\] unknown_path: /);
	});
});
