import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitClient } from "../src/git/git.js";
import { LocalFinalValidator } from "../src/validation/final-validator.js";
import { removeTemporaryDirectories } from "./helpers/cleanup.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-final-validator-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await removeTemporaryDirectories(directories);
});

describe("LocalFinalValidator", () => {
	it("runs the approved commands in order and records exact evidence", async () => {
		const worktreePath = await temporaryDirectory();
		let inspections = 0;
		const git = {
			async verifyDetachedWorktree(): Promise<void> {
				inspections += 1;
			},
		} as unknown as GitClient;
		const validator = new LocalFinalValidator(git);
		const evidence = await validator.validate({
			worktreePath,
			integrationCommit: "integration-head",
			commands: [
				{
					command: process.execPath,
					args: ["-e", "process.stdout.write('one')"],
				},
				{
					command: process.execPath,
					args: ["-e", "process.stdout.write('two')"],
				},
			],
		});

		expect(evidence.passed).toBe(true);
		expect(evidence.checks.map((check) => check.stdoutTail)).toEqual([
			"one",
			"two",
		]);
		expect(evidence.checks.every((check) => check.passed)).toBe(true);
		expect(inspections).toBe(3);
	});

	it("fails immediately when a command mutates the detached worktree", async () => {
		const worktreePath = await temporaryDirectory();
		let inspections = 0;
		const git = {
			async verifyDetachedWorktree(): Promise<void> {
				inspections += 1;
				if (inspections === 2) {
					throw new Error("dirty worktree");
				}
			},
		} as unknown as GitClient;
		const validator = new LocalFinalValidator(git);

		await expect(
			validator.validate({
				worktreePath,
				integrationCommit: "integration-head",
				commands: [
					{ command: process.execPath, args: ["-e", "process.exit(0)"] },
					{ command: process.execPath, args: ["-e", "process.exit(0)"] },
				],
			}),
		).rejects.toMatchObject({
			message: expect.stringMatching(/modified the worktree/),
			evidence: expect.objectContaining({ passed: false }),
		});
		expect(inspections).toBe(2);
	});

	it("terminates and records a timed-out command", async () => {
		const worktreePath = await temporaryDirectory();
		const git = {
			async verifyDetachedWorktree(): Promise<void> {},
		} as unknown as GitClient;
		const validator = new LocalFinalValidator(git, { commandTimeoutMs: 20 });

		await expect(
			validator.validate({
				worktreePath,
				integrationCommit: "integration-head",
				commands: [
					{
						command: process.execPath,
						args: ["-e", "setTimeout(() => {}, 10000)"],
					},
				],
			}),
		).rejects.toMatchObject({
			message: expect.stringMatching(/timed out/),
			evidence: expect.objectContaining({
				passed: false,
				checks: [expect.objectContaining({ passed: false })],
			}),
		});
	});
});
