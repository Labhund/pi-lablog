import { createHash } from "node:crypto";

/** ISO week label, e.g. "2026-W35". */
export function isoWeek(d = new Date()): string {
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayNum = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** 12-char hex hash (sha1 prefix), same shape as observational-memory ids. */
export function hash12(...parts: string[]): string {
	return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

/** Rough token estimate (~4 chars/token), matching observational-memory's heuristic. */
export function estTokens(s: string): number {
	return Math.max(1, Math.ceil(s.length / 4));
}

/** Local "YYYY-MM-DD HH:MM". */
export function nowLocal(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
