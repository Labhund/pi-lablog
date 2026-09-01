import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
	/** How the project was identified: explicit marker, implicit git rule, or /lablog:on. */
	via?: "marker" | "git" | "declared";
	/** [orientation] section of the marker; defaults apply when absent. */
	orientation?: OrientationConfig;
}

/**
 * Orientation config (`[orientation]` in .lablog.toml; all optional):
 *
 *   [orientation]
 *   inject = "marker"            # marker | none
 *   lookback_weeks = 1
 *   render_model = ""            # M2; empty = structural only
 *   nudge_at_checkpoints = false # M3; default off until proven useful
 */
export interface OrientationConfig {
	inject: "marker" | "none";
	lookbackWeeks: number;
	renderModel: string;
	nudgeAtCheckpoints: boolean;
}

export const DEFAULT_ORIENTATION: OrientationConfig = {
	inject: "marker",
	lookbackWeeks: 1,
	renderModel: "",
	nudgeAtCheckpoints: false,
};

export const DEFAULT_LABLOG = "/data2/loo_lab/_lablog";
/** Directories whose git repos are lab projects by default. */
export const LAB_ROOTS = ["/data2/loo_lab"];
export const MARKER_FILE = ".lablog.toml";

function isUnderLabRoot(path: string): boolean {
	return LAB_ROOTS.some((r) => path === r || path.startsWith(r + "/"));
}

function gitRoot(dir: string): string | undefined {
	let d = dir;
	for (let i = 0; i < 16; i++) {
		if (existsSync(join(d, ".git"))) return d;
		const parent = dirname(d);
		if (parent === d) break;
		d = parent;
	}
	return undefined;
}

/**
 * Resolve the lab project for a working directory:
 *  1. explicit .lablog.toml in or above cwd (wins),
 *  2. implicit rule: cwd is inside a git repo under a lab root
 *     (project = repo directory name),
 *  3. otherwise undefined (not lab work).
 */
export function findMarker(cwd: string): Marker | undefined {
	let dir = cwd;
	for (let i = 0; i < 12; i++) {
		const file = join(dir, MARKER_FILE);
		if (existsSync(file)) {
			try {
				const m = parseMarker(readFileSync(file, "utf8"));
				if (m) return { ...m, via: "marker" };
			} catch {
				/* malformed marker: ignore */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!isUnderLabRoot(cwd)) return undefined;
	const root = gitRoot(cwd);
	if (!root || !isUnderLabRoot(root) || root === DEFAULT_LABLOG) return undefined;
	return { project: basename(root), lablog: DEFAULT_LABLOG, passive: false, notify: false, via: "git" };
}

function parseOrientation(text: string): OrientationConfig {
	const cfg = { ...DEFAULT_ORIENTATION };
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.trim() === "[orientation]");
	if (start < 0) return cfg;
	for (let i = start + 1; i < lines.length; i++) {
		const t = lines[i].split("#")[0].trim();
		if (t.startsWith("[")) break;
		const eq = t.indexOf("=");
		if (eq < 0) continue;
		const key = t.slice(0, eq).trim();
		const raw = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (key === "inject" && (raw === "marker" || raw === "none")) cfg.inject = raw;
		else if (key === "lookback_weeks") {
			const n = Number(raw);
			if (Number.isFinite(n) && n >= 0) cfg.lookbackWeeks = n;
		} else if (key === "render_model") cfg.renderModel = raw;
		else if (key === "nudge_at_checkpoints") cfg.nudgeAtCheckpoints = raw === "true";
	}
	return cfg;
}

/** Minimal flat-TOML reader: `key = "value"` lines, `#` comments, one optional [orientation] section. */
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
		orientation: parseOrientation(text),
	};
}
