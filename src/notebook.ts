import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic notebook parser (structural layer of the orientation digest).
 *
 * Extracts sections, verbatim zones (Decisions, Open questions, Operational
 * Notes, Lines of inquiry), and Day-section titles from a week notebook
 * (`<lablog>/weeks/<week>/<project>.md`). Never model-touched; must never fail
 * on well-formed notebooks and must degrade silently on anything else.
 */

export interface Bullet {
	/** Verbatim bullet text (leading "- " stripped). */
	text: string;
	/** 1-indexed source line. */
	line: number;
}

export interface NotebookSection {
	heading: string;
	level: number;
	line: number;
	bullets: Bullet[];
}

export interface InquiryLine {
	state: "open" | "carried" | "cancelled";
	date?: string; // MM-DD
	id?: string; // 8-12 hex content id
	text: string;
	reason?: string; // §reason: text (mandatory intent for cancelled lines)
	raw: string;
}

export interface DaySection {
	heading: string;
	title: string; // text after the colon
	date?: string; // MM-DD if parseable from "(Mon Aug 31)"
	line: number;
}

export interface ParsedNotebook {
	path: string;
	exists: boolean;
	mtimeMs?: number;
	title?: string;
	status?: string;
	sections: NotebookSection[];
	decisions: Bullet[];
	openQuestions: Bullet[];
	opNotes: Bullet[];
	inquiries: InquiryLine[];
	days: DaySection[];
}

const MONTHS: Record<string, string> = {
	jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
	jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function notebookPath(lablog: string, week: string, project: string): string {
	return join(lablog, "weeks", week, `${project}.md`);
}

function headingLevel(line: string): number | undefined {
	const m = /^(#{1,6})\s+/.exec(line);
	return m ? m[1].length : undefined;
}

export function parseInquiry(raw: string): InquiryLine | undefined {
	const m = /^\[([a-z]+)\]\s*(?:\((\d{2}-\d{2})(?:[,\s]+([0-9a-f]{8,12}))?\)\s*)?(.*)$/.exec(raw.trim());
	if (!m) return undefined;
	const state = m[1];
	if (state !== "open" && state !== "carried" && state !== "cancelled") return undefined;
	const rest = m[4] ?? "";
	const rm = /(?:^|\s)§reason:\s*(.*)$/.exec(rest);
	return {
		state,
		date: m[2],
		id: m[3],
		text: (rm ? rest.slice(0, rm.index) : rest).trim(),
		reason: rm?.[1]?.trim() || undefined,
		raw,
	};
}

export function parseNotebook(lablog: string, week: string, project: string): ParsedNotebook {
	const path = notebookPath(lablog, week, project);
	const out: ParsedNotebook = {
		path,
		exists: false,
		sections: [],
		decisions: [],
		openQuestions: [],
		opNotes: [],
		inquiries: [],
		days: [],
	};
	if (!existsSync(path)) return out;
	out.exists = true;
	try {
		out.mtimeMs = statSync(path).mtimeMs;
	} catch {
		/* unreadable mtime: gaps fall back to "unknown" */
	}

	let lines: string[];
	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		return out;
	}

	const heads: Array<{ level: number; heading: string; line: number }> = [];
	lines.forEach((l, i) => {
		const level = headingLevel(l);
		if (level) heads.push({ level, heading: l.replace(/^#{1,6}\s+/, "").trim(), line: i + 1 });
	});

	// A heading owns bullet lines until the next heading at level <= its own.
	const bulletsOf = (h: number): Bullet[] => {
		const start = heads[h].line; // 1-indexed
		const end = h + 1 < heads.length ? heads[h + 1].line - 1 : lines.length;
		const bullets: Bullet[] = [];
		for (let i = start; i < end; i++) {
			const t = lines[i].trim();
			if (/^[-*]\s+/.test(t)) bullets.push({ text: t.replace(/^[-*]\s+/, ""), line: i + 1 });
		}
		return bullets;
	};

	out.title = heads.find((h) => h.level === 1)?.heading;
	const statusLine = lines.map((l) => l.trim()).find((l) => /^\*\*Status:\*\*/.test(l));
	if (statusLine) out.status = statusLine.replace(/^\*\*Status:\*\*\s*/, "").trim();

	out.sections = heads.map((h, hIdx) => ({ ...h, bullets: bulletsOf(hIdx) }));
	const find = (re: RegExp): NotebookSection | undefined => out.sections.find((s) => re.test(s.heading));
	out.decisions = find(/^decisions\b/i)?.bullets ?? [];
	out.openQuestions = find(/open question|open-q|next steps/i)?.bullets ?? [];
	out.opNotes = find(/operational notes/i)?.bullets ?? [];
	const inq = find(/lines of inquiry/i);
	if (inq) out.inquiries = inq.bullets.map((b) => parseInquiry(b.text)).filter((q): q is InquiryLine => !!q);

	for (const s of out.sections) {
		if (s.level !== 2 || !/^Day\s+\d+/.test(s.heading)) continue;
		const colon = s.heading.indexOf(":");
		const title = colon >= 0 ? s.heading.slice(colon + 1).trim() : s.heading;
		const dm = /\((?:\w{3},?\s+)?([A-Za-z]{3})\.?\s+(\d{1,2})\)/.exec(s.heading);
		let date: string | undefined;
		if (dm) {
			const mon = MONTHS[dm[1].toLowerCase()];
			if (mon) date = `${mon}-${dm[2].padStart(2, "0")}`;
		}
		out.days.push({ heading: s.heading, title, date, line: s.line });
	}
	return out;
}

/** Project TOC arc: one line per week (`- [2026-W36](…) — summary`). */
export function readToc(lablog: string, project: string): string[] {
	const p = join(lablog, "projects", project, "TOC.md");
	if (!existsSync(p)) return [];
	try {
		return readFileSync(p, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => /^-\s*\[/.test(l));
	} catch {
		return [];
	}
}
