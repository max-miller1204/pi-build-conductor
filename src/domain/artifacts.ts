import { createHash } from "node:crypto";
import { isRecord } from "./dag.js";

export const ARTIFACT_RECORD_VERSION = 1 as const;

/**
 * The typed artifact kinds dependent steps coordinate through. Every kind
 * fixes one payload format and media type so consumers never guess how to
 * interpret a stored artifact.
 */
export const ARTIFACT_KINDS = [
	"report",
	"decision",
	"findings",
	"test-evidence",
	"patch",
	"commit",
	"merge-candidate",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactPayloadFormat = "json" | "text";

export const ARTIFACT_KIND_FORMATS: Record<
	ArtifactKind,
	ArtifactPayloadFormat
> = {
	report: "text",
	decision: "json",
	findings: "json",
	"test-evidence": "json",
	patch: "text",
	commit: "json",
	"merge-candidate": "json",
};

export const ARTIFACT_KIND_MEDIA_TYPES: Record<ArtifactKind, string> = {
	report: "text/markdown",
	decision: "application/json",
	findings: "application/json",
	"test-evidence": "application/json",
	patch: "text/x-patch",
	commit: "application/json",
	"merge-candidate": "application/json",
};

export const MAX_ARTIFACT_TITLE_LENGTH = 200 as const;
export const MAX_ARTIFACT_ID_LENGTH = 200 as const;
export const MAX_ARTIFACT_ATTEMPT = 9_999 as const;

// Matches the step id and output name grammar from the workflow plan schema;
// dots are excluded there, which keeps the three-part artifact id and its
// file name unambiguous.
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Identifies one produced value of one step output attempt within a run. */
export interface ArtifactIdentity {
	stepId: string;
	output: string;
	attempt: number;
}

export type ArtifactPayload =
	| { format: "json"; value: unknown }
	| { format: "text"; text: string };

/** The complete stored artifact: identity, metadata, and payload text. */
export interface ArtifactRecord {
	version: typeof ARTIFACT_RECORD_VERSION;
	id: string;
	runId: string;
	stepId: string;
	output: string;
	attempt: number;
	kind: ArtifactKind;
	mediaType: string;
	title: string;
	createdAt: string;
	sizeBytes: number;
	contentHash: string;
	payload: string;
}

export type ArtifactSummary = Omit<ArtifactRecord, "payload">;

function assertName(value: string, label: string): void {
	if (!NAME_PATTERN.test(value)) {
		throw new Error(
			`${label} ${JSON.stringify(value)} must match ${NAME_PATTERN}`,
		);
	}
}

function assertAttempt(attempt: number): void {
	if (
		!Number.isSafeInteger(attempt) ||
		attempt < 1 ||
		attempt > MAX_ARTIFACT_ATTEMPT
	) {
		throw new Error(
			`artifact attempt must be an integer from 1 to ${MAX_ARTIFACT_ATTEMPT}`,
		);
	}
}

/** Builds the canonical artifact id `<stepId>.<output>.<attempt>`. */
export function artifactIdFor(identity: ArtifactIdentity): string {
	assertName(identity.stepId, "artifact stepId");
	assertName(identity.output, "artifact output");
	assertAttempt(identity.attempt);
	const id = `${identity.stepId}.${identity.output}.${identity.attempt}`;
	if (id.length > MAX_ARTIFACT_ID_LENGTH) {
		throw new Error(
			`artifact id ${JSON.stringify(id)} exceeds ${MAX_ARTIFACT_ID_LENGTH} characters`,
		);
	}
	return id;
}

export function parseArtifactId(id: string): ArtifactIdentity {
	const parts = id.split(".");
	if (parts.length !== 3) {
		throw new Error(
			`artifact id ${JSON.stringify(id)} must be <stepId>.<output>.<attempt>`,
		);
	}
	const [stepId, output, attemptText] = parts as [string, string, string];
	if (!/^[0-9]+$/.test(attemptText)) {
		throw new Error(
			`artifact id ${JSON.stringify(id)} must end with a positive attempt number`,
		);
	}
	const identity: ArtifactIdentity = {
		stepId,
		output,
		attempt: Number(attemptText),
	};
	artifactIdFor(identity);
	return identity;
}

export function artifactContentHash(payload: string): string {
	return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * Serializes a typed payload into stored payload text, enforcing the payload
 * format the artifact kind declares.
 */
export function serializeArtifactPayload(
	kind: ArtifactKind,
	payload: ArtifactPayload,
): string {
	const format = ARTIFACT_KIND_FORMATS[kind];
	if (payload.format !== format) {
		throw new Error(
			`${kind} artifacts require a ${format} payload, received ${payload.format}`,
		);
	}
	if (payload.format === "text") {
		return payload.text;
	}
	if (payload.value === undefined) {
		throw new Error(`${kind} artifacts cannot store an undefined JSON value`);
	}
	const text = JSON.stringify(payload.value, null, 2);
	if (text === undefined) {
		throw new Error(`${kind} artifacts require a JSON-serializable value`);
	}
	return text;
}

/** Parses stored payload text back into the kind's typed payload. */
export function parseArtifactPayload(
	kind: ArtifactKind,
	payloadText: string,
): ArtifactPayload {
	if (ARTIFACT_KIND_FORMATS[kind] === "text") {
		return { format: "text", text: payloadText };
	}
	try {
		return { format: "json", value: JSON.parse(payloadText) as unknown };
	} catch (error) {
		throw new Error(`${kind} artifact payload is not valid JSON`, {
			cause: error,
		});
	}
}

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
}

/** Validates one stored artifact record, including internal consistency. */
export function validateArtifactRecord(value: unknown): ArtifactRecord {
	if (!isRecord(value)) {
		throw new Error("artifact record must be an object");
	}
	if (value.version !== ARTIFACT_RECORD_VERSION) {
		throw new Error(
			`artifact record version must be ${ARTIFACT_RECORD_VERSION}`,
		);
	}
	assertString(value.id, "artifact.id");
	assertString(value.runId, "artifact.runId");
	if (!RUN_ID_PATTERN.test(value.runId)) {
		throw new Error(`artifact.runId must match ${RUN_ID_PATTERN}`);
	}
	assertString(value.stepId, "artifact.stepId");
	assertString(value.output, "artifact.output");
	if (typeof value.attempt !== "number") {
		throw new Error("artifact.attempt must be a number");
	}
	const id = artifactIdFor({
		stepId: value.stepId,
		output: value.output,
		attempt: value.attempt,
	});
	if (value.id !== id) {
		throw new Error(
			`artifact.id ${JSON.stringify(value.id)} does not match its identity ${JSON.stringify(id)}`,
		);
	}
	if (
		typeof value.kind !== "string" ||
		!(ARTIFACT_KINDS as readonly string[]).includes(value.kind)
	) {
		throw new Error(
			`artifact.kind must be one of ${ARTIFACT_KINDS.join(", ")}`,
		);
	}
	const kind = value.kind as ArtifactKind;
	if (value.mediaType !== ARTIFACT_KIND_MEDIA_TYPES[kind]) {
		throw new Error(
			`artifact.mediaType must be ${ARTIFACT_KIND_MEDIA_TYPES[kind]} for ${kind} artifacts`,
		);
	}
	assertString(value.title, "artifact.title");
	if (value.title.length > MAX_ARTIFACT_TITLE_LENGTH) {
		throw new Error(
			`artifact.title exceeds ${MAX_ARTIFACT_TITLE_LENGTH} characters`,
		);
	}
	assertString(value.createdAt, "artifact.createdAt");
	if (typeof value.payload !== "string") {
		throw new Error("artifact.payload must be a string");
	}
	if (value.sizeBytes !== Buffer.byteLength(value.payload, "utf8")) {
		throw new Error("artifact.sizeBytes does not match the stored payload");
	}
	if (
		typeof value.contentHash !== "string" ||
		!CONTENT_HASH_PATTERN.test(value.contentHash)
	) {
		throw new Error("artifact.contentHash must be a sha256:<hex> digest");
	}
	if (value.contentHash !== artifactContentHash(value.payload)) {
		throw new Error("artifact.contentHash does not match the stored payload");
	}
	parseArtifactPayload(kind, value.payload);
	return {
		version: ARTIFACT_RECORD_VERSION,
		id,
		runId: value.runId,
		stepId: value.stepId,
		output: value.output,
		attempt: value.attempt,
		kind,
		mediaType: value.mediaType,
		title: value.title,
		createdAt: value.createdAt,
		sizeBytes: value.sizeBytes,
		contentHash: value.contentHash,
		payload: value.payload,
	};
}

export function artifactSummary(record: ArtifactRecord): ArtifactSummary {
	const { payload: _payload, ...summary } = record;
	return summary;
}
