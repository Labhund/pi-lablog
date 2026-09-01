import { parseNotebook, readToc, type ParsedNotebook } from "./notebook.js";
import type { Marker } from "./config.js";
import { readWeek } from "./stream.js";
import { hash12, isoWeek } from "./util.js";

/**
 * Derived, hash-addressed orientation digest (M1 structural layer).
 *
 * Recomputed from notebook + capture on every call: zero sync, cannot drift,
 * no sidecar state. Ids are 12-hex content hashes over normalized source text —
 * stable while content is unchanged; identity lives in the source, never the
 * summary. Decisions / Open questions / inquiry lines stay verbatim.
 */

export type DigestKind = "decision" | "day" | "open-q" | "op-note" | "inquiry" | "capture";

export interface DigestEntry {
	id: string;
	kind: DigestKind;
	/** MM-DD, or HH:MM for today's capture entries. */
	date: string;
	/** One-line index text. */
	text: string;
	/** Verbatim source text (shown on expansion). */
	full: string;
	/** Provenance: file:line or capture file+record id. */
	source: string;
}

export interface Digest {
	week: string;
	project: string;
	lablog: string;
	notebook: ParsedNotebook;
	entries: DigestEntry[];
	captureCount: number;
	lastCaptureTs?: string;
}

const CAPTURE_TAIL = 12;
const INDEX_TEXT_CAP = 72;
const ISO_TODAY = (d: Date): string => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const MD_TODAY = (d: Date): string => ISO_TODAY(d).slice(5);

export function normalizeForHash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function bulletDate(text: string, fallback: string): string {
	const m = /\b\d{4}-(\d{2})-(\d{2})\b/.exec(text);
	return m ? `${m[1]}-${m[2]}` : fallback;
}

/** Build the digest for the current ISO week (per-call fresh reads). */
export function buildDigest(marker: Marker, now = new Date()): Digest {
	const week = isoWeek(now);
	const today = MD_TODAY(now);
	const todayIso = ISO_TODAY(now);
	const nb = parseNotebook(marker.lablog, week, marker.project);
	const entries: DigestEntry[] = [];
	const seen = new Set<string>();

	const push = (kind: DigestKind, text: string, source: string, full?: string, date?: string): void => {
		const norm = normalizeForHash(text);
		if (!norm) return;
		const id = hash12(kind, norm);
		if (seen.has(id)) return;
		seen.add(id);
		entries.push({
			id,
			kind,
			date: date ?? bulletDate(norm, today),
			text: norm.length > INDEX_TEXT_CAP ? `${norm.slice(0, INDEX_TEXT_CAP - 1)}…` : norm,
			full: full ?? norm,
			source,
		});
	};

	for (const d of nb.days) push("day", d.title || d.heading, `${nb.path}:${d.line}`, d.heading, d.date);
	for (const b of nb.decisions) push("decision", b.text, `${nb.path}:${b.line}`);
	for (const b of nb.openQuestions) push("open-q", b.text, `${nb.path}:${b.line}`);
	for (const b of nb.opNotes) push("op-note", b.text, `${nb.path}:${b.line}`);
	for (const q of nb.inquiries) {
		const label = `[${q.state}]${q.id ? ` (${q.date ?? "—"}, ${q.id})` : ""} ${q.text}${q.reason ? ` §reason: ${q.reason}` : ""}`;
		push("inquiry", label, nb.path, `- ${q.raw}`, q.date);
	}

	const records = readWeek(marker.lablog, week).filter((r) => r.project === marker.project);
	for (const r of records.slice(-CAPTURE_TAIL)) {
		const date = r.ts.startsWith(todayIso) ? r.ts.slice(11, 16) : r.ts.slice(5, 10);
		push("capture", r.text, `capture/${week}.jsonl#${r.id}`, r.text, date);
	}

	return {
		week,
		project: marker.project,
		lablog: marker.lablog,
		notebook: nb,
		entries,
		captureCount: records.length,
		lastCaptureTs: records.at(-1)?.ts,
	};
}

export function orientMarkerLine(marker: Marker, d: Digest): string {
	const nbState = d.notebook.exists ? "in progress" : "none — draft per lablog skill";
	return `[lablog] ${marker.project} · ${d.week} · notebook: ${nbState} · orient: lablog_orient()`;
}

/** Compact index: header, TOC arc (1 line/week), then the hash-addressed entries. */
export function renderDigestIndex(d: Digest): string {
	const lines: string[] = [
		`digest ${d.project} · ${d.week} · notebook: ${d.notebook.exists ? "present" : "none — draft per lablog skill"} · capture: ${d.captureCount} record(s)${d.lastCaptureTs ? ` (last ${d.lastCaptureTs})` : ""}`,
	];
	const toc = readToc(d.lablog, d.project);
	if (toc.length > 0) {
		lines.push("arc:");
		for (const l of toc) lines.push(`  ${l}`);
	}
	lines.push("");
	for (const e of d.entries) {
		lines.push(`${e.id}  ${e.kind.padEnd(8)}  ${e.date.padEnd(5)}  ${e.text}`);
	}
	lines.push("(lablog_orient(<id>) expands an entry verbatim; ids are content hashes over source text)");
	return lines.join("\n");
}

/** Expand one entry by id: verbatim text + provenance. */
export function expandEntry(d: Digest, id: string): string | undefined {
	const e = d.entries.find((x) => x.id === id);
	if (!e) return undefined;
	return [`${e.id}  ${e.kind}  ${e.date}`, e.full, `— ${e.source}`].join("\n");
}
