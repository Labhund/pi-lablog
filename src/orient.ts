import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ORIENTATION, type Marker } from "./config.js";
import { buildDigest, expandEntry, orientMarkerLine, renderDigestIndex } from "./digest.js";
import { parseNotebook } from "./notebook.js";
import { renderGapView, renderTriageSheet } from "./gaps.js";
import { appendRecords } from "./stream.js";
import { hash12, isoWeek, nowLocal } from "./util.js";

/**
 * M1 orientation & steering (deterministic only, no model anywhere):
 *
 *  1. Session-start marker injection — `before_agent_start`, ~1 line, once per
 *     session. A pointer, never content; steering is the single imperative.
 *  2. `lablog_orient` tool — pull-side digest; `lablog_orient(<id>)` expands.
 *  3. Shutdown note — session closed with observations but no notebook update
 *     appends kind:"shutdown" to capture; feeds the gap view.
 *  4. `/lablog:gap` and `/lablog:triage` — the scientist's lens (read-only).
 */

export interface OrientSession {
	marker: Marker;
	sessionId: string;
	/** Capture records written by this session so far (0 = no observations). */
	records: number;
	startedAtMs: number;
	injected: boolean;
	shutdownNoted: boolean;
}

export interface OrientApi {
	get: (ctx: ExtensionContext) => OrientSession | undefined;
	notify: (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
}

export function registerOrientation(pi: ExtensionAPI, api: OrientApi): void {
	// 1. Marker injection (push, ~1 line, gated on lab-project detection).
	pi.on("before_agent_start", (_event, ctx) => {
		const s = api.get(ctx);
		if (!s || s.injected) return undefined;
		s.injected = true;
		if ((s.marker.orientation ?? DEFAULT_ORIENTATION).inject === "none") return undefined;
		try {
			const d = buildDigest(s.marker);
			return {
				message: {
					customType: "lablog.orientation",
					content: orientMarkerLine(s.marker, d),
					display: false,
				},
			};
		} catch {
			return undefined; // never break the turn over orientation
		}
	});

	// 2. lablog_orient tool (pull; mirrors observational-memory recall ergonomics).
	pi.registerTool({
		name: "lablog_orient",
		label: "Lablog orient",
		description:
			"Orientation digest for the current lab project, recomputed fresh from the week notebook and capture stream. " +
			"Call with no arguments for the compact hash-addressed index (decisions, open questions, op-notes, day sections, capture tail). " +
			"Pass an entry id (12-hex) to expand that entry verbatim with provenance. Orient here before substantive lab work.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "12-hex digest entry id from the index" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const s = api.get(ctx);
			if (!s) {
				return {
					content: [{ type: "text", text: "lablog: not in a lab project (no .lablog.toml, no git repo under the lab root)" }],
					details: {},
				};
			}
			try {
				const d = buildDigest(s.marker);
				const text = params.id
					? (expandEntry(d, params.id) ?? `lablog: no digest entry with id ${params.id} — call lablog_orient() for the current index`)
					: renderDigestIndex(d);
				return { content: [{ type: "text", text }], details: {} };
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text", text: `lablog: digest failed: ${msg}` }], details: {} };
			}
		},
	});

	// 3. Shutdown note: observations but no notebook update → kind:"shutdown" capture record.
	pi.on("session_shutdown", (_event, ctx) => {
		const s = api.get(ctx);
		if (!s || s.shutdownNoted) return;
		s.shutdownNoted = true;
		try {
			const { marker } = s;
			if (s.records === 0) return; // nothing observed → nothing owed to the record
			const week = isoWeek();
			const nb = parseNotebook(marker.lablog, week, marker.project);
			if (nb.exists && (nb.mtimeMs ?? 0) >= s.startedAtMs) return; // notebook was updated this session
			const nbState = nb.exists
				? `notebook last modified ${new Date(nb.mtimeMs ?? 0).toISOString().slice(0, 16).replace("T", " ")}`
				: `no notebook for ${week}`;
			appendRecords(marker.lablog, week, [
				{
					v: 1,
					id: hash12(s.sessionId, "shutdown", nowLocal()),
					ts: nowLocal(),
					week,
					project: marker.project,
					session: s.sessionId,
					kind: "shutdown",
					mode: "exploratory",
					text: `session closed without notebook update (${s.records} capture record(s) this session; ${nbState})`,
					om: [],
					source: [],
					files: [],
				},
			]);
		} catch {
			/* non-blocking: visibility comes from the record, never nagging */
		}
	});

	// 4. Scientist's lens (read-only commands).
	pi.registerCommand("lablog:gap", {
		description: "Lablog gap view: agent-independent divergence between capture/git and the notebook",
		handler: async (_args, ctx) => {
			const s = api.get(ctx);
			if (!s) {
				api.notify(ctx, "lablog: not in a lab project", "warning");
				return;
			}
			try {
				api.notify(ctx, renderGapView(s.marker), "info");
			} catch (e) {
				api.notify(ctx, `lablog: gap view failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});

	pi.registerCommand("lablog:triage", {
		description: "Lablog weekly triage sheet (read-only): open lines of inquiry + weekly evidence counts",
		handler: async (_args, ctx) => {
			const s = api.get(ctx);
			if (!s) {
				api.notify(ctx, "lablog: not in a lab project", "warning");
				return;
			}
			try {
				api.notify(ctx, renderTriageSheet(s.marker), "info");
			} catch (e) {
				api.notify(ctx, `lablog: triage sheet failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
			}
		},
	});
}
