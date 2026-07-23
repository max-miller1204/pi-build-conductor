import { describe, expect, it } from "vitest";
import {
	buildValidationInvocation,
	executeValidationCommand,
} from "../src/validation/command-runner.js";

const nonoPath = process.env.PI_BUILD_LIVE_NONO_PATH;

describe.runIf(Boolean(nonoPath))("live Nono validation sandbox", () => {
	it("runs with a temporary home, reduced credentials, and blocked network", async () => {
		if (!nonoPath) {
			throw new Error("PI_BUILD_LIVE_NONO_PATH is required");
		}
		const result = await executeValidationCommand(
			{
				command: process.execPath,
				args: [
					"-e",
					`(async () => {
						let networkBlocked = false;
						try {
							await fetch("https://example.com", { signal: AbortSignal.timeout(2000) });
						} catch {
							networkBlocked = true;
						}
						console.log(JSON.stringify({
							home: process.env.HOME,
							credentialPresent: process.env.PI_BUILD_NONO_SENTINEL !== undefined,
							networkBlocked,
						}));
						if (!networkBlocked) process.exitCode = 2;
					})()`,
				],
			},
			process.cwd(),
			undefined,
			10_000,
			64 * 1024,
			{
				sandbox: "nono",
				network: "blocked",
				environment: "temporary-home-reduced",
				sandboxExecutable: nonoPath,
			},
		);

		expect(result.exitCode, result.stderrTail).toBe(0);
		const evidenceLine = result.stdoutTail
			.split(/\r?\n/)
			.findLast((line) => line.trimStart().startsWith("{"));
		if (!evidenceLine) {
			throw new Error(`Nono child evidence was missing:\n${result.stdoutTail}`);
		}
		const evidence = JSON.parse(evidenceLine) as {
			home: string;
			credentialPresent: boolean;
			networkBlocked: boolean;
		};
		expect(evidence.home).toContain("pi-build-conductor-validation-");
		expect(evidence.credentialPresent).toBe(false);
		expect(evidence.networkBlocked).toBe(true);
		expect(result.executionBoundary).toEqual({
			sandbox: "nono",
			network: "blocked",
			environment: "temporary-home-reduced",
		});
	});

	it("uses the same fixed wrapper shape documented by the conductor", () => {
		if (!nonoPath) {
			throw new Error("PI_BUILD_LIVE_NONO_PATH is required");
		}
		expect(
			buildValidationInvocation(
				{ command: "node", args: ["--version"] },
				"/tmp/runtime",
				{
					sandbox: "nono",
					network: "blocked",
					environment: "temporary-home-reduced",
					sandboxExecutable: nonoPath,
				},
				{
					nonoProfilePath: "/tmp/control/profile.json",
					sourceEnvironment: { PATH: "/usr/bin:/bin" },
				},
			),
		).toEqual({
			command: nonoPath,
			args: [
				"run",
				"--profile",
				"/tmp/control/profile.json",
				"--allow-cwd",
				"--allow",
				"/tmp/runtime",
				"--block-net",
				"--",
				"node",
				"--version",
			],
		});
	});
});
