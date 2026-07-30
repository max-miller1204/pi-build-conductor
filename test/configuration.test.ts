import { describe, expect, it } from "vitest";
import { orchestratorConfigurationValue } from "../src/configuration.js";

describe("orchestratorConfigurationValue", () => {
	it("returns undefined when neither variable is set", () => {
		expect(orchestratorConfigurationValue("WORKER_TIMEOUT_MS", {})).toBe(
			undefined,
		);
	});

	it("prefers the neutral PI_ORCHESTRATOR variable", () => {
		expect(
			orchestratorConfigurationValue("WORKER_TIMEOUT_MS", {
				PI_ORCHESTRATOR_WORKER_TIMEOUT_MS: "1000",
			}),
		).toEqual({ name: "PI_ORCHESTRATOR_WORKER_TIMEOUT_MS", value: "1000" });
	});

	it("falls back to the legacy PI_BUILD variable", () => {
		expect(
			orchestratorConfigurationValue("WORKER_TIMEOUT_MS", {
				PI_BUILD_WORKER_TIMEOUT_MS: "2000",
			}),
		).toEqual({ name: "PI_BUILD_WORKER_TIMEOUT_MS", value: "2000" });
	});

	it("accepts both variables when their values agree", () => {
		expect(
			orchestratorConfigurationValue("WORKER_TIMEOUT_MS", {
				PI_ORCHESTRATOR_WORKER_TIMEOUT_MS: "1000",
				PI_BUILD_WORKER_TIMEOUT_MS: "1000",
			}),
		).toEqual({ name: "PI_ORCHESTRATOR_WORKER_TIMEOUT_MS", value: "1000" });
	});

	it("fails closed when both variables disagree", () => {
		expect(() =>
			orchestratorConfigurationValue("WORKER_TIMEOUT_MS", {
				PI_ORCHESTRATOR_WORKER_TIMEOUT_MS: "1000",
				PI_BUILD_WORKER_TIMEOUT_MS: "2000",
			}),
		).toThrow(
			"PI_ORCHESTRATOR_WORKER_TIMEOUT_MS and PI_BUILD_WORKER_TIMEOUT_MS are both set with different values; set only PI_ORCHESTRATOR_WORKER_TIMEOUT_MS",
		);
	});
});
