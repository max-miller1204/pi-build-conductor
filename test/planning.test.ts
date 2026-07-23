import { describe, expect, it } from "vitest";
import { parseGeneratedPlan } from "../src/planning/pi-plan-generator.js";

const validPlan = {
	version: 3,
	finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	title: "Feature",
	tasks: [
		{
			id: "implementation",
			title: "Implementation",
			description: "Implement it",
			dependencies: [],
			acceptanceCriteria: ["Tests pass"],
			allowedPaths: ["src/feature/"],
			validationCommands: [{ command: "npm", args: ["test"] }],
		},
	],
};

describe("parseGeneratedPlan", () => {
	it("accepts JSON fenced by a planning model", () => {
		expect(
			parseGeneratedPlan(`\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``),
		).toEqual(validPlan);
	});

	it("rejects structurally invalid model output", () => {
		expect(() =>
			parseGeneratedPlan('{"version":2,"title":"Empty","tasks":[]}'),
		).toThrow(/invalid task plan/);
	});
});
