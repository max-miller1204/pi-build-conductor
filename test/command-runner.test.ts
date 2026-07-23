import { access, chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunSecurityPolicy } from "../src/domain/types.js";
import {
	buildValidationEnvironment,
	buildValidationInvocation,
	executeValidationCommand,
} from "../src/validation/command-runner.js";

const cannotRestrictDirectories =
	process.platform === "win32" || process.getuid?.() === 0;

const nonoValidation: RunSecurityPolicy["validation"] = {
	sandbox: "nono",
	network: "blocked",
	environment: "temporary-home-reduced",
	sandboxExecutable: "/opt/nono/bin/nono",
};

describe("validation command runner", () => {
	it("builds a reduced environment with an isolated home", () => {
		const environment = buildValidationEnvironment("/runtime", {
			PATH: "/bin",
			LANG: "C.UTF-8",
			ANTHROPIC_API_KEY: "secret",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			HOME: "/home/operator",
		});

		expect(environment).toMatchObject({
			PATH: "/bin",
			LANG: "C.UTF-8",
			HOME: "/runtime/home",
			XDG_CONFIG_HOME: "/runtime/config",
			TMPDIR: "/runtime/tmp",
			CI: "true",
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "Never",
		});
		expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
	});

	it("uses fixed Nono arguments without a shell", () => {
		expect(
			buildValidationInvocation(
				{ command: "npm", args: ["test", "--", "a; rm -rf /"] },
				"/runtime",
				nonoValidation,
				{
					nonoProfilePath: "/control/profile.json",
					sourceEnvironment: { PATH: "/usr/bin:/bin" },
				},
			),
		).toEqual({
			command: "/opt/nono/bin/nono",
			args: [
				"run",
				"--profile",
				"/control/profile.json",
				"--allow-cwd",
				"--allow",
				"/runtime",
				"--block-net",
				"--",
				"npm",
				"test",
				"--",
				"a; rm -rf /",
			],
		});
	});

	it("passes metacharacters as literal arguments and records its boundary", async () => {
		const hostile = "literal; echo not-a-shell && touch nowhere";
		const result = await executeValidationCommand(
			{
				command: process.execPath,
				args: [
					"-e",
					"console.log(JSON.stringify(process.argv.slice(1)))",
					hostile,
				],
			},
			process.cwd(),
			undefined,
			10_000,
			64 * 1024,
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdoutTail.trim())).toEqual([hostile]);
		expect(result.executionBoundary).toEqual({
			sandbox: "none",
			network: "host",
			environment: "temporary-home-reduced",
		});
	});

	it("removes the temporary runtime after execution", async () => {
		const result = await executeValidationCommand(
			{
				command: process.execPath,
				args: ["-e", "console.log(process.env.HOME)"],
			},
			process.cwd(),
			undefined,
			10_000,
			64 * 1024,
		);
		const home = result.stdoutTail.trim();

		expect(home).toContain("pi-build-conductor-validation-");
		await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(cannotRestrictDirectories)(
		"keeps the real exit code when the runtime cannot be removed",
		async () => {
			const result = await executeValidationCommand(
				{
					command: process.execPath,
					args: [
						"-e",
						[
							"const { chmodSync, mkdirSync, writeFileSync } = require('node:fs');",
							"const { join } = require('node:path');",
							"const locked = join(process.env.TMPDIR, 'locked');",
							"mkdirSync(locked, { recursive: true });",
							"writeFileSync(join(locked, 'cached.txt'), 'x');",
							"chmodSync(locked, 0o555);",
							"console.log(process.env.HOME);",
						].join("\n"),
					],
				},
				process.cwd(),
				undefined,
				10_000,
				64 * 1024,
			);
			const executionRoot = dirname(dirname(result.stdoutTail.trim()));
			await chmod(join(executionRoot, "runtime", "tmp", "locked"), 0o755);
			await rm(executionRoot, { recursive: true, force: true });

			expect(result.exitCode).toBe(0);
			expect(result.stderrTail).toContain(
				"Failed to remove validation runtime",
			);
		},
	);

	it("fails closed when the configured Nono executable is missing", async () => {
		const result = await executeValidationCommand(
			{ command: process.execPath, args: ["-e", "process.exit(99)"] },
			process.cwd(),
			undefined,
			10_000,
			64 * 1024,
			{
				...nonoValidation,
				sandboxExecutable: "/definitely/missing/nono",
			},
		);

		expect(result.exitCode).toBeNull();
		expect(result.stderrTail).toMatch(/ENOENT|no such file/i);
		expect(result.executionBoundary).toMatchObject({
			sandbox: "nono",
			network: "blocked",
		});
	});
});
