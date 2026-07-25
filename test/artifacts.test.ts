import { describe, expect, it } from "vitest";
import {
	ARTIFACT_KIND_FORMATS,
	ARTIFACT_KIND_MEDIA_TYPES,
	ARTIFACT_KINDS,
	ARTIFACT_RECORD_VERSION,
	type ArtifactRecord,
	artifactContentHash,
	artifactIdFor,
	artifactSummary,
	parseArtifactId,
	parseArtifactPayload,
	serializeArtifactPayload,
	validateArtifactRecord,
} from "../src/domain/artifacts.js";

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
	const payload = JSON.stringify(
		{ question: "Ship it?", decision: "yes", rationale: "Tests pass" },
		null,
		2,
	);
	return {
		version: ARTIFACT_RECORD_VERSION,
		id: "approve-approach.decision.1",
		runId: "run-1",
		stepId: "approve-approach",
		output: "decision",
		attempt: 1,
		kind: "decision",
		mediaType: "application/json",
		title: "Endpoint design decision",
		createdAt: "2026-01-01T00:00:00.000Z",
		sizeBytes: Buffer.byteLength(payload, "utf8"),
		contentHash: artifactContentHash(payload),
		payload,
		...overrides,
	};
}

describe("artifact identities", () => {
	it("declares the seven typed artifact kinds", () => {
		expect(ARTIFACT_KINDS).toEqual([
			"report",
			"decision",
			"findings",
			"test-evidence",
			"patch",
			"commit",
			"merge-candidate",
		]);
	});

	it("fixes one payload format and media type per kind", () => {
		for (const kind of ARTIFACT_KINDS) {
			expect(ARTIFACT_KIND_FORMATS[kind]).toMatch(/^(json|text)$/);
			expect(ARTIFACT_KIND_MEDIA_TYPES[kind]).toContain("/");
		}
		expect(ARTIFACT_KIND_FORMATS.report).toBe("text");
		expect(ARTIFACT_KIND_MEDIA_TYPES.patch).toBe("text/x-patch");
	});

	it("round-trips the canonical <stepId>.<output>.<attempt> id", () => {
		const id = artifactIdFor({
			stepId: "survey",
			output: "notes",
			attempt: 3,
		});
		expect(id).toBe("survey.notes.3");
		expect(parseArtifactId(id)).toEqual({
			stepId: "survey",
			output: "notes",
			attempt: 3,
		});
	});

	it("rejects identities that violate the step grammar", () => {
		expect(() =>
			artifactIdFor({ stepId: "Survey", output: "notes", attempt: 1 }),
		).toThrow(/stepId/);
		expect(() =>
			artifactIdFor({ stepId: "survey", output: "no.tes", attempt: 1 }),
		).toThrow(/output/);
		expect(() =>
			artifactIdFor({ stepId: "survey", output: "notes", attempt: 0 }),
		).toThrow(/attempt/);
		expect(() => parseArtifactId("survey.notes")).toThrow(/artifact id/);
		expect(() => parseArtifactId("survey.notes.x")).toThrow(/attempt/);
	});
});

describe("artifact payloads", () => {
	it("serializes JSON kinds deterministically and parses them back", () => {
		const payload = serializeArtifactPayload("findings", {
			format: "json",
			value: [{ id: "finding-1", severity: "high" }],
		});
		expect(JSON.parse(payload)).toEqual([
			{ id: "finding-1", severity: "high" },
		]);
		expect(parseArtifactPayload("findings", payload)).toEqual({
			format: "json",
			value: [{ id: "finding-1", severity: "high" }],
		});
	});

	it("stores text kinds verbatim", () => {
		const text =
			"# Investigation report\n\nThe server starts in src/main.ts.\n";
		expect(serializeArtifactPayload("report", { format: "text", text })).toBe(
			text,
		);
		expect(parseArtifactPayload("report", text)).toEqual({
			format: "text",
			text,
		});
	});

	it("rejects payload formats that do not match the kind", () => {
		expect(() =>
			serializeArtifactPayload("report", { format: "json", value: {} }),
		).toThrow(/report artifacts require a text payload/);
		expect(() =>
			serializeArtifactPayload("decision", {
				format: "text",
				text: "yes",
			}),
		).toThrow(/decision artifacts require a json payload/);
		expect(() =>
			serializeArtifactPayload("decision", {
				format: "json",
				value: undefined,
			}),
		).toThrow(/undefined JSON value/);
		expect(() => parseArtifactPayload("decision", "not json")).toThrow(
			/not valid JSON/,
		);
	});
});

describe("artifact record validation", () => {
	it("accepts an internally consistent record", () => {
		expect(validateArtifactRecord(record())).toEqual(record());
	});

	it("rejects identity, hash, and size mismatches", () => {
		expect(() =>
			validateArtifactRecord(record({ id: "other.decision.1" })),
		).toThrow(/does not match its identity/);
		expect(() => validateArtifactRecord(record({ sizeBytes: 5 }))).toThrow(
			/sizeBytes/,
		);
		expect(() =>
			validateArtifactRecord(
				record({ contentHash: artifactContentHash("tampered") }),
			),
		).toThrow(/contentHash does not match/);
		expect(() =>
			validateArtifactRecord(record({ mediaType: "text/plain" })),
		).toThrow(/mediaType/);
		expect(() =>
			validateArtifactRecord(record({ kind: "screenshot" as never })),
		).toThrow(/kind/);
		expect(() =>
			validateArtifactRecord(record({ version: 2 as never })),
		).toThrow(/version/);
	});

	it("rejects JSON-kind payloads that are not valid JSON", () => {
		const payload = "not json";
		expect(() =>
			validateArtifactRecord(
				record({
					payload,
					sizeBytes: Buffer.byteLength(payload, "utf8"),
					contentHash: artifactContentHash(payload),
				}),
			),
		).toThrow(/not valid JSON/);
	});

	it("summarizes a record without its payload", () => {
		const summary = artifactSummary(record());
		expect(summary).not.toHaveProperty("payload");
		expect(summary.id).toBe("approve-approach.decision.1");
		expect(summary.sizeBytes).toBe(record().sizeBytes);
	});
});
