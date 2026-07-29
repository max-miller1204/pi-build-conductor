import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkflowPlan } from "../src/domain/steps.js";
import {
	planStepArtifacts,
	type StepArtifactDraft,
	StepArtifactRoutingError,
} from "../src/engine/artifact-routing.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../src/engine/handlers.js";
import {
	changeStep,
	createWorkflowHarness,
	investigationStep,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

function handlerOf(
	kind: StepHandler["kind"],
	body: (context: StepHandlerContext) => Promise<StepOutcome>,
): StepHandler {
	return { kind, execute: body };
}

const findings: StepArtifactDraft = {
	output: "findings",
	kind: "findings",
	title: "Survey findings",
	payload: { format: "json", value: { modules: ["api", "ui"] } },
};

function stepWithOutputs(outputs: string[]) {
	const plan = validateWorkflowPlan({
		version: 4,
		title: "Plan",
		steps: [investigationStep("survey", [], { outputs })],
		finalValidationCommands: [{ command: "node", args: ["-e", ""] }],
	});
	const step = plan.steps[0];
	if (!step) {
		throw new Error("missing step");
	}
	return step;
}

afterEach(removeWorkflowHarnessDirectories);

describe("step artifact routing", () => {
	it("maps declared outputs onto canonical artifact write requests", () => {
		expect(
			planStepArtifacts("run-1", stepWithOutputs(["findings"]), 2, [findings]),
		).toEqual([
			{
				runId: "run-1",
				stepId: "survey",
				output: "findings",
				attempt: 2,
				kind: "findings",
				title: "Survey findings",
				payload: { format: "json", value: { modules: ["api", "ui"] } },
			},
		]);
	});

	it("rejects an artifact for an output the step never declared", () => {
		expect(() =>
			planStepArtifacts("run-1", stepWithOutputs([]), 1, [findings]),
		).toThrow(StepArtifactRoutingError);
	});

	it("rejects two artifacts for one output", () => {
		expect(() =>
			planStepArtifacts("run-1", stepWithOutputs(["findings"]), 1, [
				findings,
				findings,
			]),
		).toThrow(/more than one artifact/);
	});

	it("rejects a declared output the step did not produce", () => {
		expect(() =>
			planStepArtifacts("run-1", stepWithOutputs(["findings", "report"]), 1, [
				findings,
			]),
		).toThrow(/did not produce its declared output: report/);
	});
});

describe("workflow engine artifact routing", () => {
	it("stores produced outputs and hands them to the dependent step", async () => {
		const received: StepHandlerContext["execution"][] = [];
		const plan = workflowPlanOf([
			investigationStep("survey", [], { outputs: ["findings"] }),
			changeStep("api", ["survey"], ["src/api/"], {
				inputs: [{ stepId: "survey", output: "findings" }],
			}),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => ({
				status: "succeeded",
				summary: "surveyed",
				artifacts: [findings],
			})),
			handlerOf("change", async (context) => {
				received.push(context.execution);
				return { status: "succeeded" };
			}),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		const surveyAttempt = finished.attempts[0];
		expect(surveyAttempt?.artifactIds).toEqual(["survey.findings.1"]);

		const stored = await harness.artifacts.read(
			harness.initial.id,
			"survey.findings.1",
		);
		expect(stored).toMatchObject({
			stepId: "survey",
			output: "findings",
			attempt: 1,
			kind: "findings",
			mediaType: "application/json",
			title: "Survey findings",
		});
		expect(JSON.parse(stored.payload)).toEqual({ modules: ["api", "ui"] });

		const onDisk = await readFile(
			join(harness.artifactRoot, harness.initial.id, "survey.findings.1.json"),
			"utf8",
		);
		expect(JSON.parse(onDisk)).toMatchObject({ id: "survey.findings.1" });

		// The dependent step received the resolved upstream artifact.
		expect(received).toHaveLength(1);
		expect(received[0]?.upstreamArtifacts).toHaveLength(1);
		expect(received[0]?.upstreamArtifacts[0]).toMatchObject({
			stepId: "survey",
			output: "findings",
		});
		expect(received[0]?.upstreamArtifacts[0]?.artifact.contentHash).toBe(
			stored.contentHash,
		);

		expect(harness.events).toContainEqual(
			expect.objectContaining({
				kind: "artifact_published",
				stepId: "survey",
				output: "findings",
				artifactId: "survey.findings.1",
				artifactKind: "findings",
			}),
		);
	});

	it("fails a step that does not produce its declared output", async () => {
		const plan = workflowPlanOf([
			investigationStep("survey", [], { outputs: ["findings"] }),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => ({ status: "succeeded" })),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.survey?.state).toBe("failed");
		expect(finished.steps.survey?.error).toContain(
			"did not produce its declared output",
		);
		expect(finished.attempts).toHaveLength(1);
	});

	it("never retries an artifact contract violation", async () => {
		let attempts = 0;
		const plan = workflowPlanOf([
			investigationStep("survey", [], {
				outputs: ["findings"],
				retry: { maxAttempts: 3 },
			}),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => {
				attempts += 1;
				return {
					status: "succeeded",
					artifacts: [{ ...findings, output: "report" }],
				};
			}),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(attempts).toBe(1);
		expect(finished.state).toBe("failed");
		expect(finished.steps.survey?.error).toContain("undeclared output report");
	});

	it("keeps every attempt's artifacts and resolves the newest one", async () => {
		let attempts = 0;
		const received: StepHandlerContext["execution"][] = [];
		const plan = workflowPlanOf([
			investigationStep("survey", [], {
				outputs: ["findings"],
				retry: { maxAttempts: 2 },
			}),
			changeStep("api", ["survey"], ["src/api/"], {
				inputs: [{ stepId: "survey", output: "findings" }],
			}),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => {
				attempts += 1;
				if (attempts === 1) {
					return { status: "failed", error: "worker lost" };
				}
				return {
					status: "succeeded",
					artifacts: [
						{
							...findings,
							payload: { format: "json", value: { attempt: attempts } },
						},
					],
				};
			}),
			handlerOf("change", async (context) => {
				received.push(context.execution);
				return { status: "succeeded" };
			}),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(await harness.artifacts.list(harness.initial.id)).toHaveLength(1);
		expect(received[0]?.upstreamArtifacts[0]?.artifact.id).toBe(
			"survey.findings.2",
		);
	});

	it("fails closed when a step declares inputs no upstream step stored", async () => {
		const plan = workflowPlanOf([
			investigationStep("survey", [], { outputs: ["findings"] }),
			changeStep("api", ["survey"], ["src/api/"], {
				inputs: [{ stepId: "survey", output: "findings" }],
			}),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => ({
				status: "succeeded",
				artifacts: [findings],
			})),
			handlerOf("change", async () => ({ status: "succeeded" })),
		]);
		await harness.artifacts.pruneRun(harness.initial.id);
		const survey = harness.initial.steps.survey;
		if (!survey) {
			throw new Error("missing step");
		}
		harness.store.save({
			...harness.initial,
			steps: {
				...harness.initial.steps,
				survey: { ...survey, state: "succeeded" },
			},
		});

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain(
			"missing required inputs: survey.findings",
		);
	});
});
