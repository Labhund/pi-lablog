import type { EntryLike } from "./serialize.js";

export interface OmObservation {
	id: string;
	content: string;
	timestamp: string;
	relevance: string;
}

const OM_OBSERVATIONS_TYPE = "om.observations.recorded";

/**
 * Collect pi-observational-memory observations from branch entries
 * (chronological order). Returns them in the order they were recorded.
 */
export function collectOmObservations(entries: EntryLike[]): OmObservation[] {
	const out: OmObservation[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== OM_OBSERVATIONS_TYPE) continue;
		const data = (e as { data?: { observations?: unknown } }).data;
		if (!data || !Array.isArray(data.observations)) continue;
		for (const o of data.observations as Array<Record<string, unknown>>) {
			if (o && typeof o.id === "string" && typeof o.content === "string") {
				out.push({
					id: o.id,
					content: o.content,
					timestamp: typeof o.timestamp === "string" ? o.timestamp : "",
					relevance: typeof o.relevance === "string" ? o.relevance : "",
				});
			}
		}
	}
	return out;
}
