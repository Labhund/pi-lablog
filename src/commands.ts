import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LABLOG, type Marker } from "./config.js";
import type { SessionState } from "./state.js";
import { saveState } from "./state.js";
import { readWeek } from "./stream.js";
import { isoWeek, nowLocal } from "./util.js";

export interface CommandApi {
	/** Current session's marker + state (marker resolved, state may be undefined). */
	get: (ctx: ExtensionContext) => { marker: Marker | undefined; state: SessionState | undefined };
	/** Manually declare a project for this session (cwd-gap fallback). */
	declare: (ctx: ExtensionContext, project: string, lablog: string) => void;
	/** Disable capture for this session. */
	disable: (ctx: ExtensionContext) => void;
	notify: (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
}

export function registerCommands(pi: ExtensionAPI, api: CommandApi): void {
	pi.registerCommand("lablog:status", {
		description: "Show lab log capture state for this session",
		handler: async (_args, ctx) => {
			const { marker, state } = api.get(ctx);
			const sessionId = ctx.sessionManager.getSessionId?.() ?? "(unknown)";
			const lines = [
				`session:  ${sessionId}`,
				`name:     ${ctx.sessionManager.getSessionName?.() ?? "(untitled)"}`,
			];
			if (!marker) {
				lines.push("capture:  OFF — no .lablog.toml marker found in or above the working directory");
				lines.push(`hint:     /lablog:on <project> [lablog-path] to declare this session manually`);
			} else if (!state || state.disabled) {
				lines.push(`capture:  OFF (disabled for this session) — project "${marker.project}"`);
			} else {
				lines.push(`capture:  ON`);
				lines.push(`project:  ${marker.project}`);
				lines.push(`lablog:   ${marker.lablog}`);
				lines.push(`week:     ${isoWeek()}`);
				lines.push(`records:  ${state.records} this session (last run ${state.lastRun ?? "never"})`);
				lines.push(`watermark: ${state.lastEntryId ?? "(none yet)"}`);
				if (state.lastError) lines.push(`last error: ${state.lastError}`);
			}
			api.notify(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lablog:view", {
		description: "Show the capture stream for a week (default: current), filtered to this project when capture is on",
		handler: async (args, ctx) => {
			const week = (args ?? "").trim() || isoWeek();
			const { marker, state } = api.get(ctx);
			const lablog = marker?.lablog ?? DEFAULT_LABLOG;
			const records = readWeek(lablog, week);
			const filtered =
				marker && state && !state.disabled ? records.filter((r) => r.project === marker.project) : records;
			if (filtered.length === 0) {
				api.notify(ctx, `lablog: no captures for ${week} in ${lablog}${marker ? ` (project ${marker.project})` : ""}`, "info");
				return;
			}
			const byProject = new Map<string, number>();
			for (const r of filtered) byProject.set(r.project, (byProject.get(r.project) ?? 0) + 1);
			const header = [
				`lablog ${week} — ${filtered.length} record(s)`,
				...Array.from(byProject.entries()).map(([p, n]) => `  ${p}: ${n}`),
				"",
			];
			const body = filtered
				.slice(-100)
				.map((r) => {
					const files = r.files.length ? ` [${r.files.join(", ")}]` : "";
					const om = r.om.length ? ` (om:${r.om.join(",")})` : "";
					return `[${r.ts}] ${r.project} ${r.kind}/${r.mode}: ${r.text}${om}${files}`;
				})
				.join("\n");
			api.notify(ctx, `${header.join("\n")}${body}`, "info");
		},
	});

	pi.registerCommand("lablog:on", {
		description: "Declare this session as working on a lab project (usage: /lablog:on <project> [lablog-path])",
		handler: async (args, ctx) => {
			const [project, lablog] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (!project) {
				api.notify(ctx, "lablog: usage: /lablog:on <project> [lablog-path]", "warning");
				return;
			}
			api.declare(ctx, project, (lablog ?? DEFAULT_LABLOG).trim());
			api.notify(ctx, `lablog: capture ON for project "${project}" (lablog: ${lablog ?? DEFAULT_LABLOG})`, "info");
		},
	});

	pi.registerCommand("lablog:off", {
		description: "Disable lab log capture for this session",
		handler: async (_args, ctx) => {
			api.disable(ctx);
			api.notify(ctx, "lablog: capture disabled for this session", "info");
		},
	});
}
