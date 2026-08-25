import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Lab log project marker. A directory (or any directory under it) containing
 * .lablog.toml is a lab project; capture is live for sessions started there.
 *
 *   project = "tRNA-broadcast-paper"
 *   lablog = "/data2/loo_lab/_lablog"
 *   # model_provider = "openrouter"   # optional override for the capture agent
 *   # model_id = "moonshotai/kimi-k3"
 *   # passive = true                  # disable background capture
 *   # notify = true                   # show a short notice per capture run
 */
export interface Marker {
	project: string;
	lablog: string;
	modelProvider?: string;
	modelId?: string;
	passive: boolean;
	notify: boolean;
}

export const DEFAULT_LABLOG = "/data2/loo_lab/_lablog";
export const MARKER_FILE = ".lablog.toml";

export function findMarker(cwd: string): Marker | undefined {
	let dir = cwd;
	for (let i = 0; i < 12; i++) {
		const file = join(dir, MARKER_FILE);
		if (existsSync(file)) {
			try {
				const m = parseMarker(readFileSync(file, "utf8"));
				if (m) return m;
			} catch {
				/* malformed marker: ignore */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/** Minimal flat-TOML reader: `key = "value"` lines, `#` comments. */
export function parseMarker(text: string): Marker | undefined {
	const get = (key: string): string | undefined => {
		const line = text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.startsWith(`${key} =`));
		if (!line) return undefined;
		const val = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
		return val.length ? val : undefined;
	};
	const project = get("project");
	const lablog = get("lablog");
	if (!project || !lablog) return undefined;
	return {
		project,
		lablog,
		modelProvider: get("model_provider"),
		modelId: get("model_id"),
		passive: get("passive") === "true",
		notify: get("notify") === "true",
	};
}
