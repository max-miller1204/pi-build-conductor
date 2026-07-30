import { describe, expect, it } from "vitest";
import type { RunSecurityPolicy } from "../src/domain/types.js";
import {
	capabilityProfileFor,
	defaultCapabilityProfiles,
	narrowCapabilityProfile,
	stepCapabilityProfile,
} from "../src/security/capabilities.js";
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

describe("capability profiles", () => {
	it("freezes a complete profile snapshot into new policies", () => {
		const policy = readSecurityPolicy({});

		expect(policy.version).toBe(2);
		expect(policy.workers.capabilityProfiles).toEqual(
			defaultCapabilityProfiles(),
		);
		expect(policy.workers.capabilityProfiles?.investigation).toEqual({
			capabilities: ["read-repository"],
			tools: ["read", "grep", "find", "ls"],
			resourceDiscovery: "disabled",
			externalEffects: "forbidden",
		});
		expect(policy.workers.capabilityProfiles?.approval).toEqual({
			capabilities: [],
			tools: [],
			resourceDiscovery: "disabled",
			externalEffects: "forbidden",
		});
		expect(policy.workers.capabilityProfiles?.change.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"edit",
			"write",
		]);
		assertRunSecurityPolicy(policy);
	});

	it("resolves worker launch authority from the frozen snapshot, not current defaults", () => {
		const policy = readSecurityPolicy({});
		if (!policy.workers.capabilityProfiles) {
			throw new Error("expected capability profiles");
		}
		// Simulate a run approved before an upgrade that would have widened
		// authority: the frozen snapshot keeps repair read-only.
		policy.workers.capabilityProfiles.repair = capabilityProfileFor([
			"read-repository",
		]);

		expect(workerLaunchPolicy(policy, "repair")?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		expect(workerLaunchPolicy(policy, "implementation")?.tools).toEqual(
			policy.workers.capabilityProfiles.change.tools,
		);
	});

	it("keeps version 1 policies on the historical fixed-role behavior", () => {
		const versionOne: RunSecurityPolicy = {
			...readSecurityPolicy({}),
			version: 1,
		};
		versionOne.workers = { ...versionOne.workers };
		delete versionOne.workers.capabilityProfiles;

		assertRunSecurityPolicy(versionOne);
		expect(workerLaunchPolicy(versionOne, "implementation")?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"edit",
			"write",
		]);
		expect(legacySecurityPolicy().version).toBe(1);
	});

	it("narrows frozen profiles to declared step capabilities without adding authority", () => {
		const profiles = defaultCapabilityProfiles();
		const narrowed = stepCapabilityProfile(profiles, {
			id: "refactor",
			kind: "change",
			title: "Refactor",
			description: "No commands needed",
			dependencies: [],
			capabilities: ["read-repository", "mutate-repository"],
			acceptanceCriteria: [],
			allowedPaths: ["src/"],
			validationCommands: [{ command: "npm", args: ["test"] }],
		});
		expect(narrowed.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"edit",
			"write",
		]);
		expect(narrowed.capabilities).toEqual([
			"read-repository",
			"mutate-repository",
		]);

		// Declaring capabilities beyond the frozen profile never adds tools.
		const widened = narrowCapabilityProfile(profiles.investigation, [
			"read-repository",
			"mutate-repository",
			"execute-commands",
		]);
		expect(widened.tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("fails closed on tampered stored profile snapshots", () => {
		const escalated = readSecurityPolicy({});
		escalated.workers.capabilityProfiles?.investigation.capabilities.push(
			"mutate-repository",
		);
		escalated.workers.capabilityProfiles?.investigation.tools.push("write");
		expect(() => assertRunSecurityPolicy(escalated)).toThrow(
			/exceeds the investigation profile authority/,
		);

		const unknownTool = readSecurityPolicy({});
		unknownTool.workers.capabilityProfiles?.change.tools.push("deploy");
		expect(() => assertRunSecurityPolicy(unknownTool)).toThrow(
			/outside the capability vocabulary/,
		);

		const orphanTool = readSecurityPolicy({});
		if (orphanTool.workers.capabilityProfiles) {
			orphanTool.workers.capabilityProfiles.review = {
				...orphanTool.workers.capabilityProfiles.review,
				tools: ["read", "bash"],
			};
		}
		expect(() => assertRunSecurityPolicy(orphanTool)).toThrow(
			/grants bash without the execute-commands capability/,
		);

		const missingProfile = readSecurityPolicy({});
		if (missingProfile.workers.capabilityProfiles) {
			delete (
				missingProfile.workers.capabilityProfiles as Partial<
					typeof missingProfile.workers.capabilityProfiles
				>
			).approval;
		}
		expect(() => assertRunSecurityPolicy(missingProfile)).toThrow(
			/must declare exactly the profiles/,
		);

		const profilesOnVersionOne = readSecurityPolicy({});
		(profilesOnVersionOne as { version: number }).version = 1;
		expect(() => assertRunSecurityPolicy(profilesOnVersionOne)).toThrow(
			/requires policy version 2/,
		);
	});
});
