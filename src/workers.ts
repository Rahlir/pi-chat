import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

import { CHAT_HOME } from "./config.js";
import type { ResolvedConversation } from "./core/config-types.js";

export const SESSION_STATE_CUSTOM_TYPE = "pi-chat-state";
export const CHAT_CONVERSATION_FLAG = "chat-conversation";
const WORKER_TMUX_PREFIX = "pi-chat-worker-";
const DASHBOARD_TMUX_SESSION = "pi-chat-dashboard";
export const WORKER_STATUS_DIR = join(CHAT_HOME, "worker-status");

export interface WorkerStatusSnapshot {
	conversationId: string;
	conversationName: string;
	service: string;
	pid: number;
	cwd: string;
	sessionFile?: string;
	tmuxSession: string;
	state: "connected" | "error";
	updatedAt: string;
	model?: string;
	thinking?: string;
	contextPercent?: number | null;
	queueLength: number;
	hasActiveJob: boolean;
	chatTurnInFlight: boolean;
	recordCount: number;
	lastRecordId: number;
	lastError?: string;
}

export function tmuxSafeName(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "channel";
	return `${WORKER_TMUX_PREFIX}${safe}`.slice(0, 100);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function explicitExtensionCommandParts(): string[] {
	const parts: string[] = [];
	for (let i = 0; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if ((arg === "-e" || arg === "--extension") && process.argv[i + 1]) {
			parts.push(arg, shellQuote(process.argv[++i]));
		} else if (arg.startsWith("--extension=")) {
			parts.push("--extension", shellQuote(arg.slice("--extension=".length)));
		}
	}
	return parts;
}

export function ensureTmux(): void {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error("tmux not found. Install tmux and try again.");
}

function tmuxSessionExists(name: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function listTmuxSessions(): Set<string> {
	const result = spawnSync("tmux", ["list-sessions", "-F", "#S"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return new Set();
	return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function managedWorkerSessions(): string[] {
	return [...listTmuxSessions()].filter((name) => name.startsWith(WORKER_TMUX_PREFIX)).sort();
}

export function killManagedTmuxSessions(): string[] {
	const killed: string[] = [];
	for (const name of managedWorkerSessions()) {
		spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
		killed.push(name);
	}
	return killed;
}

export function workerStatusPath(conversationId: string): string {
	return join(WORKER_STATUS_DIR, `${tmuxSafeName(conversationId)}.json`);
}

async function readWorkerStatus(conversationId: string): Promise<WorkerStatusSnapshot | undefined> {
	try {
		return JSON.parse(await readFile(workerStatusPath(conversationId), "utf8")) as WorkerStatusSnapshot;
	} catch {
		return undefined;
	}
}

function formatStatusAge(updatedAt?: string): string {
	if (!updatedAt) return "no status";
	const ageMs = Date.now() - Date.parse(updatedAt);
	if (!Number.isFinite(ageMs) || ageMs < 0) return updatedAt;
	const seconds = Math.round(ageMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return `${hours}h ago`;
}

export async function formatWorkerStatus(conversations: ResolvedConversation[]): Promise<string> {
	const sessions = listTmuxSessions();
	const lines: string[] = [];
	for (const conversation of conversations) {
		const tmuxName = tmuxSafeName(conversation.conversationId);
		const snapshot = await readWorkerStatus(conversation.conversationId);
		const running = sessions.has(tmuxName);
		const state = snapshot?.lastError ? `error: ${snapshot.lastError}` : (snapshot?.state ?? "unknown");
		const queue = snapshot ? `q:${snapshot.queueLength}${snapshot.chatTurnInFlight ? " active" : ""}` : "q:?";
		const model = snapshot?.model ? ` ${snapshot.model}` : "";
		lines.push(
			`${running ? "●" : "○"} ${conversation.conversationName} — ${state}, ${queue}, ${formatStatusAge(snapshot?.updatedAt)}${model}\n  ${tmuxName}`,
		);
	}
	return lines.join("\n");
}

function runTmux(args: string[]): void {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.error || result.status !== 0)
		throw new Error(result.stderr.trim() || result.error?.message || "tmux failed");
}

export function createDashboardTmux(): string {
	const workers = managedWorkerSessions();
	if (workers.length === 0) throw new Error("No managed pi-chat workers are running.");
	if (tmuxSessionExists(DASHBOARD_TMUX_SESSION)) {
		spawnSync("tmux", ["kill-session", "-t", DASHBOARD_TMUX_SESSION], { stdio: "ignore" });
	}
	const attachCommand = (name: string) => `exec env -u TMUX tmux attach-session -t ${shellQuote(name)}`;
	runTmux(["new-session", "-d", "-s", DASHBOARD_TMUX_SESSION, "-n", "chats", attachCommand(workers[0])]);
	for (const worker of workers.slice(1)) {
		runTmux(["split-window", "-t", `${DASHBOARD_TMUX_SESSION}:chats`, attachCommand(worker)]);
	}
	runTmux(["select-layout", "-t", `${DASHBOARD_TMUX_SESSION}:chats`, "tiled"]);
	if (process.env.TMUX) runTmux(["switch-client", "-t", DASHBOARD_TMUX_SESSION]);
	return DASHBOARD_TMUX_SESSION;
}

export function spawnConversationTmux(
	ctx: ExtensionContext,
	conversation: ResolvedConversation,
	restart: boolean,
): string {
	const tmuxName = tmuxSafeName(conversation.conversationId);
	if (restart && tmuxSessionExists(tmuxName)) spawnSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
	if (tmuxSessionExists(tmuxName)) return `${conversation.conversationName}: already running (${tmuxName})`;

	const sessionDir = join(CHAT_HOME, "tmux-sessions", tmuxName);
	const session = SessionManager.continueRecent(ctx.cwd, sessionDir);
	session.appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, { conversationId: conversation.conversationId });
	session.appendSessionInfo(`pi-chat ${conversation.conversationName}`);
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error(`Could not create pi session for ${conversation.conversationName}`);

	const command = [
		"exec pi",
		"--session",
		shellQuote(sessionFile),
		"--session-dir",
		shellQuote(sessionDir),
		...explicitExtensionCommandParts(),
		`--${CHAT_CONVERSATION_FLAG}`,
		shellQuote(conversation.conversationId),
	].join(" ");
	const result = spawnSync("tmux", ["new-session", "-d", "-s", tmuxName, "-c", ctx.cwd, command], {
		encoding: "utf8",
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			result.stderr.trim() || result.error?.message || `tmux failed for ${conversation.conversationName}`,
		);
	}
	return `${conversation.conversationName}: started (${tmuxName})`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
