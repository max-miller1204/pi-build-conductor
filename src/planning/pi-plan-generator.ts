import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { validateTaskPlan } from "../domain/dag.js";
import type { TaskPlan } from "../domain/types.js";

const PLANNING_SYSTEM_PROMPT = `You are the planning stage of a software build conductor.
Turn the supplied handoff into a small, implementation-ready dependency DAG.
Return JSON only, with exactly this shape:
{
  "version": 1,
  "title": "short plan title",
  "tasks": [
    {
      "id": "lowercase-kebab-case",
      "title": "short task title",
      "description": "self-contained implementation instructions",
      "dependencies": ["task-id"],
      "acceptanceCriteria": ["observable criterion"]
    }
  ]
}
Every dependency must refer to another task in the plan.
The graph must be acyclic.
Prefer independently implementable tasks, but do not invent unnecessary parallelism.
Independent ready tasks may execute concurrently, so every prerequisite must be represented as an explicit dependency.
Every task must be executable from its description.`;

function unwrapJson(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced?.[1] ?? trimmed;
}

export function parseGeneratedPlan(text: string): TaskPlan {
	try {
		return validateTaskPlan(JSON.parse(unwrapJson(text)));
	} catch (error) {
		throw new Error("Planning agent returned an invalid task plan", {
			cause: error,
		});
	}
}

export async function generatePlanWithPi(
	ctx: ExtensionCommandContext,
	handoff: string,
): Promise<TaskPlan> {
	if (!ctx.model) {
		throw new Error("Select a model before running /build");
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(
			auth.ok ? `No API key for ${ctx.model.provider}` : auth.error,
		);
	}
	const message: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `Create the task DAG for this handoff:\n\n${handoff}`,
			},
		],
		timestamp: Date.now(),
	};
	const streamOptions = {
		apiKey: auth.apiKey,
		...(auth.headers ? { headers: auth.headers } : {}),
		...(auth.env ? { env: auth.env } : {}),
	};
	const response = await complete(
		ctx.model,
		{ systemPrompt: PLANNING_SYSTEM_PROMPT, messages: [message] },
		streamOptions,
	);
	const text = response.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n");
	if (!text) {
		throw new Error(`Planning agent returned no text (${response.stopReason})`);
	}
	return parseGeneratedPlan(text);
}
