import { chmod, mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { WorkerProgressEvent } from "../workers/backend.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const TRUNCATION_MESSAGE = "Log truncated after reaching byte limit";
const TRUNCATION_LINE = `${JSON.stringify({
	kind: "truncated",
	message: TRUNCATION_MESSAGE,
})}\n`;
const MINIMUM_LOG_BYTES = Buffer.byteLength(TRUNCATION_LINE);

export type AttemptTerminalStatus =
	| "succeeded"
	| "failed"
	| "aborted"
	| "cancelled"
	| "interrupted";

export interface AttemptTerminalMarker {
	status: AttemptTerminalStatus;
	message?: string;
}

export type AttemptLogEntry =
	| {
			kind: "progress";
			timestamp: string;
			event: WorkerProgressEvent;
	  }
	| {
			kind: "terminal";
			timestamp: string;
			status: AttemptTerminalStatus;
			message?: string;
	  }
	| {
			kind: "truncated";
			message: string;
	  };

export interface AttemptLogStoreOptions {
	maxLogBytes?: number;
	tailLines?: number;
	tailBytes?: number;
	now?: () => string;
}

export interface AttemptLogTailOptions {
	maxLines?: number;
	maxBytes?: number;
}

const TERMINAL_STATUSES: ReadonlySet<AttemptTerminalStatus> = new Set([
	"succeeded",
	"failed",
	"aborted",
	"cancelled",
	"interrupted",
]);

function assertSafeId(id: string, kind: "run" | "attempt"): void {
	if (!SAFE_ID.test(id)) {
		throw new Error(`Unsafe ${kind} id: ${id}`);
	}
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return value;
}

/** Remove terminal escape sequences and unsafe control characters. */
function sanitizeAttemptLogText(value: string): string {
	let sanitized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) {
			continue;
		}
		if (character === "\n" || character === "\t") {
			sanitized += character;
			continue;
		}
		if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
			continue;
		}
		sanitized += character;
	}
	return sanitized;
}

function sanitizeProgressEvent(
	event: WorkerProgressEvent,
): WorkerProgressEvent {
	switch (event.type) {
		case "agent_started":
			return { type: "agent_started" };
		case "text_delta":
			return { type: "text_delta", text: sanitizeAttemptLogText(event.text) };
		case "tool_started":
			return {
				type: "tool_started",
				toolName: sanitizeAttemptLogText(event.toolName),
			};
		case "tool_finished":
			return {
				type: "tool_finished",
				toolName: sanitizeAttemptLogText(event.toolName),
				isError: event.isError,
			};
		case "retrying":
			return {
				type: "retrying",
				message: sanitizeAttemptLogText(event.message),
			};
		default: {
			const unsupported: never = event;
			throw new Error(
				`Unsupported worker progress event: ${String(unsupported)}`,
			);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProgressEvent(
	value: unknown,
	context: string,
): WorkerProgressEvent {
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error(`Invalid progress event in ${context}`);
	}
	switch (value.type) {
		case "agent_started":
			return { type: "agent_started" };
		case "text_delta":
			if (typeof value.text === "string") {
				return {
					type: "text_delta",
					text: sanitizeAttemptLogText(value.text),
				};
			}
			break;
		case "tool_started":
			if (typeof value.toolName === "string") {
				return {
					type: "tool_started",
					toolName: sanitizeAttemptLogText(value.toolName),
				};
			}
			break;
		case "tool_finished":
			if (
				typeof value.toolName === "string" &&
				typeof value.isError === "boolean"
			) {
				return {
					type: "tool_finished",
					toolName: sanitizeAttemptLogText(value.toolName),
					isError: value.isError,
				};
			}
			break;
		case "retrying":
			if (typeof value.message === "string") {
				return {
					type: "retrying",
					message: sanitizeAttemptLogText(value.message),
				};
			}
			break;
		default:
			break;
	}
	throw new Error(`Invalid progress event in ${context}`);
}

function parseTerminalEntry(
	value: Record<string, unknown>,
	timestamp: string,
	context: string,
): AttemptLogEntry {
	if (
		typeof value.status !== "string" ||
		!TERMINAL_STATUSES.has(value.status as AttemptTerminalStatus) ||
		(value.message !== undefined && typeof value.message !== "string")
	) {
		throw new Error(`Corrupt attempt log record in ${context}`);
	}
	return {
		kind: "terminal",
		timestamp,
		status: value.status as AttemptTerminalStatus,
		...(typeof value.message === "string"
			? { message: sanitizeAttemptLogText(value.message) }
			: {}),
	};
}

function parseEntry(line: string, context: string): AttemptLogEntry {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error(`Corrupt attempt log record in ${context}`, {
			cause: error,
		});
	}
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new Error(`Corrupt attempt log record in ${context}`);
	}
	if (value.kind === "truncated" && typeof value.message === "string") {
		return {
			kind: "truncated",
			message: sanitizeAttemptLogText(value.message),
		};
	}
	if (typeof value.timestamp !== "string" || value.timestamp.length === 0) {
		throw new Error(`Corrupt attempt log record in ${context}`);
	}
	const timestamp = sanitizeAttemptLogText(value.timestamp);
	if (value.kind === "progress") {
		return {
			kind: "progress",
			timestamp,
			event: parseProgressEvent(value.event, context),
		};
	}
	if (value.kind === "terminal") {
		return parseTerminalEntry(value, timestamp, context);
	}
	throw new Error(`Corrupt attempt log record in ${context}`);
}

function completeLines(contents: Buffer, context: string): AttemptLogEntry[] {
	const text = contents.toString("utf8");
	const lines = text.split("\n");
	lines.pop();
	return lines.map((line, index) => {
		if (line.length === 0) {
			throw new Error(`Corrupt attempt log record in ${context}:${index + 1}`);
		}
		return parseEntry(line, `${context}:${index + 1}`);
	});
}

async function prepareJournal(
	runDirectory: string,
	path: string,
): Promise<boolean> {
	await mkdir(runDirectory, { recursive: true, mode: 0o700 });
	let contents: Buffer;
	try {
		contents = await readFile(path);
		await chmod(path, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		contents = Buffer.alloc(0);
	}
	if (contents.length > 0 && contents.at(-1) !== 0x0a) {
		const finalNewline = contents.lastIndexOf(0x0a);
		const completeLength = finalNewline < 0 ? 0 : finalNewline + 1;
		await truncate(path, completeLength);
		contents = contents.subarray(0, completeLength);
	}
	return completeLines(contents, path).some(
		(entry) => entry.kind === "truncated",
	);
}

async function appendDurably(path: string, line: string): Promise<void> {
	const handle = await open(path, "a", 0o600);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(line, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	const directoryHandle = await open(dirname(path), "r");
	try {
		await directoryHandle.sync();
	} finally {
		await directoryHandle.close();
	}
}

async function appendTruncationMarker(
	path: string,
	currentSize: number,
	maxLogBytes: number,
): Promise<void> {
	const markerBytes = Buffer.byteLength(TRUNCATION_LINE);
	if (currentSize + markerBytes > maxLogBytes) {
		const contents = await readFile(path);
		const limit = maxLogBytes - markerBytes;
		const newline = contents.subarray(0, limit).lastIndexOf(0x0a);
		const retainedBytes = newline < 0 ? 0 : newline + 1;
		await truncate(path, retainedBytes);
	}
	await appendDurably(path, TRUNCATION_LINE);
}

async function readJournal(
	path: string,
): Promise<AttemptLogEntry[] | undefined> {
	try {
		return completeLines(await readFile(path), path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function boundedTail(
	entries: AttemptLogEntry[],
	maxLines: number,
	maxBytes: number,
): AttemptLogEntry[] {
	const tail: AttemptLogEntry[] = [];
	let bytes = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (tail.length >= maxLines) {
			break;
		}
		const entry = entries[index];
		if (!entry) {
			continue;
		}
		const entryBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
		if (bytes + entryBytes > maxBytes) {
			break;
		}
		tail.push(entry);
		bytes += entryBytes;
	}
	return tail.toReversed();
}

export class AttemptLogStore {
	readonly directory: string;
	private readonly maxLogBytes: number;
	private readonly defaultTailLines: number;
	private readonly defaultTailBytes: number;
	private readonly now: () => string;
	private readonly queues = new Map<string, Promise<void>>();
	private readonly errors = new Map<string, unknown>();
	private readonly initialized = new Set<string>();
	private readonly truncated = new Set<string>();

	constructor(directory: string, options: AttemptLogStoreOptions = {}) {
		this.directory = directory;
		this.maxLogBytes = positiveInteger(
			options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
			"maxLogBytes",
		);
		if (this.maxLogBytes < MINIMUM_LOG_BYTES) {
			throw new Error(`maxLogBytes must be at least ${MINIMUM_LOG_BYTES}`);
		}
		this.defaultTailLines = positiveInteger(
			options.tailLines ?? DEFAULT_TAIL_LINES,
			"tailLines",
		);
		this.defaultTailBytes = positiveInteger(
			options.tailBytes ?? DEFAULT_TAIL_BYTES,
			"tailBytes",
		);
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private keyFor(runId: string, attemptId: string): string {
		assertSafeId(runId, "run");
		assertSafeId(attemptId, "attempt");
		return `${runId}\0${attemptId}`;
	}

	private pathFor(runId: string, attemptId: string): string {
		return join(this.directory, runId, `${attemptId}.jsonl`);
	}

	private enqueue(
		runId: string,
		attemptId: string,
		entry: AttemptLogEntry,
	): void {
		const key = this.keyFor(runId, attemptId);
		const previous = this.queues.get(key) ?? Promise.resolve();
		const operation = previous.then(
			() => this.append(key, runId, attemptId, entry),
			() => this.append(key, runId, attemptId, entry),
		);
		this.queues.set(
			key,
			operation.catch((error: unknown) => {
				if (!this.errors.has(key)) {
					this.errors.set(key, error);
				}
			}),
		);
	}

	private async initialize(
		key: string,
		runId: string,
		attemptId: string,
	): Promise<void> {
		if (this.initialized.has(key)) {
			return;
		}
		const path = this.pathFor(runId, attemptId);
		if (await prepareJournal(join(this.directory, runId), path)) {
			this.truncated.add(key);
		}
		this.initialized.add(key);
	}

	private async append(
		key: string,
		runId: string,
		attemptId: string,
		entry: AttemptLogEntry,
	): Promise<void> {
		await this.initialize(key, runId, attemptId);
		if (this.truncated.has(key)) {
			return;
		}
		const path = this.pathFor(runId, attemptId);
		let currentSize = 0;
		try {
			const fileStats = await stat(path);
			currentSize = fileStats.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
		const line = `${JSON.stringify(entry)}\n`;
		const markerBytes = Buffer.byteLength(TRUNCATION_LINE);
		try {
			if (
				currentSize + Buffer.byteLength(line) >
				this.maxLogBytes - markerBytes
			) {
				await appendTruncationMarker(path, currentSize, this.maxLogBytes);
				this.truncated.add(key);
				return;
			}
			await appendDurably(path, line);
		} catch (error) {
			this.initialized.delete(key);
			throw error;
		}
	}

	private timestamp(): string {
		const timestamp = sanitizeAttemptLogText(this.now());
		if (timestamp.length === 0) {
			throw new Error("Attempt log timestamp must not be empty");
		}
		return timestamp;
	}

	record(runId: string, attemptId: string, event: WorkerProgressEvent): void {
		this.enqueue(runId, attemptId, {
			kind: "progress",
			timestamp: this.timestamp(),
			event: sanitizeProgressEvent(event),
		});
	}

	recordTerminal(
		runId: string,
		attemptId: string,
		marker: AttemptTerminalMarker,
	): void;
	recordTerminal(
		runId: string,
		attemptId: string,
		status: AttemptTerminalStatus,
		message?: string,
	): void;
	recordTerminal(
		runId: string,
		attemptId: string,
		markerOrStatus: AttemptTerminalMarker | AttemptTerminalStatus,
		message?: string,
	): void {
		let marker: AttemptTerminalMarker;
		if (typeof markerOrStatus === "string") {
			marker = {
				status: markerOrStatus,
				...(message === undefined ? {} : { message }),
			};
		} else {
			marker = markerOrStatus;
		}
		if (!TERMINAL_STATUSES.has(marker.status)) {
			throw new Error(`Invalid terminal status: ${marker.status}`);
		}
		this.enqueue(runId, attemptId, {
			kind: "terminal",
			timestamp: this.timestamp(),
			status: marker.status,
			...(marker.message === undefined
				? {}
				: { message: sanitizeAttemptLogText(marker.message) }),
		});
	}

	async flush(runId?: string, attemptId?: string): Promise<void> {
		if ((runId === undefined) !== (attemptId === undefined)) {
			throw new Error("flush requires both runId and attemptId, or neither");
		}
		if (runId !== undefined && attemptId !== undefined) {
			const key = this.keyFor(runId, attemptId);
			await (this.queues.get(key) ?? Promise.resolve());
			const error = this.errors.get(key);
			if (error !== undefined) {
				this.errors.delete(key);
				throw error;
			}
			return;
		}
		const pending = [...this.queues.entries()];
		await Promise.all(pending.map(([, queue]) => queue));
		for (const [key] of pending) {
			const error = this.errors.get(key);
			if (error !== undefined) {
				this.errors.delete(key);
				throw error;
			}
		}
	}

	async readTail(
		runId: string,
		attemptId: string,
		options: AttemptLogTailOptions = {},
	): Promise<AttemptLogEntry[]> {
		const key = this.keyFor(runId, attemptId);
		await this.flush(runId, attemptId);
		const entries = await readJournal(this.pathFor(runId, attemptId));
		if (!entries) {
			return [];
		}
		if (entries.some((entry) => entry.kind === "truncated")) {
			this.truncated.add(key);
		}
		return boundedTail(
			entries,
			positiveInteger(options.maxLines ?? this.defaultTailLines, "maxLines"),
			positiveInteger(options.maxBytes ?? this.defaultTailBytes, "maxBytes"),
		);
	}
}
