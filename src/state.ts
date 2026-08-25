import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Per-session capture state, persisted under <lablog>/.state/ (gitignored). */
export interface SessionState {
	sessionId: string;
	project: string;
	lablog: string;
	/** Id of the newest branch entry fully processed (single watermark). */
	lastEntryId: string | null;
	records: number;
	declared: boolean;
	disabled: boolean;
	lastRun?: string;
	lastError?: string;
}

function stateFile(lablog: string, sessionId: string): string {
	return join(lablog, ".state", `${sessionId}.json`);
}

export function loadState(lablog: string, sessionId: string): SessionState | undefined {
	try {
		const p = stateFile(lablog, sessionId);
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as SessionState;
	} catch {
		/* corrupted state: start fresh */
	}
	return undefined;
}

export function saveState(state: SessionState): void {
	try {
		mkdirSync(join(state.lablog, ".state"), { recursive: true });
		writeFileSync(stateFile(state.lablog, state.sessionId), JSON.stringify(state, null, 2));
	} catch {
		/* state is a cache; capture stream is the source of truth */
	}
}
