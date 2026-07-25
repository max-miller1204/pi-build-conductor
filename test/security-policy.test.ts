import { describe, expect, it } from "vitest";
import {
	assertRunSecurityPolicy,
	legacySecurityPolicy,
	readSecurityPolicy,
	workerLaunchPolicy,
} from "../src/security/policy.js";

describe("run security policy", () => {
	it("creates an honest unsandboxed policy by default", () => {
		const policy = readSecurityPolicy({});

		expect(policy).toMatchObject({
			source: "configured",
			workers: {
				sandbox: "none",
				network: "host",
				toolPolicy: "server-allowlist-v1",
				resourceDiscovery: "disabled",
				uiPolicy: "decline",
			},
			validation: {
				sandbox: "none",
				network: "host",
				environment: "temporary-home-reduced",
			},
		});
		assertRunSecurityPolicy(policy);
	});

	it("requires a fixed absolute Nono executable and blocks network", () => {
		const policy = readSecurityPolicy({
			PI_BUILD_VALIDATION_SANDBOX: "nono",
			PI_BUILD_NONO_PATH: "/usr/local/bin/nono",
			PI_BUILD_WORKER_UI_POLICY: "cancel",
		});

		expect(policy.validation).toEqual({
			sandbox: "nono",
			network: "blocked",
			environment: "temporary-home-reduced",
			sandboxExecutable: "/usr/local/bin/nono",
		});
		expect(policy.workers.uiPolicy).toBe("cancel");
		assertRunSecurityPolicy(policy);
	});

	it("reads neutral PI_ORCHESTRATOR names and rejects conflicting aliases", () => {
		const policy = readSecurityPolicy({
			PI_ORCHESTRATOR_VALIDATION_SANDBOX: "nono",
			PI_ORCHESTRATOR_NONO_PATH: "/usr/local/bin/nono",
			PI_ORCHESTRATOR_WORKER_UI_POLICY: "cancel",
		});
		expect(policy.validation).toMatchObject({
			sandbox: "nono",
			network: "blocked",
			sandboxExecutable: "/usr/local/bin/nono",
		});
		expect(policy.workers.uiPolicy).toBe("cancel");
		expect(() =>
			readSecurityPolicy({
				PI_ORCHESTRATOR_VALIDATION_SANDBOX: "nono",
				PI_BUILD_VALIDATION_SANDBOX: "none",
			}),
		).toThrow(/both set with different values/);
	});

	it("rejects unknown, relative, and contradictory sandbox configuration", () => {
		expect(() =>
			readSecurityPolicy({ PI_BUILD_VALIDATION_SANDBOX: "container" }),
		).toThrow(/must be either none or nono/);
		expect(() =>
			readSecurityPolicy({
				PI_BUILD_VALIDATION_SANDBOX: "nono",
				PI_BUILD_NONO_PATH: "nono",
			}),
		).toThrow(/absolute path/);
		expect(() =>
			readSecurityPolicy({ PI_BUILD_NONO_PATH: "/usr/bin/nono" }),
		).toThrow(/requires/);
	});

	it("accepts persisted orchestrator policy names during server migration", () => {
		const policy = readSecurityPolicy({});
		policy.workers.toolPolicy = "orchestrator-allowlist-v1";

		assertRunSecurityPolicy(policy);
		expect(workerLaunchPolicy(policy, "review")?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
	});

	it("uses closed role allowlists and removes destructive reviewer tools", () => {
		const policy = readSecurityPolicy({});

		expect(workerLaunchPolicy(policy, "implementation")?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"edit",
			"write",
		]);
		expect(workerLaunchPolicy(policy, "review")?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		expect(workerLaunchPolicy(policy, "review")?.tools).not.toContain("bash");
		expect(
			workerLaunchPolicy(legacySecurityPolicy(), "review"),
		).toBeUndefined();
	});
});
