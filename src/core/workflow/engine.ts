/**
 * Workflow orchestration runtime — the third layer of the graph-workflow stack.
 *
 * A workflow is a persistent, model-authored DAG of sub-agent nodes
 * (`delegate` / `verify` / `synthesize`). The runtime executes it with zero-token
 * coordination: the DAG *is* the plan. Running a workflow just schedules
 * sub-agents via the existing RPC infrastructure (one `RpcClient` sub-process per
 * target directory), and definitions are persisted under
 * `<agentDir>/workflows/<name>.json` so a saved workflow can be re-run by name.
 *
 * The execution model is wave-based: nodes whose `dependsOn` are satisfied run in
 * parallel, each node fanning out over its `cwds` with a bounded concurrency pool.
 * Node failures are recorded but do not abort the graph — so a `verify` node can
 * still check partial work after a `delegate` node had spawn failures.
 *
 * Shell lineage: Pi -> Yue.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	buildVerificationPrompt,
	clampConcurrency,
	delegateOne,
	mapWithConcurrency,
	type DelegateOneResult,
} from "../tools/delegate-agent.js";

export type WorkflowNodeKind = "delegate" | "verify" | "synthesize";

export interface WorkflowNode {
	/** Unique node id within the workflow (referenced by `dependsOn`). */
	id: string;
	kind: WorkflowNodeKind;
	/**
	 * Target project directories. `delegate` / `verify` fan out across every
	 * entry; `synthesize` uses the first entry as the single aggregation cwd.
	 */
	cwds: string[];
	/** Task prompt for `delegate` and `synthesize` nodes. */
	task?: string;
	/** Acceptance criteria for `verify` nodes. */
	criteria?: string;
	/** Optional context handed to `verify` nodes (e.g. a worker's output). */
	artifact?: string;
	/** Node ids that must finish before this node starts. */
	dependsOn?: string[];
	/** Per-node parallelism override (default 8, clamped to 1-16). */
	concurrency?: number;
	/** Per-sub-agent timeout in ms (default 120000). */
	timeout?: number;
}

export interface WorkflowDefinition {
	name: string;
	description?: string;
	nodes: WorkflowNode[];
}

export interface WorkflowNodeRun {
	node: WorkflowNode;
	/** Per-target results (one entry per cwd). */
	results: DelegateOneResult[];
	ok: boolean;
	startedAt: number;
	finishedAt: number;
}

export interface WorkflowRunResult {
	definition: WorkflowDefinition;
	/** Completed node runs, in execution order. */
	nodes: WorkflowNodeRun[];
	startedAt: number;
	finishedAt: number;
	ok: boolean;
}

export interface WorkflowExecutionOptions {
	agentDir: string;
	signal?: AbortSignal;
	/** Default per-sub-agent timeout applied to nodes that don't set their own. */
	defaultTimeout?: number;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… [truncated, ${text.length - max} chars omitted]`;
}

/** Return a deterministic topological order of node ids, or null if there is a cycle. */
function topoOrder(nodes: readonly WorkflowNode[]): string[] | null {
	const ids = new Set(nodes.map((n) => n.id));
	const indegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();
	for (const node of nodes) {
		indegree.set(node.id, 0);
		adjacency.set(node.id, []);
	}
	for (const node of nodes) {
		for (const dep of node.dependsOn ?? []) {
			if (!ids.has(dep)) continue;
			indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
			adjacency.get(dep)?.push(node.id);
		}
	}
	const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
	const order: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		order.push(id);
		for (const next of adjacency.get(id) ?? []) {
			const remaining = (indegree.get(next) ?? 1) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) queue.push(next);
		}
	}
	return order.length === nodes.length ? order : null;
}

/**
 * Validate a workflow definition, returning a list of problems (empty = valid).
 */
export function validateWorkflow(definition: WorkflowDefinition): string[] {
	const problems: string[] = [];
	if (!definition || typeof definition !== "object") {
		return ["workflow definition must be an object"];
	}
	if (!definition.name) {
		problems.push("workflow name is required");
	}
	if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
		problems.push("at least one node is required");
		return problems;
	}
	const ids = new Set<string>();
	for (const node of definition.nodes) {
		if (!node || typeof node !== "object" || !node.id) {
			problems.push("a node is missing its id");
			continue;
		}
		if (ids.has(node.id)) {
			problems.push(`duplicate node id "${node.id}"`);
		}
		ids.add(node.id);
		if (!["delegate", "verify", "synthesize"].includes(node.kind)) {
			problems.push(`node "${node.id}": unknown kind "${node.kind}"`);
		}
		if (!Array.isArray(node.cwds) || node.cwds.length === 0) {
			problems.push(`node "${node.id}": requires at least one cwd`);
		}
		if (node.kind === "delegate" && !node.task) {
			problems.push(`node "${node.id}": delegate requires a task`);
		}
		if (node.kind === "verify" && !node.criteria) {
			problems.push(`node "${node.id}": verify requires criteria`);
		}
		if (node.kind === "synthesize" && !node.task) {
			problems.push(`node "${node.id}": synthesize requires a task`);
		}
		for (const dep of node.dependsOn ?? []) {
			if (!ids.has(dep) && !definition.nodes.some((n) => n.id === dep)) {
				problems.push(`node "${node.id}": dependsOn unknown node "${dep}"`);
			}
		}
	}
	if (problems.length === 0 && topoOrder(definition.nodes) === null) {
		problems.push("node dependency cycle detected");
	}
	return problems;
}

/** Build the prompt for a `synthesize` node: review upstream outputs, then produce the synthesis. */
function buildSynthesisPrompt(task: string, upstream: readonly WorkflowNodeRun[]): string {
	const sections: string[] = [
		"You are the synthesizing agent. Review the outputs of the upstream sub-agents below and produce the " +
			"requested synthesis. Do NOT modify code.",
		"",
		"UPSTREAM OUTPUTS:",
	];
	for (const run of upstream) {
		sections.push(`## ${run.node.id} (${run.node.kind})`);
		for (const result of run.results) {
			sections.push(`### ${result.cwd} — ${result.ok ? "ok" : "failed"}\n${truncate(result.text, 2000)}`);
		}
		sections.push("");
	}
	sections.push("SYNTHESIS TASK:", task);
	sections.push(
		"",
		"Respond with a single, well-structured synthesis that directly fulfills the synthesis task.",
	);
	return sections.join("\n");
}

/**
 * Execute a workflow definition with wave-based parallelism.
 *
 * Independent nodes run concurrently; each node fans out over its `cwds` with a
 * bounded pool. Node spawn failures are recorded per-target and do not abort the
 * graph, so downstream verification can still inspect partial work. Returns the
 * collected per-node runs; if the graph is aborted mid-way, remaining nodes are
 * simply absent from `result.nodes` and `result.ok` is false.
 */
export async function executeWorkflow(
	definition: WorkflowDefinition,
	options: WorkflowExecutionOptions,
): Promise<WorkflowRunResult> {
	const problems = validateWorkflow(definition);
	if (problems.length > 0) {
		throw new Error(`workflow: invalid definition\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}
	if (topoOrder(definition.nodes) === null) {
		throw new Error("workflow: node dependency cycle detected");
	}

	const nodeById = new Map(definition.nodes.map((n) => [n.id, n]));
	const defaultTimeout = options.defaultTimeout ?? 120_000;
	const startedAt = Date.now();
	const runs: WorkflowNodeRun[] = [];
	const runById = new Map<string, WorkflowNodeRun>();
	const done = new Set<string>();

	async function runNode(node: WorkflowNode): Promise<WorkflowNodeRun> {
		const nodeStart = Date.now();
		const concurrency = clampConcurrency(node.concurrency);
		const timeout = node.timeout ?? defaultTimeout;
		const { agentDir, signal } = options;

		let results: DelegateOneResult[];
		if (node.kind === "delegate") {
			results = await mapWithConcurrency(
				node.cwds,
				concurrency,
				(cwd) => delegateOne({ cwd, task: node.task!, timeout, agentDir, signal }),
				signal,
			);
		} else if (node.kind === "verify") {
			const prompt = buildVerificationPrompt(node.criteria!, node.artifact);
			results = await mapWithConcurrency(
				node.cwds,
				concurrency,
				(cwd) => delegateOne({ cwd, task: prompt, timeout, agentDir, signal }),
				signal,
			);
		} else {
			const upstream = definition.nodes.filter((n) => n.id !== node.id).map((n) => runById.get(n.id)).filter((r): r is WorkflowNodeRun => r !== undefined);
			const prompt = buildSynthesisPrompt(node.task!, upstream);
			results = [await delegateOne({ cwd: node.cwds[0], task: prompt, timeout, agentDir, signal })];
		}

		return { node, results, ok: results.every((r) => r.ok), startedAt: nodeStart, finishedAt: Date.now() };
	}

	// Wave-based execution: run every node whose dependencies are satisfied in
	// parallel until all nodes have run (or the graph is aborted).
	while (runs.length < definition.nodes.length && !options.signal?.aborted) {
		const ready = definition.nodes.filter(
			(n) => !done.has(n.id) && (n.dependsOn ?? []).every((dep) => done.has(dep)),
		);
		if (ready.length === 0) break;
		const batch = await Promise.all(ready.map((node) => runNode(nodeById.get(node.id)!)));
		for (const run of batch) {
			done.add(run.node.id);
			runById.set(run.node.id, run);
			runs.push(run);
		}
	}

	return {
		definition,
		nodes: runs,
		startedAt,
		finishedAt: Date.now(),
		ok: runs.length === definition.nodes.length && runs.every((r) => r.ok),
	};
}

// ============================================================================
// Persistence (reuse the SchedulerEngine-style on-disk store: one JSON file per
// workflow under <agentDir>/workflows/, so saved graphs can be re-run by name).
// ============================================================================

/** Format a completed workflow run as a readable report for the model. */
export function formatWorkflowRun(result: WorkflowRunResult): string {
	const { definition, nodes } = result;
	const okCount = nodes.filter((n) => n.ok).length;
	const failedCount = nodes.length - okCount;
	const skipped = definition.nodes.length - nodes.length;
	const duration = ((result.finishedAt - result.startedAt) / 1000).toFixed(1);
	const header =
		`Workflow "${definition.name}" — ${nodes.length}/${definition.nodes.length} node${definition.nodes.length === 1 ? "" : "s"} ran, ` +
		`${okCount} ok, ${failedCount} failed${skipped ? `, ${skipped} skipped (aborted)` : ""} in ${duration}s.`;
	const body = nodes
		.map((run, index) => {
			const status = run.ok ? "ok" : "failed";
			const lines = [
				`## ${index + 1}. ${run.node.id} (${run.node.kind}, ${run.results.length} target${run.results.length === 1 ? "" : "s"}) — ${status}`,
			];
			for (const resultRun of run.results) {
				lines.push(`### ${resultRun.cwd} — ${resultRun.ok ? "ok" : "failed"}\n${truncate(resultRun.text, 2000)}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
	return `${header}\n\n${body}`;
}

/** Format the saved-workflow list as a readable text block for the model. */
export function formatWorkflowList(workflows: readonly WorkflowSummary[]): string {
	if (workflows.length === 0) {
		return (
			"No saved workflows found. Save one with `_workflow save <name> --definition '{...}'`, " +
			"or run an inline graph with `_workflow run --definition '{...}'`."
		);
	}
	const lines = workflows.map(
		(workflow, index) =>
			`${index + 1}. ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ""}`,
	);
	return `Saved workflows (${workflows.length}):\n\n${lines.join("\n")}`;
}

/** Workflows directory under the agent config dir. */
export function getWorkflowDir(agentDir: string): string {
	return join(agentDir, "workflows");
}

function workflowFilePath(agentDir: string, name: string): string {
	return join(getWorkflowDir(agentDir), `${name}.json`);
}

/** Safe workflow names: letters, digits, `.`, `_`, `-`, max 80 chars (no path traversal). */
export function isValidWorkflowName(name: string): boolean {
	return /^[a-zA-Z0-9._-]{1,80}$/.test(name);
}

export function saveWorkflowDefinition(agentDir: string, definition: WorkflowDefinition): void {
	if (!isValidWorkflowName(definition.name)) {
		throw new Error(
			`workflow: invalid name "${definition.name}" — use letters, digits, . _ - (max 80 chars)`,
		);
	}
	const problems = validateWorkflow(definition);
	if (problems.length > 0) {
		throw new Error(`workflow: invalid definition\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}
	mkdirSync(getWorkflowDir(agentDir), { recursive: true });
	writeFileSync(workflowFilePath(agentDir, definition.name), `${JSON.stringify(definition, null, 2)}\n`, "utf8");
}

/** Load a saved workflow, or null when the name is unsafe / the file is missing or malformed. */
export function loadWorkflowDefinition(agentDir: string, name: string): WorkflowDefinition | null {
	if (!isValidWorkflowName(name)) return null;
	const file = workflowFilePath(agentDir, name);
	if (!existsSync(file)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as WorkflowDefinition).nodes)) {
			return null;
		}
		return parsed as WorkflowDefinition;
	} catch {
		return null;
	}
}

export interface WorkflowSummary {
	name: string;
	description?: string;
}

/** List saved workflows, sorted by name. */
export function listWorkflowDefinitions(agentDir: string): WorkflowSummary[] {
	const dir = getWorkflowDir(agentDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -".json".length))
		.sort()
		.map((name) => {
			const def = loadWorkflowDefinition(agentDir, name);
			return { name, description: def?.description };
		});
}

/** Delete a saved workflow. Returns true when a file was removed. */
export function deleteWorkflowDefinition(agentDir: string, name: string): boolean {
	if (!isValidWorkflowName(name)) return false;
	const file = workflowFilePath(agentDir, name);
	if (!existsSync(file)) return false;
	rmSync(file, { force: true });
	return true;
}
