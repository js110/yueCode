/**
 * `workflow` built-in CLI command — graph-workflow orchestration for the
 * persistent (main) agent.
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree/delegate_agent), but ONLY wired up when the runtime is the main
 * agent (see `session-facade-factory.ts`, which passes `workflow` into the cli
 * tool's options). For non-main-agent workspaces the command is recognized but
 * reports that it is unavailable.
 *
 * Lets the main agent save, run, re-run, list, and delete named workflow DAGs
 * (delegate → verify → synthesize graphs) without re-planning: the definition is
 * the plan, and execution only schedules sub-agents via the existing RPC
 * infrastructure. Definitions persist under `<agentDir>/workflows/<name>.json`,
 * so a saved graph can be re-run by name later.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import {
	deleteWorkflowDefinition,
	executeWorkflow,
	formatWorkflowList,
	formatWorkflowRun,
	listWorkflowDefinitions,
	loadWorkflowDefinition,
	saveWorkflowDefinition,
	type WorkflowDefinition,
} from "../workflow/engine.js";

/** Supported `workflow` subcommands. */
export const WORKFLOW_ACTIONS = ["save", "run", "list", "show", "delete"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/**
 * CLI-style schema for the `workflow` command. Mirrors the positional/flag form
 * parsed in `parseWorkflowInput` (builtin-commands.ts):
 *
 *   workflow list
 *   workflow show <name>
 *   workflow delete <name>
 *   workflow save <name> --definition '<json>'
 *   workflow save <name> <<EOF
 *   { ... }
 *   EOF
 *   workflow run <name> [--timeout N]
 *   workflow run --definition '<json>' [--timeout N]
 */
const workflowSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("save"),
			Type.Literal("run"),
			Type.Literal("list"),
			Type.Literal("show"),
			Type.Literal("delete"),
		],
		{
			description:
				"save: persist a workflow definition under <agentDir>/workflows/. " +
				"run: execute a saved workflow by name, or an inline --definition. " +
				"list: show saved workflows. " +
				"show: print a saved workflow definition. " +
				"delete: remove a saved workflow.",
		},
	),
	name: Type.Optional(
		Type.String({
			description:
				"Workflow name (letters, digits, . _ -, max 80). Required for save/show/delete; optional for run when an inline definition is given.",
		}),
	),
	definition: Type.Optional(
		Type.String({
			description:
				"Workflow definition as JSON text (use --definition or the heredoc form). Required for save; alternatively an inline --definition runs a one-shot workflow without saving.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Default per-sub-agent timeout in ms for nodes without their own (default 120000).",
		}),
	),
});

export type WorkflowToolInput = Static<typeof workflowSchema>;

/** Options for {@link createWorkflowToolDefinition}. */
export interface WorkflowToolOptions {
	/** Agent config directory — used to persist/load workflow definitions. */
	agentDir: string;
	/** The main agent's own working directory. */
	mainDir?: string;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Parse a workflow definition from JSON text, applying a fallback name when missing. */
function parseWorkflowJson(json: string, fallbackName?: string): WorkflowDefinition {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`workflow: definition is not valid JSON (${message})`);
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as WorkflowDefinition).nodes)) {
		throw new Error('workflow: definition must be a JSON object with a "nodes" array');
	}
	const definition = parsed as WorkflowDefinition;
	if (!definition.name && fallbackName) {
		definition.name = fallbackName;
	}
	return definition;
}

/**
 * Create the `workflow` command's tool definition.
 *
 * Actions: save / run / list / show / delete. Execution (and persistence) only
 * works when `agentDir` is set — i.e. the main agent.
 */
export function createWorkflowToolDefinition(
	options: WorkflowToolOptions,
): ToolDefinition<typeof workflowSchema, undefined> {
	const { agentDir } = options;

	return defineTool({
		name: "workflow",
		label: "workflow",
		description:
			"Save, run, and re-run named graph workflows. A workflow is a JSON DAG of sub-agent nodes " +
			"(delegate / verify / synthesize) executed with zero-token coordination — each node fans out " +
			"to one sub-agent per project directory, and nodes with satisfied dependencies run in parallel. " +
			"Definitions persist under the agent's workflows directory, so a saved graph can be re-run by name. " +
			"Only available to the main (persistent) agent.",
		promptSnippet: "_workflow: save, run, and re-run named sub-agent workflow DAGs",
		promptGuidelines: [
			"Use _workflow to persist and re-run a multi-step delegation graph instead of re-planning it every time. Define nodes as JSON: {\"name\":\"<n>\",\"nodes\":[{\"id\":\"workers\",\"kind\":\"delegate\",\"cwds\":[\"../a\"],\"task\":\"...\"},{\"id\":\"check\",\"kind\":\"verify\",\"cwds\":[\"../a\"],\"criteria\":\"...\",\"dependsOn\":[\"workers\"]}]}.",
			"Save a graph with `_workflow save <name> --definition '<json>'` (or the heredoc form), then run it with `_workflow run <name>`. Re-run later by name — the definition is the plan, no re-planning tokens.",
			"`delegate` nodes fan a task out to every cwd; `verify` nodes spawn fresh verifiers that check criteria and return a VERDICT; `synthesize` nodes review all upstream outputs in one fresh context. Use `dependsOn` to order them (e.g. verify after delegate).",
			"Node spawn failures are recorded per-target and do not abort the graph, so a verify node can still check partial work. Check the per-node report for failed targets.",
		],
		parameters: workflowSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				switch (params.action) {
					case "list": {
						return textResult(formatWorkflowList(listWorkflowDefinitions(agentDir)));
					}
					case "show": {
						if (!params.name) {
							return textResult("_workflow show requires a `name`.");
						}
						const definition = loadWorkflowDefinition(agentDir, params.name);
						if (!definition) {
							return textResult(`_workflow show: no saved workflow named "${params.name}".`);
						}
						return textResult(JSON.stringify(definition, null, 2));
					}
					case "delete": {
						if (!params.name) {
							return textResult("_workflow delete requires a `name`.");
						}
						const removed = deleteWorkflowDefinition(agentDir, params.name);
						return textResult(
							removed
								? `Deleted workflow "${params.name}".`
								: `_workflow delete: no saved workflow named "${params.name}".`,
						);
					}
					case "save": {
						if (!params.name) {
							return textResult("_workflow save requires a `name`.");
						}
						if (!params.definition) {
							return textResult(
								"_workflow save requires a `definition` (JSON) via --definition or the heredoc form.",
							);
						}
						const definition = parseWorkflowJson(params.definition, params.name);
						saveWorkflowDefinition(agentDir, definition);
						const nodeKinds = definition.nodes.map((n) => n.kind).join(", ");
						return textResult(
							`Saved workflow "${definition.name}" (${definition.nodes.length} node${definition.nodes.length === 1 ? "" : "s"}: ${nodeKinds}). ` +
								`Run it with: _workflow run ${definition.name}`,
						);
					}
					case "run": {
						let definition: WorkflowDefinition | null = null;
						if (params.definition) {
							definition = parseWorkflowJson(params.definition, params.name);
						} else if (params.name) {
							definition = loadWorkflowDefinition(agentDir, params.name);
							if (!definition) {
								return textResult(`_workflow run: no saved workflow named "${params.name}".`);
							}
						} else {
							return textResult(
								"_workflow run requires a saved `name` or an inline `definition` (JSON).",
							);
						}
						const result = await executeWorkflow(definition, {
							agentDir,
							signal,
							defaultTimeout: params.timeout,
						});
						return textResult(formatWorkflowRun(result));
					}
					default:
						return textResult(`workflow: unsupported action "${params.action}".`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message);
			}
		},
		renderCall(args, _theme) {
			if (args?.action === "list") {
				return new Text("workflow (list saved workflows)", 0, 0);
			}
			if (args?.action === "run") {
				return new Text(`workflow run ${args.name ?? "(inline definition)"}`, 0, 0);
			}
			if (args?.action === "save") {
				return new Text(`workflow save ${args.name ?? "?"}`, 0, 0);
			}
			return new Text(`workflow ${args?.action ?? "?"} ${args?.name ?? ""}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}
