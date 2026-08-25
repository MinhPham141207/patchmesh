// PatchMesh adapter for OpenCode (F-01 capability A, Wave B probe).
//
// Translates OpenCode's plugin-tool events into the recorder's hook envelope
// vocabulary and execs the same `patchmesh-record` binary that Claude Code's
// hooks run, so every host journals through one redaction path into one ledger.
//
// Fail-open everywhere: PatchMesh is report-only, so nothing here may ever
// break the tool call it observes. All errors are swallowed silently.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RECORDER_BIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"packages",
	"recorder",
	"dist",
	"bin.js",
);

/**
 * OpenCode names tools lowercase; the recorder normalizes Claude Code's
 * vocabulary. Unlisted tools pass through unmapped and are recorded as
 * `other`/opaque, exactly as unrecognized Claude tools are today.
 */
const TOOL_NAMES = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	task: "Agent",
};

/** OpenCode camelCases argument names the recorder whitelists in snake_case. */
function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string") return value;
	}
	return undefined;
}

function translateArgs(args) {
	if (typeof args !== "object" || args === null) return {};
	const translated = {};
	const filePath = firstString(args.file_path, args.filePath);
	const notebookPath = firstString(args.notebook_path, args.notebookPath);
	const command = firstString(args.command, args.cmd);
	const description = firstString(args.description);
	const subagentType = firstString(args.subagent_type, args.subagentType, args.agent);
	if (filePath !== undefined) translated.file_path = filePath;
	if (notebookPath !== undefined) translated.notebook_path = notebookPath;
	if (command !== undefined) translated.command = command;
	if (description !== undefined) translated.description = description;
	if (subagentType !== undefined) translated.subagent_type = subagentType;
	return translated;
}

function record(payload) {
	try {
		const child = spawn("node", [RECORDER_BIN], {
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
		child.on("error", () => {});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
		child.unref();
	} catch {
		// Recording must never throw into the host.
	}
}

export const PatchmeshPlugin = async ({ worktree, directory }) => {
	const cwd = worktree ?? directory ?? process.cwd();
	/** callID -> translated args, shared from `before` into `after`, because
	 * the completed-call envelope carries the input the request declared. */
	const inflight = new Map();
	/** Prompt ids already journalled; message.updated fires once per part update. */
	const seenPrompts = new Set();

	return {
		"tool.execute.before": async (input, output) => {
			try {
				const args = translateArgs(output?.args);
				if (typeof input?.callID === "string") {
					inflight.set(input.callID, args);
					if (inflight.size > 256) {
						inflight.delete(inflight.keys().next().value);
					}
				}
				record({
					session_id: input?.sessionID,
					cwd,
					hook_event_name: "PreToolUse",
					tool_name: TOOL_NAMES[input?.tool] ?? input?.tool,
					tool_use_id: input?.callID,
					tool_input: args,
				});
			} catch {}
		},

		"tool.execute.after": async (input, output) => {
			try {
				const meta = typeof output?.metadata === "object" && output.metadata !== null ? output.metadata : {};
				const error = typeof meta.error === "string" ? meta.error : undefined;
				const response = { exit_code: typeof meta.exit === "number" ? meta.exit : null };
				if (error !== undefined) {
					response.is_error = true;
					response.error = error;
				}
				let args = {};
				if (typeof input?.callID === "string") {
					args = inflight.get(input.callID) ?? args;
					inflight.delete(input.callID);
				}
				record({
					session_id: input?.sessionID,
					cwd,
					hook_event_name: "PostToolUse",
					tool_name: TOOL_NAMES[input?.tool] ?? input?.tool,
					tool_use_id: input?.callID,
					tool_input: args,
					tool_response: response,
				});
			} catch {}
		},

		event: async ({ event }) => {
			try {
				if (event?.type !== "message.updated") return;
				const info = event.properties?.info ?? event.info;
				if (info?.role !== "user" || typeof info.id !== "string") return;
				if (seenPrompts.has(info.id)) return;
				seenPrompts.add(info.id);
				if (seenPrompts.size > 500) seenPrompts.delete(seenPrompts.keys().next().value);
				record({
					session_id: typeof info.sessionID === "string" ? info.sessionID : info.id,
					cwd,
					hook_event_name: "UserPromptSubmit",
					prompt_id: info.id,
				});
			} catch {}
		},
	};
};
