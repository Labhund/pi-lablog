import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple, type Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { Marker } from "./config.js";
import { collectOmObservations } from "./om.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import { isSourceEntry, serializeSourceAddressed, type EntryLike } from "./serialize.js";
import type { SessionState } from "./state.js";
import { saveState } from "./state.js";
import { appendRecords, readWeek, type CaptureRecord, KINDS, MODES } from "./stream.js";
import { estTokens, hash12, isoWeek, nowLocal } from "./util.js";

const MAX_TOOL_ROUNDS = 3;
const RAW_BUDGET_TOKENS = 12000;
/** Skip the model call entirely below this much new raw content (and no new OM observations). */
const MIN_RAW_TOKENS = 1500;
const TEXT_CAP = 2000;

interface NotifyFn {
	(message: string, type?: "info" | "warning" | "error"): void;
}

const RecordCapturesSchema = Type.Object({
	records: Type.Array(
		Type.Object({
			kind: Type.Union(KINDS.map((k) => Type.Literal(k))),
			mode: Type.Union(MODES.map((m) => Type.Literal(m))),
			text: Type.String({ minLength: 1 }),
			om: Type.Array(Type.String()),
			source: Type.Array(Type.String()),
			files: Type.Array(Type.String()),
		}),
		{ description: "New lab capture records for this session. May be an empty array." },
	),
});

function validateIds(
	ids: string[] | undefined,
	allowed: Set<string>,
	seenInOrder: string[],
): string[] {
	if (!ids || ids.length === 0) return [];
	const order = new Map(seenInOrder.map((id, i) => [id, i]));
	const out = new Map<string, number>();
	for (const id of ids) {
		const i = order.get(id);
		if (i === undefined) return []; // invented or stale id → reject the whole record
		out.set(id, i);
	}
	return Array.from(out.keys()).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

export interface RunCaptureDeps {
	notify?: NotifyFn;
	setLastError: (message: string) => void;
}

/**
 * One capture pass: find new branch entries since the watermark, re-project
 * them (with the new OM observations as primary evidence) into lab records,
 * and append them to the weekly stream. Returns the number of records added.
 */
export async function runCapture(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	marker: Marker,
	state: SessionState,
	deps: RunCaptureDeps,
): Promise<number> {
	const sessionId = state.sessionId;
	const sessionName = ctx.sessionManager.getSessionName?.();
	const branch = (ctx.sessionManager.getBranch() as EntryLike[]).slice().reverse(); // chronological

	// --- entries since the watermark -------------------------------------
	let startIdx = 0;
	if (state.lastEntryId) {
		const i = branch.findIndex((e) => e.id === state.lastEntryId);
		if (i >= 0) {
			startIdx = i + 1;
		} else {
			// Watermark not on this branch (tree navigation / fork): reprocess
			// only the tail after the latest compaction, and rely on dedup.
			const compactionIdx = branch.map((e) => e.type).lastIndexOf("compaction");
			startIdx = compactionIdx >= 0 ? compactionIdx + 1 : Math.max(0, branch.length - 40);
		}
	}
	const newEntries = branch.slice(startIdx);
	if (newEntries.length === 0) return 0;

	const omObs = collectOmObservations(newEntries);
	const raw = serializeSourceAddressed(newEntries.filter(isSourceEntry), RAW_BUDGET_TOKENS);
	if (omObs.length === 0 && estTokens(raw.text) < MIN_RAW_TOKENS) return 0; // nothing worth a model call

	// --- resolve model (session model, or marker override) ----------------
	let model: unknown = ctx.model;
	if (marker.modelProvider && marker.modelId) {
		const found = ctx.modelRegistry.find?.(marker.modelProvider, marker.modelId);
		if (found) model = found;
	}
	if (!model) {
		deps.setLastError("no model available for capture");
		return 0;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) {
		deps.setLastError("no auth for capture model");
		deps.notify?.(`lablog: capture skipped — no auth for capture model`, "warning");
		return 0;
	}

	// --- recent records for this session (dedup context) ------------------
	const week = isoWeek();
	const existing = readWeek(marker.lablog, week).filter((r) => r.session === sessionId);
	const seen = new Set(existing.map((r) => r.id));
	const recentLines =
		existing
			.slice(-10)
			.map((r) => `- [${r.kind}/${r.mode}] ${r.text}`)
			.join("\n") || "(none)";

	const omLines =
		omObs.map((o) => `[om:${o.id}] [${o.relevance}] ${o.content}`).join("\n") || "(none yet)";

	const userPrompt = buildUserPrompt({
		sessionId,
		sessionName,
		project: marker.project,
		week,
		cwd: ctx.cwd,
		now: nowLocal(),
		omLines,
		rawText: raw.text || "(none)",
		recentLines,
	});

	// --- model call with the record_captures tool (bounded rounds) --------
	const omIds = omObs.map((o) => o.id);
	const allowedOm = new Set(omIds);
	const allowedSource = new Set(raw.sourceEntryIds);

	const tool = {
		name: "record_captures",
		description:
			"Record new lab capture records for this session. Call multiple times as needed; stop when coverage is complete.",
		parameters: RecordCapturesSchema,
	};

	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
	];

	const records: CaptureRecord[] = [];
	let rejected = 0;

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const stream = streamSimple(model as any, { systemPrompt: SYSTEM_PROMPT, messages, tools: [tool as any] }, {
			apiKey: auth.apiKey,
			headers: auth.headers,
		} as any);
		let finalMsg: any;
		try {
			finalMsg = await stream.result();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			deps.setLastError(msg);
			deps.notify?.(`lablog: capture failed: ${msg}`, "warning");
			return records.length ? appendAndSave() : 0;
		}

		const calls = (finalMsg?.content ?? []).filter(
			(b: any) => b?.type === "toolCall" && b?.name === "record_captures",
		) as Array<{ id: string; arguments?: Record<string, unknown> }>;
		if (calls.length === 0) break;

		let addedThisRound = 0;
		let rejectedThisRound = 0;
		for (const call of calls) {
			const rawRecs = (call.arguments?.records ?? []) as Array<Record<string, unknown>>;
			for (const r of rawRecs) {
				if (typeof r.text !== "string" || !r.text.trim()) continue;
				const om = validateIds(
					Array.isArray(r.om) ? (r.om as string[]) : [],
					allowedOm,
					omIds,
				);
				const source = validateIds(
					Array.isArray(r.source) ? (r.source as string[]) : [],
					allowedSource,
					raw.sourceEntryIds,
				);
				if (om.length === 0 && source.length === 0) {
					rejectedThisRound++;
					rejected++;
					continue;
				}
				if (!KINDS.includes(r.kind as any) || !MODES.includes(r.mode as any)) continue;
				const id = hash12(sessionId, String(r.kind), String(r.mode), r.text, om.join(","));
				if (seen.has(id)) continue;
				seen.add(id);
				records.push({
					v: 1,
					id,
					ts: nowLocal(),
					week,
					project: marker.project,
					session: sessionId,
					...(sessionName ? { sessionName } : {}),
					kind: r.kind as CaptureRecord["kind"],
					mode: r.mode as CaptureRecord["mode"],
					text: r.text.slice(0, TEXT_CAP),
					om,
					source,
					files: Array.isArray(r.files) ? (r.files as string[]).slice(0, 10) : [],
				});
				addedThisRound++;
			}
		}

		// Feed results back so the model can continue or stop.
		messages.push(finalMsg as Message);
		for (const call of calls) {
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "record_captures",
				content: [
					{
						type: "text",
						text:
							`Recorded ${addedThisRound} new record(s)` +
							`${rejectedThisRound > 0 ? `; ${rejectedThisRound} rejected for missing or invalid provenance` : ""}. ` +
							`Total for this session so far: ${existing.length + records.length}. ` +
							`Continue if uncovered scientific content remains; otherwise stop and confirm.`,
					},
				],
				isError: false,
				timestamp: Date.now(),
			} as Message);
		}
	}

	return appendAndSave();

	function appendAndSave(): number {
		const added = appendRecords(marker.lablog, week, records);
		const last = newEntries[newEntries.length - 1];
		if (last?.id) state.lastEntryId = last.id;
		state.records += added;
		state.lastRun = nowLocal();
		saveState(state);
		if (added > 0 && marker.notify) {
			deps.notify?.(`lablog: +${added} capture(s) → ${week}/${marker.project}`, "info");
		}
		return added;
	}
}
