import { execFileSync } from "node:child_process";
import type { Marker } from "./config.js";
import { parseNotebook, type ParsedNotebook } from "./notebook.js";
import { readWeek } from "./stream.js";
import { isoWeek } from "./util.js";

/**
 * The scientist's lens: gaps computed between agent-independent artifacts
 * (capture jsonl, git) and agent-authored artifacts (notebook). Summaries can
 * lie; gaps computed from timestamps cannot. Deterministic only — no model.
 */

const STOP = new Set([
	"the", "and", "for", "that", "this", "with", "from", "into", "than", "then",
	"when", "what", "which", "their", "there", "have", "has", "had", "not", "but",
	"all", "any", "are", "was", "were", "will", "would", "should", "could", "been",
	"also", "its", "per", "via", "use", "used", "using", "need", "needs", "some",
]);

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, " ")
		.split(/\s+/)
		.filter((t) => t.length > 3 && !STOP.has(t));
}

function overlap(a: string[], b: Set<string>): number {
	return a.filter((t) => b.has(t)).length;
}

/** Draft state from the commit gate: changed week-notebook paths, or [] if clean/unavailable. */
export function gitUncommitted(lablog: string, week: string): string[] {
	try {
		const out = execFileSync("git", ["-C", lablog, "status", "--porcelain", "--", `weeks/${week}`], {
			encoding: "utf8",
		});
		return out.split("\n").map((l) => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

interface WeekFacts {
	week: string;
	notebook: ParsedNotebook;
	records: ReturnType<typeof readWeek>;
	lastCaptureTs?: string;
}

function weekFacts(marker: Marker, now: Date): WeekFacts {
	const week = isoWeek(now);
	const notebook = parseNotebook(marker.lablog, week, marker.project);
	const records = readWeek(marker.lablog, week).filter((r) => r.project === marker.project);
	return { week, notebook, records, lastCaptureTs: records.at(-1)?.ts };
}

function parseLocalTs(ts: string): number | undefined {
	const d = new Date(ts.replace(" ", "T"));
	return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

/** Gap view: per project/week, agent-independent divergence report. */
export function renderGapView(marker: Marker, now = new Date()): string {
	const { week, notebook, records, lastCaptureTs } = weekFacts(marker, now);
	const uncommitted = gitUncommitted(marker.lablog, week);

	const nbState = notebook.exists ? "in progress" : "none";
	const draft = uncommitted.length > 0 ? " · draft UNCOMMITTED (git)" : " · committed";
	const lines = [
		`${marker.project} · ${week} · notebook: ${nbState}${draft}`,
		`Capture: ${records.length} entries${lastCaptureTs ? ` (last ${lastCaptureTs})` : " (none)"}`,
	];

	const gaps: string[] = [];

	if (!notebook.exists && records.length > 0) {
		gaps.push(`notebook: none but ${records.length} capture entries exist — draft per lablog skill`);
	}

	if (lastCaptureTs && notebook.mtimeMs !== undefined) {
		const cap = parseLocalTs(lastCaptureTs);
		if (cap !== undefined && cap > notebook.mtimeMs) {
			const h = (cap - notebook.mtimeMs) / 3.6e6;
			gaps.push(`last capture ${h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`} newer than last notebook update`);
		}
	}

	const shutdowns = records.filter((r) => r.kind === "shutdown").length;
	if (shutdowns > 0) {
		gaps.push(`${shutdowns} session(s) closed without notebook update (see capture kind=shutdown)`);
	}

	// Heuristic: decision-ish capture entries whose wording never appears in
	// the notebook's Decisions section (token overlap). A lens, not a proof.
	const decisionish = records.filter((r) =>
		/\b(scientist|approved|decided|decision|adopted|directive|directed|confirmed)\b/i.test(r.text),
	);
	if (decisionish.length > 0 && notebook.exists) {
		const decisionTokens = new Set(tokens(notebook.decisions.map((b) => b.text).join(" ")));
		const unmatched = decisionish.filter((r) => {
			const t = tokens(r.text);
			return t.length > 0 && overlap(t, decisionTokens) < Math.min(2, t.length);
		}).length;
		if (unmatched > 0) {
			gaps.push(`${unmatched} capture entr${unmatched === 1 ? "y" : "ies"} mention decisions not found in notebook Decisions (heuristic)`);
		}
	}

	lines.push(gaps.length > 0 ? "Gaps:" : "Gaps: none detected");
	for (const g of gaps) lines.push(`  ⚠ ${g}`);
	return lines.join("\n");
}

/** Weekly ritual sheet (read-only in M1): open lines oldest-first + weekly evidence counts. */
export function renderTriageSheet(marker: Marker, now = new Date()): string {
	const { week, notebook, records } = weekFacts(marker, now);
	const lines: string[] = [`── ${week} triage sheet: ${marker.project} ──`];

	const open = notebook.inquiries
		.filter((q) => q.state === "open")
		.sort((a, b) => (a.date ?? "99-99").localeCompare(b.date ?? "99-99"));
	if (open.length === 0) {
		lines.push("Open lines: none");
	} else {
		lines.push("Open lines (oldest first):");
		open.forEach((q, i) => {
			const ev = records.filter((r) => {
				const rt = tokens(r.text);
				const qt = tokens(q.text);
				return qt.length > 0 && overlap(rt, new Set(qt)) >= Math.min(2, qt.length);
			}).length;
			lines.push(`  ${i + 1}. ${q.text}`);
			lines.push(`     opened ${q.date ?? "—"}${q.id ? ` · ${q.id}` : ""} · ${ev} evidence entr${ev === 1 ? "y" : "ies"}`);
		});
	}

	const cancelled = notebook.inquiries.filter((q) => q.state === "cancelled");
	lines.push(`Evidence this week: ${records.length} capture entries · ${notebook.decisions.length} decisions · ${notebook.days.length} day sections`);
	lines.push(
		cancelled.length > 0
			? `Cancelled: ${cancelled.length}${cancelled.every((q) => q.reason) ? "" : " (⚠ missing §reason)"}`
			: "Cancelled this week: 0 (none pending reason)",
	);
	return lines.join("\n");
}
