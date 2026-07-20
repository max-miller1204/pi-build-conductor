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
	};
}

describe("validateTaskPlan", () => {
	it("accepts a valid DAG and returns a deterministic topological order", () => {
		const plan: TaskPlan = {
			version: 1,
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
				version: 1,
				title: "Bad",
				tasks: [task("api", ["missing"])],
			}),
		).toThrowError(/unknown task missing/);
	});

	it("rejects dependency cycles with the cycle path", () => {
		try {
			validateTaskPlan({
				version: 1,
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
				version: 1,
				title: "Duplicate",
				tasks: [task("same"), task("same")],
			}),
		).toThrowError(/duplicate task id/);
	});
});
