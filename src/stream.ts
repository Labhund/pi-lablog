import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["assertion", "action", "result", "artifact", "note"] as const;
export type ModelKind = (typeof KINDS)[number];

/** kind "shutdown" is written only by the session-shutdown hook, never by the capture model. */
export const ALL_KINDS = [...KINDS, "shutdown"] as const;
export type Kind = (typeof ALL_KINDS)[number];

export const MODES = ["exploratory", "canonical"] as const;
export type Mode = (typeof MODES)[number];

/** One line in the provisional capture stream (<lablog>/capture/<week>.jsonl). */
export interface CaptureRecord {
	v: 1;
	/** Dedup id: hash(session, kind, mode, text, om-ids). */
	id: string;
	ts: string;
	week: string;
	project: string;
	session: string;
	sessionName?: string;
	kind: Kind;
	mode: Mode;
	text: string;
	/** Supporting observational-memory observation ids. */
	om: string[];
	/** Supporting raw session entry ids (when no om id covers the fact). */
	source: string[];
	files: string[];
}

export function weekStreamPath(lablog: string, week: string): string {
	return join(lablog, "capture", `${week}.jsonl`);
}

export function appendRecords(lablog: string, week: string, records: CaptureRecord[]): number {
	if (records.length === 0) return 0;
	const p = weekStreamPath(lablog, week);
	mkdirSync(join(lablog, "capture"), { recursive: true });
	let n = 0;
	for (const r of records) {
		appendFileSync(p, `${JSON.stringify(r)}\n`);
		n++;
	}
	return n;
}

export function readWeek(lablog: string, week: string): CaptureRecord[] {
	const p = weekStreamPath(lablog, week);
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l) as CaptureRecord;
			} catch {
				return undefined;
			}
		})
		.filter((r): r is CaptureRecord => !!r && typeof r.id === "string");
}
