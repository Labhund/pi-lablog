import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCapture } from "./capture.js";
import { DEFAULT_LABLOG, findMarker, type Marker } from "./config.js";
import { registerCommands } from "./commands.js";
import { loadState, saveState, type SessionState } from "./state.js";

interface SessionCtx {
	marker: Marker | undefined;
	state: SessionState | undefined;
	inFlight: boolean;
	lastError: string | undefined;
}

/**
 * pi-lablog: background scientific capture for lab projects.
 *
 * Live only inside a directory tree containing a .lablog.toml marker (or when
 * declared manually via /lablog:on). Re-projects new session activity —
 * primarily the pi-observational-memory observations already recorded in the
 * session — into the lab-level weekly capture stream under <lablog>/capture/.
 */
export default function lablog(pi: ExtensionAPI): void {
	const sessions = new Map<string, SessionCtx>();

	const key = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId?.() ?? "default";

	const get = (ctx: ExtensionContext): SessionCtx => {
		const id = key(ctx);
		let sc = sessions.get(id);
		if (!sc) {
			sc = { marker: undefined, state: undefined, inFlight: false, lastError: undefined };
			sessions.set(id, sc);
		}
		return sc;
	};

	const resolve = (ctx: ExtensionContext): SessionCtx => {
		const sc = get(ctx);
		if (!sc.marker) {
			sc.marker = findMarker(ctx.cwd);
			if (sc.marker) {
				const id = key(ctx);
				sc.state =
					loadState(sc.marker.lablog, id) ??
					({
						sessionId: id,
						project: sc.marker.project,
						lablog: sc.marker.lablog,
						lastEntryId: null,
						records: 0,
						declared: false,
						disabled: false,
					} satisfies SessionState);
			}
		}
		return sc;
	};

	const maybeCapture = (_event: unknown, ctx: ExtensionContext): void => {
		try {
			const sc = resolve(ctx);
			if (!sc.marker || !sc.state || sc.state.disabled || sc.marker.passive) return;
			if (sc.inFlight) return;
			sc.inFlight = true;
			const marker = sc.marker;
			const state = sc.state;
			void (async () => {
				try {
					await runCapture(pi, ctx, marker, state, {
						notify: marker.notify && ctx.hasUI ? (m, t) => ctx.ui?.notify(m, t) : undefined,
						setLastError: (m) => {
							sc.lastError = m;
							state.lastError = m;
							saveState(state);
						},
					});
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					sc.lastError = msg;
					state.lastError = msg;
					saveState(state);
					if (marker.notify && ctx.hasUI && ctx.ui) {
						ctx.ui.notify(`lablog: capture failed: ${msg}`, "warning");
					}
				} finally {
					sc.inFlight = false;
				}
			})();
		} catch {
			/* never break the session over lablog */
		}
	};

	pi.on("session_start", (_event, ctx) => {
		// Fresh in-memory state per session; disk state (watermark) is reloaded lazily.
		sessions.delete(key(ctx));
	});

	pi.on("agent_start", maybeCapture);
	pi.on("turn_end", maybeCapture);

	registerCommands(pi, {
		get: (ctx) => {
			const sc = resolve(ctx);
			return { marker: sc.marker, state: sc.state };
		},
		declare: (ctx, project, lablogPath) => {
			const sc = get(ctx);
			const id = key(ctx);
			sc.marker = {
				project,
				lablog: lablogPath,
				passive: false,
				notify: false,
				via: "declared",
			};
			sc.state =
				loadState(lablogPath, id) ??
				({
					sessionId: id,
					project,
					lablog: lablogPath,
					lastEntryId: null,
					records: 0,
					declared: true,
					disabled: false,
				} satisfies SessionState);
		},
		disable: (ctx) => {
			const sc = resolve(ctx);
			if (sc.state) {
				sc.state.disabled = true;
				saveState(sc.state);
			} else {
				sc.marker = undefined; // nothing to disable; just stay off
			}
		},
		notify: (ctx, message, type) => {
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, type);
		},
	});
}
