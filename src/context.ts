import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findMarker } from "./config.js";

const BRIDGE_ROOT = "/tmp/pi-jupyter-context";
const RECEIVER_ROOT = join(BRIDGE_ROOT, "receivers");
const INBOX_ROOT = join(BRIDGE_ROOT, "inbox");
const KEY_RE = /[^A-Za-z0-9._-]+/g;
const HEARTBEAT_MS = 10_000;
const MAX_TEXT = 40_000;

interface ContextEnvelope {
	v?: number;
	id?: string;
	ts?: string;
	project?: string;
	notebook_path?: string;
	cell_index?: number | null;
	cell_id?: string | null;
	cell_type?: string | null;
	selection?: string;
	cell_source?: string;
	output?: string;
	instruction?: string;
	action?: string;
}

interface ReceiverState {
	project: string;
	sessionId: string;
	cwd: string;
	receiverPath: string;
	inboxPath: string;
	watcher?: ReturnType<typeof watch>;
	heartbeat?: ReturnType<typeof setInterval>;
	scanTimer?: ReturnType<typeof setTimeout>;
	claimed: Set<string>;
}

function key(value: string): string {
	return (value.trim().replace(KEY_RE, "_").replace(/^\.+/, "") || "default").slice(0, 100);
}

function gitRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (let i = 0; i < 20; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(cwd);
}

function projectFor(ctx: ExtensionContext): { project: string; root: string } | undefined {
	const marker = findMarker(ctx.cwd);
	const root = gitRoot(ctx.cwd);
	if (marker) return { project: marker.project, root };
	if (root !== resolve(ctx.cwd) || root.startsWith("/data2/loo_lab/")) {
		return { project: basename(root), root };
	}
	return undefined;
}

function writeReceiver(state: ReceiverState): void {
	mkdirSync(RECEIVER_ROOT, { recursive: true });
	writeFileSync(
		state.receiverPath,
		JSON.stringify({
			v: 1,
			project: state.project,
			session_id: state.sessionId,
			cwd: state.cwd,
			pid: process.pid,
			last_seen: Date.now() / 1000,
		}) + "\n",
		"utf8",
	);
}

function shorten(value: unknown, max = MAX_TEXT): string {
	const text = typeof value === "string" ? value : value == null ? "" : String(value);
	return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function formatContext(payload: ContextEnvelope): string {
	const selection = shorten(payload.selection);
	const source = shorten(payload.cell_source);
	const output = shorten(payload.output, 20_000);
	const notebookPath = shorten(payload.notebook_path, 2_000);
	const sourcePath = notebookPath.replace(/\.ipynb$/i, ".ju.py");
	const scope = selection ? "selected text and its containing cell" : "the complete cell";
	return [
		"The scientist explicitly sent context from a Jupyter notebook.",
		"",
		`Request: inspect and work on ${scope}.`,
		`Instruction: ${shorten(payload.instruction, 4_000)}`,
		`Notebook view: ${notebookPath}`,
		`Jupynium source to edit: ${sourcePath}`,
		`Project: ${shorten(payload.project, 500)}`,
		`Cell index: ${payload.cell_index ?? "unknown"}`,
		`Cell id: ${payload.cell_id ?? "unknown"}`,
		"",
		selection ? "Selected text:" : "Selected text: (none; use the complete cell)",
		selection ? "```python\n" + selection + "\n```" : "",
		"",
		"Complete cell source:",
		"```python\n" + source + "\n```",
		output ? "\nCell output/error:" : "",
		output ? "```text\n" + output + "\n```" : "",
		"",
		"This is exploratory notebook context. Inspect the actual project files before making changes; do not treat computed output as a canonical scientific fact.",
	].join("\n");
}

function isEnvelope(value: unknown): value is ContextEnvelope {
	if (!value || typeof value !== "object") return false;
	const p = value as ContextEnvelope;
	return p.v === 1 && typeof p.project === "string" && typeof p.notebook_path === "string" && typeof p.instruction === "string";
}

function processInbox(state: ReceiverState, pi: ExtensionAPI, ctx: ExtensionContext): void {
	let names: string[];
	try {
		names = readdirSync(state.inboxPath).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return;
	}
	const handledDir = join(state.inboxPath, "handled");
	mkdirSync(handledDir, { recursive: true });
	for (const name of names) {
		if (state.claimed.has(name)) continue;
		const source = join(state.inboxPath, name);
		const claimed = join(handledDir, `${state.sessionId}-${name}`);
		try {
			// Atomic rename means two Pi processes cannot both consume the same
			// context if a user happens to have parallel sessions open.
			renameSync(source, claimed);
			state.claimed.add(name);
			const payload = JSON.parse(readFileSync(claimed, "utf8")) as unknown;
			if (!isEnvelope(payload)) continue;
			const message = formatContext(payload);
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}
		} catch {
			// A half-written file or failed handoff remains recoverable in the
			// handled directory; never break the agent session over this bridge.
		}
	}
}

function closeReceiver(state: ReceiverState): void {
	if (state.scanTimer) clearTimeout(state.scanTimer);
	if (state.heartbeat) clearInterval(state.heartbeat);
	state.watcher?.close();
	try {
		rmSync(state.receiverPath, { force: true });
	} catch {
		/* best effort */
	}
}

/** Receive explicit cell context from the classic Notebook/Jupynium frontend. */
export function registerNotebookContext(pi: ExtensionAPI): void {
	const sessions = new Map<string, ReceiverState>();

	pi.on("session_start", (_event, ctx) => {
		const target = projectFor(ctx);
		if (!target) return;
		const sessionId = ctx.sessionManager.getSessionId?.();
		if (!sessionId) return;
		const project = key(target.project);
		const receiverPath = join(RECEIVER_ROOT, `${sessionId}.json`);
		const inboxPath = join(INBOX_ROOT, project, sessionId);
		mkdirSync(inboxPath, { recursive: true });
		const state: ReceiverState = {
			project,
			sessionId,
			cwd: target.root,
			receiverPath,
			inboxPath,
			claimed: new Set(),
		};
		writeReceiver(state);
		state.watcher = watch(inboxPath, () => {
			if (state.scanTimer) clearTimeout(state.scanTimer);
			state.scanTimer = setTimeout(() => processInbox(state, pi, ctx), 100);
		});
		state.heartbeat = setInterval(() => writeReceiver(state), HEARTBEAT_MS);
		sessions.set(sessionId, state);
		processInbox(state, pi, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId?.();
		if (!sessionId) return;
		const state = sessions.get(sessionId);
		if (state) {
			closeReceiver(state);
			sessions.delete(sessionId);
		}
	});
}
