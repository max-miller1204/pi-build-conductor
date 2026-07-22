import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AttemptLogEntry,
	AttemptLogStore,
} from "../src/storage/attempt-log-store.js";
import type { WorkerProgressEvent } from "../src/workers/backend.js";

const directories: string[] = [];

async function temporaryStore(
	options: ConstructorParameters<typeof AttemptLogStore>[1] = {},
): Promise<AttemptLogStore> {
	const directory = await mkdtemp(join(tmpdir(), "attempt-log-store-"));
	directories.push(directory);
	return new AttemptLogStore(directory, options);
}

function progressEvents(entries: AttemptLogEntry[]): WorkerProgressEvent[] {
	return entries.flatMap((entry) =>
		entry.kind === "progress" ? [entry.event] : [],
	);
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("AttemptLogStore", () => {
	it("durably records ordered worker progress and terminal markers", async () => {
		let tick = 0;
		const store = await temporaryStore({
			now: () => `2026-01-01T00:00:0${tick++}.000Z`,
		});
		const events: WorkerProgressEvent[] = [
			{ type: "agent_started" },
			{ type: "text_delta", text: "Implementing" },
			{ type: "tool_started", toolName: "read" },
			{ type: "tool_finished", toolName: "read", isError: false },
			{ type: "retrying", message: "Temporary failure" },
			{
				type: "ui_blocked",
				requestId: "request-1",
				method: "confirm",
			},
			{
				type: "ui_decision",
				requestId: "request-1",
				method: "confirm",
				policy: "decline",
				outcome: "declined",
			},
			{
				type: "ui_resolved",
				requestId: "request-1",
				method: "confirm",
				outcome: "declined",
			},
		];
		for (const event of events) {
			store.record("run-1", "attempt-1", event);
		}
		store.recordTerminal("run-1", "attempt-1", {
			status: "succeeded",
			message: "Done",
		});

		await store.flush("run-1", "attempt-1");
		const entries = await store.readTail("run-1", "attempt-1");
		expect(progressEvents(entries)).toEqual(events);
		expect(entries.at(-1)).toMatchObject({
			kind: "terminal",
			status: "succeeded",
			message: "Done",
		});
		expect(entries.map((entry) => entry.kind)).toEqual([
			"progress",
			"progress",
			"progress",
			"progress",
			"progress",
			"progress",
			"progress",
			"progress",
			"terminal",
		]);

		const reopened = new AttemptLogStore(store.directory);
		expect(await reopened.readTail("run-1", "attempt-1")).toEqual(entries);
	});

	it("serializes rapid concurrent invocations separately per attempt", async () => {
		const store = await temporaryStore();
		for (let index = 0; index < 100; index += 1) {
			store.record("run-1", "attempt-a", {
				type: "text_delta",
				text: String(index),
			});
			store.record("run-1", "attempt-b", {
				type: "text_delta",
				text: `b-${index}`,
			});
		}

		await store.flush();
		expect(
			progressEvents(
				await store.readTail("run-1", "attempt-a", { maxLines: 100 }),
			).map((event) => (event.type === "text_delta" ? event.text : "")),
		).toEqual(Array.from({ length: 100 }, (_, index) => String(index)));
		expect(
			progressEvents(
				await store.readTail("run-1", "attempt-b", { maxLines: 100 }),
			).map((event) => (event.type === "text_delta" ? event.text : "")),
		).toEqual(Array.from({ length: 100 }, (_, index) => `b-${index}`));
	});

	it("uses strict identifiers and creates private files", async () => {
		const store = await temporaryStore();
		for (const id of ["../escape", "nested/id", ".", "bad id", "é"] as const) {
			expect(() =>
				store.record(id, "attempt-1", { type: "agent_started" }),
			).toThrow(/Unsafe run id/);
			expect(() =>
				store.record("run-1", id, { type: "agent_started" }),
			).toThrow(/Unsafe attempt id/);
		}

		store.record("run_1", "attempt-1", { type: "agent_started" });
		await store.flush("run_1", "attempt-1");
		const path = join(store.directory, "run_1", "attempt-1.jsonl");
		expect((await stat(path)).mode & 0o777).toBe(0o600);

		await chmod(path, 0o644);
		store.recordTerminal("run_1", "attempt-1", "failed", "No result");
		await store.flush("run_1", "attempt-1");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("returns empty for missing logs and applies line and byte tail bounds", async () => {
		const store = await temporaryStore({ tailLines: 2, tailBytes: 1_024 });
		expect(await store.readTail("missing", "attempt-1")).toEqual([]);

		for (const text of ["one", "two", "three"] as const) {
			store.record("run-1", "attempt-1", { type: "text_delta", text });
		}
		await store.flush("run-1", "attempt-1");
		expect(progressEvents(await store.readTail("run-1", "attempt-1"))).toEqual([
			{ type: "text_delta", text: "two" },
			{ type: "text_delta", text: "three" },
		]);
		expect(
			await store.readTail("run-1", "attempt-1", {
				maxLines: 10,
				maxBytes: 1,
			}),
		).toEqual([]);
	});

	it("sanitizes ANSI and control characters while preserving newline and tab", async () => {
		const store = await temporaryStore();
		store.record("run-1", "attempt-1", {
			type: "text_delta",
			text: "\u001b[31mred\u001b[0m\nnext\tcell\u0000\u0007\r",
		});
		store.record("run-1", "attempt-1", {
			type: "tool_started",
			toolName: "\u001b]0;owned\u0007shell\u007f",
		});
		store.record("run-1", "attempt-1", {
			type: "ui_blocked",
			requestId: "request\u0000-1",
			method: "input",
		});
		store.recordTerminal(
			"run-1",
			"attempt-1",
			"failed",
			"bad\u001b[2J\u0001\nreason",
		);

		const entries = await store.readTail("run-1", "attempt-1");
		expect(entries).toMatchObject([
			{
				kind: "progress",
				event: { type: "text_delta", text: "red\nnext\tcell" },
			},
			{
				kind: "progress",
				event: { type: "tool_started", toolName: "shell" },
			},
			{
				kind: "progress",
				event: {
					type: "ui_blocked",
					requestId: "request-1",
					method: "input",
				},
			},
			{ kind: "terminal", message: "bad\nreason" },
		]);
	});

	it("caps total bytes and writes exactly one truncation marker", async () => {
		const maxLogBytes = 320;
		const store = await temporaryStore({ maxLogBytes });
		for (let index = 0; index < 20; index += 1) {
			store.record("run-1", "attempt-1", {
				type: "text_delta",
				text: `${index}-${"x".repeat(40)}`,
			});
		}
		store.recordTerminal("run-1", "attempt-1", "failed", "ignored");
		await store.flush("run-1", "attempt-1");

		const path = join(store.directory, "run-1", "attempt-1.jsonl");
		const contents = await readFile(path, "utf8");
		expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(maxLogBytes);
		expect(contents.match(/"kind":"truncated"/g)).toHaveLength(1);
		expect(await store.readTail("run-1", "attempt-1")).toMatchObject([
			{ kind: "progress" },
			{ kind: "truncated" },
		]);

		const reopened = new AttemptLogStore(store.directory, { maxLogBytes });
		reopened.record("run-1", "attempt-1", { type: "agent_started" });
		await reopened.flush("run-1", "attempt-1");
		expect(await readFile(path, "utf8")).toBe(contents);
	});

	it("ignores a crash-partial final line and removes it before later appends", async () => {
		const store = await temporaryStore();
		store.record("run-1", "attempt-1", {
			type: "text_delta",
			text: "complete",
		});
		await store.flush("run-1", "attempt-1");
		const path = join(store.directory, "run-1", "attempt-1.jsonl");
		await appendFile(path, '{"kind":"progress","timestamp":', "utf8");

		const crashedReader = new AttemptLogStore(store.directory);
		expect(
			progressEvents(await crashedReader.readTail("run-1", "attempt-1")),
		).toEqual([{ type: "text_delta", text: "complete" }]);

		crashedReader.record("run-1", "attempt-1", {
			type: "text_delta",
			text: "after restart",
		});
		await crashedReader.flush("run-1", "attempt-1");
		expect(
			progressEvents(await crashedReader.readTail("run-1", "attempt-1")),
		).toEqual([
			{ type: "text_delta", text: "complete" },
			{ type: "text_delta", text: "after restart" },
		]);
	});

	it("rejects corrupt complete records inside a journal", async () => {
		const store = await temporaryStore();
		const runDirectory = join(store.directory, "run-1");
		const path = join(runDirectory, "attempt-1.jsonl");
		await mkdir(runDirectory, { recursive: true });
		await writeFile(
			path,
			[
				JSON.stringify({
					kind: "progress",
					timestamp: "2026-01-01T00:00:00.000Z",
					event: { type: "agent_started" },
				}),
				"{not-json}",
				JSON.stringify({
					kind: "terminal",
					timestamp: "2026-01-01T00:00:01.000Z",
					status: "succeeded",
				}),
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o600 },
		);

		await expect(store.readTail("run-1", "attempt-1")).rejects.toThrow(
			/Corrupt attempt log record/,
		);
	});
});
