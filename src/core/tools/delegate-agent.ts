/**
 * `delegate_agent` built-in CLI command — cross-workspace orchestration for the
 * persistent (main) agent.
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree), but ONLY wired up when the runtime is the main agent (see
 * `session-facade-factory.ts`, which passes `delegate_agent` into the cli tool's
 * options). For non-main-agent workspaces the command is recognized but reports
 * that it is unavailable.
 *
 * Lets the main agent hand a task to a sub-agent running in another project
 * directory via the existing RPC infrastructure (`RpcClient`), so the main
 * agent's context is not polluted by the sub-agent's intermediate output.
 *
 * The command also exposes the set of known workspace agents (project
 * directories the agent has previously worked in) via the `list` action, so the
 * model can discover delegation targets without guessing paths.
 *
 * Synchronous delegation — the main agent blocks until the sub-agent finishes,
 * then receives only the sub-agent's final assistant text.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { RpcClient } from "../../../packages/rpc/rpc-client.js";
import { listKnownWorkspaces, type KnownWorkspace } from "../event-store/workspace.js";
import { defineTool, type ToolDefinition } from "../extensions/types.js";

/** Supported `delegate_agent` subcommands. */
export const DELEGATE_AGENT_ACTIONS = ["list", "run", "run_all", "verify", "verify_all"] as const;
export type DelegateAgentAction = (typeof DELEGATE_AGENT_ACTIONS)[number];

/** Default parallelism cap for `run_all` / `verify_all`. Each target runs in its own sub-process. */
export const DELEGATE_AGENT_DEFAULT_CONCURRENCY = 8;
/** Hard ceiling for `run_all` / `verify_all` parallelism. */
export const DELEGATE_AGENT_MAX_CONCURRENCY = 16;

/**
 * CLI-style schema for the `delegate_agent` command. Mirrors the positional/flag
 * form parsed in `parseDelegateAgentInput` (builtin-commands.ts):
 *
 *   delegate_agent list
 *   delegate_agent run <cwd> <task>
 *   delegate_agent run --cwd <path> --task "..." [--timeout 120000]
 *   delegate_agent run_all <cwd-1> <cwd-2> ... <cwd-n> --task "..."
 *   delegate_agent verify <cwd> <criteria> [--artifact "worker output"]
 *   delegate_agent verify_all <cwd-1> <cwd-2> ... --criteria "..."
 */
const delegateAgentSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("run"),
			Type.Literal("run_all"),
			Type.Literal("verify"),
			Type.Literal("verify_all"),
		],
		{
			description:
				"list: show known workspace agents (project directories previously visited). " +
				"run: delegate a task to a sub-agent in a single target project directory (requires cwd and task). " +
				"run_all: fan the same task out to multiple project directories in parallel, one sub-agent per target. " +
				"verify: spawn a fresh verifier sub-agent that independently checks a target against criteria (requires cwd and criteria). " +
				"verify_all: fan verification out to multiple project directories in parallel.",
		},
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Target project directory for the sub-agent (required for run and verify). Relative paths are resolved. Omit for list.",
		}),
	),
	cwds: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Target project directories for run_all / verify_all — each receives the same task/criteria, one sub-agent per directory.",
			}),
			{
				description:
					"Target project directories for run_all / verify_all (use positionals or repeated --cwd). Requires at least one entry.",
			},
		),
	),
	task: Type.Optional(
		Type.String({
			description:
				"Task description to hand to the sub-agent (required for run and run_all). Use the heredoc form or --task for long tasks.",
		}),
	),
	criteria: Type.Optional(
		Type.String({
			description:
				"Acceptance criteria for verify / verify_all. The verifier (a fresh sub-agent) checks the project against these and returns a VERDICT. Use --criteria or the heredoc form.",
		}),
	),
	artifact: Type.Optional(
		Type.String({
			description:
				"Optional context handed to verify / verify_all — e.g. a worker agent's output summary to check. Passed verbatim into the verifier's prompt.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in milliseconds for each delegated task (default 120000).",
		}),
	),
	concurrency: Type.Optional(
		Type.Number({
			description:
				"Max parallel sub-agents for run_all / verify_all (default 8, clamped to 1-16). Each sub-agent is its own process.",
		}),
	),
});

export type DelegateAgentToolInput = Static<typeof delegateAgentSchema>;

/** Options for {@link createDelegateAgentToolDefinition}. */
export interface DelegateAgentToolOptions {
	/** Agent config directory — used to discover known workspaces and to align the sub-agent's auth. */
	agentDir: string;
	/**
	 * The main agent's own working directory. Excluded from `list` results — the
	 * main agent delegates to *other* projects, never itself.
	 */
	mainDir?: string;
}

/**
 * Resolve the CLI entry point for spawning a sub-agent.
 *
 * In node mode `process.argv[1]` is the absolute path to the running `cli.js`.
 * In binary mode (bun `--compile`) `process.execPath` is the compiled binary
 * itself and `process.argv[1]` does not end in `.js` — the binary must be
 * spawned directly without a `node` prefix (handled via `RpcClient`'s
 * `binary` option).
 */
function resolveCliSpawn(): { cliPath: string; binary: boolean } {
	const argv1 = process.argv[1] ?? "";
	const isBinary = !argv1.endsWith(".js");
	return {
		cliPath: isBinary ? process.execPath : argv1,
		binary: isBinary,
	};
}

/** Format the known-workspace list as a readable text block for the model. */
function formatWorkspaceList(workspaces: KnownWorkspace[]): string {
	if (workspaces.length === 0) {
		return (
			"No known workspace agents found. Provide an explicit `cwd` to delegate to a new " +
			"project directory — it will be registered as a workspace after the first delegation."
		);
	}
	const lines = workspaces.map((ws, index) => {
		const last = ws.last_accessed_at > 0 ? new Date(ws.last_accessed_at).toISOString() : "unknown";
		const db = ws.has_event_db ? "yes" : "no";
		return `${index + 1}. cwd: ${ws.cwd}\n   workspace_id: ${ws.workspace_id}\n   last_accessed: ${last}\n   has_event_db: ${db}`;
	});
	return `Known workspace agents (${workspaces.length}):\n\n${lines.join("\n\n")}`;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Result of a single delegation attempt (per target directory). */
export interface DelegateOneResult {
	/** Target directory (already resolved to an absolute path). */
	cwd: string;
	ok: boolean;
	/** Final assistant text on success, or the error message on failure. */
	text: string;
}

/**
 * Spawn a sub-agent in one project directory and return its final assistant text.
 *
 * Each call creates its own `RpcClient` (own sub-process, own workspace event
 * store), so parallel calls are process-level isolated — shared cwd writes stay
 * in each sub-agent's workspace and never enter the caller's context.
 */
export async function delegateOne(options: {
	cwd: string;
	task: string;
	timeout: number;
	agentDir: string;
	signal?: AbortSignal;
}): Promise<DelegateOneResult> {
	const { cwd, task, timeout, agentDir, signal } = options;
	const targetCwd = resolve(cwd);

	const { cliPath, binary } = resolveCliSpawn();
	// Align the sub-agent's agentDir with the main agent's so they share
	// auth/models/workspaces. YUE_AGENT_DIR is the env override read by
	// getAgentDir().
	const env: Record<string, string> = { YUE_AGENT_DIR: agentDir };

	const client = new RpcClient({ cwd: targetCwd, cliPath, binary, env });

	try {
		await client.start();

		// Reject early if the spawn was aborted before the prompt lands.
		if (signal?.aborted) {
			throw new Error("delegate_agent aborted before prompt was sent");
		}

		// promptAndWait = prompt + collectEvents(until AGENT_TURN_COMPLETED).
		await client.promptAndWait(task, undefined, timeout);

		if (signal?.aborted) {
			// Best-effort abort of the sub-agent.
			await client.abort().catch(() => {});
		}

		const text = await client.getLastAssistantText();
		return { cwd: targetCwd, ok: true, text: text ?? "(sub-agent produced no response)" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stderr = client.getStderr();
		return {
			cwd: targetCwd,
			ok: false,
			text: `${message}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
		};
	} finally {
		await client.stop().catch(() => {});
	}
}

/**
 * Run `worker` over `items` with at most `concurrency` in-flight promises,
 * preserving input order in the returned array. Used by `run_all` so a fan-out
 * of many sub-agents does not spawn unbounded processes at once. Early-aborts
 * (stops claiming new items) once `signal` is aborted; in-flight workers finish.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}
	const limit = Math.max(1, Math.floor(concurrency));
	const results: R[] = new Array(items.length);
	let next = 0;

	async function runWorker(): Promise<void> {
		while (next < items.length && !signal?.aborted) {
			const index = next++;
			results[index] = await worker(items[index]);
		}
	}

	const workerCount = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
	return results;
}

/** Clamp a user-supplied concurrency value into the supported range. */
export function clampConcurrency(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return DELEGATE_AGENT_DEFAULT_CONCURRENCY;
	}
	return Math.max(1, Math.min(DELEGATE_AGENT_MAX_CONCURRENCY, Math.floor(value)));
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… [truncated, ${text.length - max} chars omitted]`;
}

/**
 * Build the prompt for a fresh verifier sub-agent.
 *
 * The verifier gets its own sub-process / workspace event store (via
 * `delegateOne`), so it does NOT see the worker's intermediate reasoning — the
 * only shared input is the criteria and, optionally, the worker's output. It is
 * told explicitly not to modify code and to return a structured verdict.
 */
export function buildVerificationPrompt(criteria: string, artifact?: string): string {
	const sections: string[] = [
		"You are a verification agent. Independently verify that the following criteria are met in this project. " +
			"Do NOT modify code. Inspect the project (read files, run read-only commands or tests) as needed, then " +
			"return a verdict.",
		"",
		"CRITERIA:",
		criteria,
	];
	if (artifact !== undefined && artifact.length > 0) {
		sections.push("", "WORKER OUTPUT TO CHECK:", artifact);
	}
	sections.push(
		"",
		'Respond with EXACTLY this format (one value per line):',
		"VERDICT: PASS | PARTIAL | FAIL",
		"EVIDENCE: concrete evidence from files or test runs",
		'ISSUES: each unmet criterion or problem, or "none"',
		"CONFIDENCE: high | medium | low",
	);
	return sections.join("\n");
}

/** Extract a VERDICT: PASS|PARTIAL|FAIL line from a verifier's reply, if present. */
function extractVerdict(text: string): string | null {
	const match = /^\s*VERDICT:\s*(PASS|PARTIAL|FAIL)\b/im.exec(text);
	return match ? match[1].toUpperCase() : null;
}

/** Format `verify_all` results with the verifier's verdict as the per-target status. */
function formatVerificationResults(results: readonly DelegateOneResult[]): string {
	const ok = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok);
	const body = results
		.map((r, i) => {
			const status = r.ok ? extractVerdict(r.text) ?? "ok" : "failed";
			return `## ${i + 1}. ${r.cwd} — ${status}\n${truncate(r.text, 2000)}`;
		})
		.join("\n\n");
	return (
		`Verification (${results.length} target${results.length === 1 ? "" : "s"}, ` +
		`${ok.length} ok, ${failed.length} failed):\n\n${body}\n\nSummary: ${ok.length} ok, ${failed.length} failed.`
	);
}

/** Format `run_all` results as a per-target report the model can verify. */
function formatFanoutResults(results: readonly DelegateOneResult[]): string {
	const ok = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok);
	const body = results
		.map(
			(r, i) =>
				`## ${i + 1}. ${r.cwd} — ${r.ok ? "ok" : "failed"}\n${truncate(r.text, 2000)}`,
		)
		.join("\n\n");
	return (
		`Fan-out delegation (${results.length} target${results.length === 1 ? "" : "s"}, ` +
		`${ok.length} ok, ${failed.length} failed):\n\n${body}\n\nSummary: ${ok.length} ok, ${failed.length} failed.`
	);
}

/**
 * Create the `delegate_agent` command's tool definition.
 *
 * Actions:
 *  - **list**: returns the list of known workspace agents.
 *  - **run**: spawns a sub-agent in `cwd` via `RpcClient`, waits for it to
 *    finish, and returns its final assistant text.
 *  - **run_all**: spawns one sub-agent per target directory in parallel (bounded
 *    by `concurrency`), each in its own workspace, and returns a per-target report.
 *  - **verify**: spawns a fresh verifier sub-agent in `cwd` that independently
 *    checks the project against criteria and returns a structured verdict.
 *  - **verify_all**: fans verification out to several directories in parallel.
 */
export function createDelegateAgentToolDefinition(
	options: DelegateAgentToolOptions,
): ToolDefinition<typeof delegateAgentSchema, undefined> {
	const { agentDir, mainDir } = options;

	return defineTool({
		name: "delegate_agent",
		label: "delegate_agent",
		description:
			"Delegate a task to a sub-agent running in another project directory. " +
			"The sub-agent runs in its own workspace (independent event store / compaction) and " +
			"only its final reply is returned — intermediate output does not enter this context. " +
			"Use the `list` action to discover which project directories are available as delegation targets, " +
			"then `run` with a target cwd and task, or `run_all` to fan the same task out to several " +
			"directories in parallel. Use `verify` / `verify_all` to spawn fresh verifier sub-agents that " +
			"check a project against acceptance criteria and return a PASS/FAIL verdict. " +
			"Only available to the main (persistent) agent.",
		promptSnippet: "_delegate_agent: run a sub-agent in another project directory and return only its final reply",
		promptGuidelines: [
			"Use _delegate_agent to hand cross-project tasks to a sub-agent instead of handling another project's code in this context.",
			"Before delegating to an unfamiliar project, call `_delegate_agent list` to see which project directories are known.",
			"_delegate_agent returns only the sub-agent's final reply — intermediate steps stay out of this context. If you need progress, ask the sub-agent to summarize in its final message.",
			"_delegate_agent is synchronous and blocks until the sub-agent finishes; prefer it for bounded tasks. Avoid delegating very long-running work.",
			"Use `_delegate_agent run_all <cwd-1> <cwd-2> ... --task \"...\"` to fan the same task out to multiple project directories in parallel (graph-style fan-out). Ask each sub-agent to return a terse, verifiable summary — then review the per-target report yourself.",
			"After a fan-out, use `_delegate_agent verify <cwd> <criteria>` or `verify_all` to check the result with a fresh sub-agent that has not seen the worker's reasoning. Ask for a structured verdict (PASS/PARTIAL/FAIL + evidence) and only accept work that verifies.",
		],
		parameters: delegateAgentSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				const workspaces = listKnownWorkspaces(agentDir, mainDir);
				return textResult(formatWorkspaceList(workspaces));
			}

			// action === "run_all" — fan the same task out to several directories.
			if (params.action === "run_all") {
				const cwds = (params.cwds ?? []).filter((c) => c.length > 0);
				if (cwds.length === 0) {
					return textResult(
						"_delegate_agent run_all requires at least one `cwd`. Provide multiple cwds " +
							"(positionals or repeated --cwd) plus a shared `task`.",
					);
				}
				if (!params.task) {
					return textResult(
						"_delegate_agent run_all requires a `task` handed to every target " +
							"(use --task or the heredoc form).",
					);
				}
				const task = params.task;
				const timeout = params.timeout ?? 120_000;
				const concurrency = clampConcurrency(params.concurrency);
				const results = await mapWithConcurrency(
					cwds,
					concurrency,
					(cwd) => delegateOne({ cwd, task, timeout, agentDir, signal }),
					signal,
				);
				return textResult(formatFanoutResults(results));
			}

			// action === "verify" | "verify_all" — fresh-context verifier.
			if (params.action === "verify" || params.action === "verify_all") {
				if (!params.criteria) {
					return textResult(
						`_delegate_agent ${params.action} requires \`criteria\` to check ` +
							"(use --criteria or the heredoc form).",
					);
				}
				const criteria = params.criteria;
				const artifact = params.artifact;
				const verifyTimeout = params.timeout ?? 120_000;
				const prompt = buildVerificationPrompt(criteria, artifact);

				if (params.action === "verify") {
					if (!params.cwd) {
						return textResult("_delegate_agent verify requires a `cwd` target project directory.");
					}
					const verifyResult = await delegateOne({
						cwd: params.cwd,
						task: prompt,
						timeout: verifyTimeout,
						agentDir,
						signal,
					});
					return textResult(
						verifyResult.ok
							? verifyResult.text
							: `verification of ${verifyResult.cwd} failed: ${verifyResult.text}`,
					);
				}

				// verify_all
				const verifyCwds = (params.cwds ?? []).filter((c) => c.length > 0);
				if (verifyCwds.length === 0) {
					return textResult(
						"_delegate_agent verify_all requires at least one `cwd`. Provide multiple cwds " +
							"(positionals or repeated --cwd) plus `--criteria`.",
					);
				}
				const concurrency = clampConcurrency(params.concurrency);
				const results = await mapWithConcurrency(
					verifyCwds,
					concurrency,
					(cwd) => delegateOne({ cwd, task: prompt, timeout: verifyTimeout, agentDir, signal }),
					signal,
				);
				return textResult(formatVerificationResults(results));
			}

			// action === "run"
			if (!params.cwd || !params.task) {
				return textResult(
				"_delegate_agent run requires both `cwd` and `task`. " +
					"Use `_delegate_agent list` to see known project directories, or provide an explicit cwd.",
				);
			}

			const timeout = params.timeout ?? 120_000;
			const result = await delegateOne({
				cwd: params.cwd,
				task: params.task,
				timeout,
				agentDir,
				signal,
			});
			return textResult(
				result.ok ? result.text : `delegate_agent to ${result.cwd} failed: ${result.text}`,
			);
		},
		renderCall(args, _theme) {
			if (args?.action === "list") {
				return new Text("delegate_agent (list workspaces)", 0, 0);
			}
			if (args?.action === "run_all" || args?.action === "verify_all") {
				const n = args.cwds?.length ?? 0;
				const detail = args.task ?? args.criteria ?? "";
				const suffix = detail ? `: ${detail.slice(0, 60)}${detail.length > 60 ? "…" : ""}` : "";
				return new Text(`${args.action} → ${n} target${n === 1 ? "" : "s"}${suffix}`, 0, 0);
			}
			const cwd = args?.cwd ?? "?";
			const detail = args.task ?? args.criteria ?? "";
			const suffix = detail ? `: ${detail.slice(0, 60)}${detail.length > 60 ? "…" : ""}` : "";
			const verb = args?.action === "verify" ? "verify" : "delegate_agent";
			return new Text(`${verb} → ${cwd}${suffix}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}
