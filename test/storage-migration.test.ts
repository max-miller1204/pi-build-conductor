import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyOrchestratorStorage } from "../src/storage/storage-migration.js";
import { removeTemporaryDirectories } from "./helpers/cleanup.js";

const directories: string[] = [];

async function commonDirectoryFixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-storage-migration-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await removeTemporaryDirectories(directories);
});

describe("migrateLegacyOrchestratorStorage", () => {
	it("moves the complete legacy directory to the neutral location", async () => {
		const commonDirectory = await commonDirectoryFixture();
		const legacyRuns = join(commonDirectory, "pi-build-conductor", "runs");
		await mkdir(join(legacyRuns, "output"), { recursive: true });
		await writeFile(join(legacyRuns, "run-1.json"), "{}\n", "utf8");
		await writeFile(join(legacyRuns, "output", "run-1.log"), "log\n", "utf8");

		await migrateLegacyOrchestratorStorage(commonDirectory);

		const migratedRuns = join(commonDirectory, "pi-orchestrator", "runs");
		expect(await readFile(join(migratedRuns, "run-1.json"), "utf8")).toBe(
			"{}\n",
		);
		expect(
			await readFile(join(migratedRuns, "output", "run-1.log"), "utf8"),
		).toBe("log\n");
		await expect(
			readFile(join(legacyRuns, "run-1.json"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("is idempotent and a no-op without legacy state", async () => {
		const commonDirectory = await commonDirectoryFixture();
		await migrateLegacyOrchestratorStorage(commonDirectory);

		const legacyRuns = join(commonDirectory, "pi-build-conductor", "runs");
		await mkdir(legacyRuns, { recursive: true });
		await writeFile(join(legacyRuns, "run-1.json"), "{}\n", "utf8");
		await migrateLegacyOrchestratorStorage(commonDirectory);
		await migrateLegacyOrchestratorStorage(commonDirectory);

		const migratedRuns = join(commonDirectory, "pi-orchestrator", "runs");
		expect(await readFile(join(migratedRuns, "run-1.json"), "utf8")).toBe(
			"{}\n",
		);
	});

	it("fails closed when both locations still hold run snapshots", async () => {
		const commonDirectory = await commonDirectoryFixture();
		const legacyRuns = join(commonDirectory, "pi-build-conductor", "runs");
		const currentRuns = join(commonDirectory, "pi-orchestrator", "runs");
		await mkdir(legacyRuns, { recursive: true });
		await mkdir(currentRuns, { recursive: true });
		await writeFile(join(legacyRuns, "run-1.json"), "{}\n", "utf8");
		await writeFile(join(currentRuns, "run-2.json"), "{}\n", "utf8");

		await expect(
			migrateLegacyOrchestratorStorage(commonDirectory),
		).rejects.toThrow(/contain orchestrator run state/);
	});

	it("tolerates an abandoned legacy directory without run snapshots", async () => {
		const commonDirectory = await commonDirectoryFixture();
		const legacyRuns = join(commonDirectory, "pi-build-conductor", "runs");
		const currentRuns = join(commonDirectory, "pi-orchestrator", "runs");
		await mkdir(legacyRuns, { recursive: true });
		await mkdir(currentRuns, { recursive: true });
		await writeFile(join(legacyRuns, ".run-1.state"), "lock\n", "utf8");

		await migrateLegacyOrchestratorStorage(commonDirectory);
	});
});
