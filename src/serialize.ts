/**
 * Compact source-addressed serialization of session branch entries.
 * Format mirrors pi-observational-memory so provenance labels stay consistent
 * across the two systems: "[Source entry id: <id>]" + role-tagged lines.
 */

export interface EntryLike {
	type: string;
	id?: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
}

function fmtTime(v: unknown): string {
	if (v === undefined) return "????-??-?? ??:??";
	const d = new Date(v as string | number);
	if (Number.isNaN(d.getTime())) return "????-??-?? ??:??";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

const TOOL_RESULT_CHAR_CAP = 4000;
const CUSTOM_MESSAGE_CHAR_CAP = 2000;

function renderEntry(e: EntryLike): string {
	if (e.type === "message" && e.message) {
		const m = e.message as Record<string, any>;
		const t = fmtTime(m.timestamp);
		if (m.role === "user") {
			const text = textOf(m.content);
			return text ? `[User @ ${t}]: ${text}` : "";
		}
		if (m.role === "assistant") {
			const parts: string[] = [];
			for (const b of (m.content ?? []) as Array<Record<string, any>>) {
				if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
				if (b?.type === "toolCall" && typeof b.name === "string") {
					const args = JSON.stringify(b.arguments ?? {}).slice(0, 400);
					parts.push(`[tool call ${b.name}(${args})]`);
				}
			}
			const body = parts.join("\n").trim();
			return body ? `[Assistant @ ${t}]: ${body}` : "";
		}
		if (m.role === "toolResult") {
			const text = textOf(m.content).slice(0, TOOL_RESULT_CHAR_CAP);
			return text ? `[Tool result for ${m.toolName ?? "?"} @ ${t}]: ${text}` : "";
		}
		return "";
	}
	if (e.type === "custom_message") {
		const t = fmtTime(e.timestamp);
		const text = (typeof e.content === "string" ? e.content : textOf(e.content)).slice(0, CUSTOM_MESSAGE_CHAR_CAP);
		return text ? `[Custom message @ ${t}]: ${text}` : "";
	}
	if (e.type === "branch_summary" && typeof e.summary === "string") {
		return `[Branch summary @ ${fmtTime(e.timestamp)}]: ${e.summary}`;
	}
	return "";
}

export function isSourceEntry(e: EntryLike): boolean {
	return e.type === "message" || e.type === "custom_message" || e.type === "branch_summary";
}

/**
 * Serialize entries (chronological order) into source-addressed text within a
 * token budget. Stops adding once the budget is exceeded.
 */
export function serializeSourceAddressed(
	entries: EntryLike[],
	maxTokens = 12000,
): { text: string; sourceEntryIds: string[] } {
	const blocks: string[] = [];
	const sourceEntryIds: string[] = [];
	let total = 0;
	for (const e of entries) {
		if (!e.id || !isSourceEntry(e)) continue;
		const rendered = renderEntry(e);
		if (!rendered.trim()) continue;
		const block = `[Source entry id: ${e.id}]\n${rendered}`;
		const cost = Math.ceil(block.length / 4) + 1;
		if (total + cost > maxTokens && blocks.length > 0) break;
		blocks.push(block);
		sourceEntryIds.push(e.id);
		total += cost;
	}
	return { text: blocks.join("\n\n"), sourceEntryIds };
}
