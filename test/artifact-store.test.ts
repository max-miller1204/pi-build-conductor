import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactContentHash } from "../src/domain/artifacts.js";
import {
	ArtifactStore,
	ArtifactStoreError,
	type ArtifactStoreOptions,
	type ArtifactWriteRequest,
} from "../src/storage/artifact-store.js";
import { removeTemporaryDirectories } from "./helpers/cleanup.js";

const directories: string[] = [];

async function temporaryStore(
	options: ArtifactStoreOptions = {},
): Promise<ArtifactStore> {
	const directory = await mkdtemp(join(tmpdir(), "artifact-store-"));
	directories.push(directory);
	let tick = 0;
	return new ArtifactStore(directory, {
		now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
		...options,
	});
}

function reportRequest(
	overrides: Partial<ArtifactWriteRequest> = {},
): ArtifactWriteRequest {
	return {
		runId: "run-1",
		stepId: "survey",
		output: "notes",
		attempt: 1,
		kind: "report",
		title: "Survey notes",
		payload: {
			format: "text",
			text: "# Survey\n\nThe HTTP server lifecycle lives in src/server.\n",
		},
		...overrides,
	};
}

async function expectCode(
	operation: Promise<unknown>,
	code: string,
): Promise<void> {
	await expect(operation).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof ArtifactStoreError && error.code === code,
	);
}

afterEach(async () => {
	await removeTemporaryDirectories(directories);
});

describe("ArtifactStore", () => {
	it("persists a typed artifact and reads it back by id and by latest output", async () => {
		const store = await temporaryStore();
		const written = await store.write(reportRequest());
		expect(written.id).toBe("survey.notes.1");
		expect(written.mediaType).toBe("text/markdown");
		expect(written.contentHash).toBe(artifactContentHash(written.payload));

		const read = await store.read("run-1", "survey.notes.1");
		expect(read).toEqual(written);
		expect(await store.latest("run-1", "survey", "notes")).toEqual(written);
		expect(await store.latest("run-1", "survey", "missing")).toBeUndefined();

		const listed = await store.list("run-1");
		expect(listed).toHaveLength(1);
		expect(listed[0]).not.toHaveProperty("payload");
		expect(listed[0]?.id).toBe("survey.notes.1");
	});

	it("stores JSON kinds as canonical JSON payloads", async () => {
		const store = await temporaryStore();
		const written = await store.write(
			reportRequest({
				stepId: "review",
				output: "findings",
				kind: "findings",
				title: "Review findings",
				payload: {
					format: "json",
					value: [{ id: "finding-1", severity: "high" }],
				},
			}),
		);
		expect(JSON.parse(written.payload)).toEqual([
			{ id: "finding-1", severity: "high" },
		]);
		const stored = JSON.parse(
			await readFile(
				join(store.directory, "run-1", "review.findings.1.json"),
				"utf8",
			),
		) as { payload: string };
		expect(JSON.parse(stored.payload)).toEqual([
			{ id: "finding-1", severity: "high" },
		]);
	});

	it("keeps artifacts immutable but treats identical rewrites as idempotent", async () => {
		const store = await temporaryStore();
		const first = await store.write(reportRequest());
		const replay = await store.write(reportRequest());
		expect(replay).toEqual(first);

		await expectCode(
			store.write(
				reportRequest({
					payload: { format: "text", text: "different content" },
				}),
			),
			"artifact_exists",
		);
		expect(await store.read("run-1", "survey.notes.1")).toEqual(first);
	});

	it("separates attempts so retries produce new artifacts", async () => {
		const store = await temporaryStore();
		await store.write(reportRequest());
		const second = await store.write(
			reportRequest({
				attempt: 2,
				payload: { format: "text", text: "Second attempt notes\n" },
			}),
		);
		expect((await store.latest("run-1", "survey", "notes"))?.id).toBe(
			"survey.notes.2",
		);
		expect(await store.read("run-1", "survey.notes.2")).toEqual(second);
		expect((await store.list("run-1")).map((artifact) => artifact.id)).toEqual([
			"survey.notes.1",
			"survey.notes.2",
		]);
	});

	it("enforces the per-artifact payload byte limit", async () => {
		const store = await temporaryStore({ maxArtifactBytes: 64 });
		await expectCode(
			store.write(
				reportRequest({
					payload: { format: "text", text: "x".repeat(65) },
				}),
			),
			"artifact_too_large",
		);
	});

	it("enforces the per-run artifact count limit", async () => {
		const store = await temporaryStore({ maxRunArtifacts: 2 });
		await store.write(reportRequest());
		await store.write(reportRequest({ attempt: 2 }));
		await expectCode(
			store.write(reportRequest({ attempt: 3 })),
			"artifact_count_exceeded",
		);
		// Identical replays stay idempotent even at the limit.
		await store.write(reportRequest({ attempt: 2 }));
	});

	it("enforces the per-run stored byte limit", async () => {
		const store = await temporaryStore({ maxRunBytes: 900 });
		await store.write(reportRequest());
		await expectCode(
			store.write(
				reportRequest({
					attempt: 2,
					payload: { format: "text", text: "y".repeat(600) },
				}),
			),
			"artifact_bytes_exceeded",
		);
	});

	it("retains only the newest configured attempts per output", async () => {
		const store = await temporaryStore({ retainedAttemptsPerOutput: 2 });
		await store.write(reportRequest());
		await store.write(
			reportRequest({
				stepId: "review",
				output: "findings",
				kind: "findings",
				title: "Review findings",
				payload: { format: "json", value: [] },
			}),
		);
		await store.write(
			reportRequest({
				attempt: 2,
				payload: { format: "text", text: "attempt 2\n" },
			}),
		);
		await store.write(
			reportRequest({
				attempt: 3,
				payload: { format: "text", text: "attempt 3\n" },
			}),
		);
		expect((await store.list("run-1")).map((artifact) => artifact.id)).toEqual([
			"review.findings.1",
			"survey.notes.2",
			"survey.notes.3",
		]);
	});

	it("retains every attempt by default", async () => {
		const store = await temporaryStore();
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			await store.write(
				reportRequest({
					attempt,
					payload: { format: "text", text: `attempt ${attempt}\n` },
				}),
			);
		}
		expect(await store.list("run-1")).toHaveLength(4);
	});

	it("isolates runs and prunes one run completely", async () => {
		const store = await temporaryStore();
		await store.write(reportRequest());
		await store.write(reportRequest({ runId: "run-2" }));
		await store.pruneRun("run-1");
		expect(await store.list("run-1")).toEqual([]);
		expect(await store.list("run-2")).toHaveLength(1);
	});

	it("surfaces corrupt records in scan without hiding healthy artifacts", async () => {
		const store = await temporaryStore();
		await store.write(reportRequest());
		await writeFile(
			join(store.directory, "run-1", "survey.tampered.1.json"),
			"{ not json",
			"utf8",
		);
		const entries = await store.scan("run-1");
		expect(entries).toHaveLength(2);
		expect(entries.filter((entry) => entry.kind === "artifact")).toHaveLength(
			1,
		);
		const unreadable = entries.find((entry) => entry.kind === "unreadable");
		expect(unreadable).toMatchObject({ fileName: "survey.tampered.1.json" });
		await expectCode(store.list("run-1"), "artifact_corrupt");
	});

	it("rejects records whose stored identity was moved to another location", async () => {
		const store = await temporaryStore();
		const written = await store.write(reportRequest());
		const source = join(store.directory, "run-1", "survey.notes.1.json");
		await writeFile(
			join(store.directory, "run-1", "survey.notes.2.json"),
			await readFile(source, "utf8"),
			"utf8",
		);
		await expectCode(store.read("run-1", "survey.notes.2"), "artifact_corrupt");
		expect(await store.read("run-1", "survey.notes.1")).toEqual(written);
	});

	it("rejects invalid identities, run ids, titles, and payload formats", async () => {
		const store = await temporaryStore();
		await expectCode(
			store.write(reportRequest({ runId: "../escape" })),
			"invalid_artifact",
		);
		await expectCode(
			store.write(reportRequest({ stepId: "Bad.Step" })),
			"invalid_artifact",
		);
		await expectCode(
			store.write(reportRequest({ title: "" })),
			"invalid_artifact",
		);
		await expectCode(
			store.write(
				reportRequest({
					payload: { format: "json", value: {} },
				}),
			),
			"invalid_artifact",
		);
		await expectCode(store.read("run-1", "not-an-id"), "invalid_artifact");
		await expectCode(
			store.read("run-1", "survey.notes.1"),
			"artifact_not_found",
		);
	});

	it("leaves no temporary files behind and restricts permissions", async () => {
		const store = await temporaryStore();
		await store.write(reportRequest());
		const runDirectory = join(store.directory, "run-1");
		const entries = await readdir(runDirectory);
		expect(entries).toEqual(["survey.notes.1.json"]);
		if (process.platform !== "win32") {
			const directoryStats = await stat(runDirectory);
			expect(directoryStats.mode & 0o777).toBe(0o700);
			const fileStats = await stat(join(runDirectory, "survey.notes.1.json"));
			expect(fileStats.mode & 0o777).toBe(0o600);
		}
	});

	it("survives concurrent identical writers with one durable record", async () => {
		const store = await temporaryStore();
		const results = await Promise.all([
			store.write(reportRequest()),
			store.write(reportRequest()),
			store.write(reportRequest()),
		]);
		for (const result of results) {
			expect(result.id).toBe("survey.notes.1");
			expect(result.payload).toBe(
				"# Survey\n\nThe HTTP server lifecycle lives in src/server.\n",
			);
		}
		expect(await store.list("run-1")).toHaveLength(1);
	});

	it("serializes concurrent writes before enforcing per-run count limits", async () => {
		const store = await temporaryStore({ maxRunArtifacts: 1 });
		const results = await Promise.allSettled([
			store.write(reportRequest()),
			store.write(reportRequest({ output: "other" })),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.some(
				(result) =>
					result.status === "rejected" &&
					result.reason instanceof ArtifactStoreError &&
					result.reason.code === "artifact_count_exceeded",
			),
		).toBe(true);
		expect(await store.list("run-1")).toHaveLength(1);
	});

	it("serializes concurrent writes before enforcing per-run byte limits", async () => {
		const store = await temporaryStore({
			maxRunArtifacts: 2,
			maxRunBytes: 700,
		});
		const results = await Promise.allSettled([
			store.write(reportRequest()),
			store.write(reportRequest({ output: "other" })),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.some(
				(result) =>
					result.status === "rejected" &&
					result.reason instanceof ArtifactStoreError &&
					result.reason.code === "artifact_bytes_exceeded",
			),
		).toBe(true);
		expect(await store.list("run-1")).toHaveLength(1);
	});
});
