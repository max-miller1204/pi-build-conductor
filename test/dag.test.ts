import { describe, expect, it } from "vitest";
import {
	PlanValidationError,
	topologicalTaskIds,
	validateTaskPlan,
} from "../src/domain/dag.js";
import type { TaskPlan } from "../src/domain/types.js";

function task(id: string, dependencies: string[] = []) {
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

describe("validateTaskPlan", () => {
	it("accepts a valid DAG and returns a deterministic topological order", () => {
		const plan: TaskPlan = {
			version: 3,
			finalValidationCommands: [
				{ command: process.execPath, args: ["-e", ""] },
			],
			title: "Build",
			tasks: [
				task("foundation"),
				task("api", ["foundation"]),
				task("ui", ["foundation"]),
				task("docs", ["api"]),
			],
		};

		expect(validateTaskPlan(plan)).toEqual(plan);
		expect(topologicalTaskIds(plan)).toEqual([
			"foundation",
			"api",
			"ui",
			"docs",
		]);
	});

	it("rejects unknown dependencies", () => {
		expect(() =>
			validateTaskPlan({
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Bad",
				tasks: [task("api", ["missing"])],
			}),
		).toThrowError(/unknown task missing/);
	});

	it("rejects dependency cycles with the cycle path", () => {
		try {
			validateTaskPlan({
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Cycle",
				tasks: [task("one", ["two"]), task("two", ["one"])],
			});
			throw new Error("expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PlanValidationError);
			expect(String(error)).toContain("one -> two -> one");
		}
	});

	it("rejects duplicate task identifiers", () => {
		expect(() =>
			validateTaskPlan({
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Duplicate",
				tasks: [task("same"), task("same")],
			}),
		).toThrowError(/duplicate task id/);
	});

	it.each([
		"/etc/passwd",
		"../outside",
		"src/../outside",
		".git/config",
		"src/*.ts",
	])("rejects unsafe task scope %s", (allowedPath) => {
		expect(() =>
			validateTaskPlan({
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Unsafe scope",
				tasks: [{ ...task("unsafe"), allowedPaths: [allowedPath] }],
			}),
		).toThrow(/safe repository-relative|normalized/);
	});

	it("rejects missing focused validation commands", () => {
		expect(() =>
			validateTaskPlan({
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Unchecked",
				tasks: [{ ...task("unchecked"), validationCommands: [] }],
			}),
		).toThrow(/validationCommands must be a non-empty array/);
	});

	it("rejects legacy plans instead of silently weakening policy", () => {
		expect(() =>
			validateTaskPlan({
				version: 1,
				title: "Legacy",
				tasks: [task("legacy")],
			}),
		).toThrow(/version must be 3/);
	});
});
