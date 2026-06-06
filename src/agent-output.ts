import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export type AssistantRunMetadata = {
	stopReason?: string;
	errorMessage?: string;
};

export type AssistantUsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

// Join an assistant message's visible text, dropping thinking and tool-call blocks. Returns ""
// when the message produced only thinking/tool calls so callers can skip empty turns.
export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

// Walk to the most recent assistant message and report the terminal stop metadata callers branch on
// to decide how the run ended.
export function extractAssistantRunMetadata(messages: readonly AgentMessage[]): AssistantRunMetadata {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return { stopReason: message.stopReason, errorMessage: message.errorMessage };
	}
	return {};
}

// Sum token usage and cost across every assistant message recorded in the session log.
export function sumAssistantUsage(entries: readonly SessionEntry[]): AssistantUsageTotals {
	const totals: AssistantUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost.total;
	}
	return totals;
}
