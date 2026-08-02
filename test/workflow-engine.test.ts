import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteWorkflowDefinition,
	executeWorkflow,
	formatWorkflowList,
	formatWorkflowRun,
	listWorkflowDefinitions,
	loadWorkflowDefinition,
	saveWorkflowDefinition,
	validateWorkflow,
	type WorkflowDefinition,
	type WorkflowRunResult,
} from "../src/core/workflow/engine.js";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "yue-workflow-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const validDefinition: WorkflowDefinition = {
	name: "fix-auth",
	description: "Fix the auth bug across projects",
	nodes: [
		{
			id: "workers",
			kind: "delegate",
			cwds: ["../proj-a", "../proj-b"],
			task: "fix the auth bug",
		},
		{
			id: "check",
			kind: "verify",
			cwds: ["../proj-a", "../proj-b"],
			criteria: "all tests pass",
			dependsOn: ["workers"],
		},
	],
};

describe("validateWorkflow", () => {
	it("accepts a valid definition", () => {
		expect(validateWorkflow(validDefinition)).toEqual([]);
	});

	it("rejects a missing name", () => {
		expect(validateWorkflow({ name: "", nodes: validDefinition.nodes })).toContain("workflow name is required");
	});

	it("rejects missing nodes", () => {
		expect(validateWorkflow({ name: "x", nodes: [] })).toContain("at least one node is required");
	});

	it("rejects a delegate node without a task", () => {
		const definition: WorkflowDefinition = {
			name: "x",
			nodes: [{ id: "w", kind: "delegate", cwds: ["../a"] }],
		};
		expect(validateWorkflow(definition)).toContain('node "w": delegate requires a task');
	});

	it("rejects a verify node without criteria", () => {
		const definition: WorkflowDefinition = {
			name: "x",
			nodes: [{ id: "v", kind: "verify", cwds: ["../a"] }],
		};
		expect(validateWorkflow(definition)).toContain('node "v": verify requires criteria');
	});

	it("rejects a node with no cwds", () => {
		const definition: WorkflowDefinition = {
			name: "x",
			nodes: [{ id: "w", kind: "delegate", cwds: [], task: "go" }],
		};
		expect(validateWorkflow(definition)).toContain('node "w": requires at least one cwd');
	});

	it("rejects a dependency cycle", () => {
		const definition: WorkflowDefinition = {
			name: "x",
			nodes: [
				{ id: "a", kind: "delegate", cwds: ["../a"], task: "x", dependsOn: ["b"] },
				{ id: "b", kind: "delegate", cwds: ["../a"], task: "x", dependsOn: ["a"] },
			],
		};
		expect(validateWorkflow(definition)).toContain("node dependency cycle detected");
	});

	it("rejects unknown dependsOn and duplicate ids", () => {
		const definition: WorkflowDefinition = {
			name: "x",
			nodes: [
				{ id: "a", kind: "delegate", cwds: ["../a"], task: "x", dependsOn: ["ghost"] },
				{ id: "a", kind: "delegate", cwds: ["../a"], task: "x" },
			],
		};
		const problems = validateWorkflow(definition);
		expect(problems).toContain('node "a": dependsOn unknown node "ghost"');
		expect(problems).toContain('duplicate node id "a"');
	});
});

describe("formatWorkflowRun", () => {
	it("formats a full run header, nodes, and per-target results", () => {
		const result: WorkflowRunResult = {
			definition: validDefinition,
			nodes: [
				{
					node: validDefinition.nodes[0],
					results: [
						{ cwd: "C:\\proj-a", ok: true, text: "worker did the fix" },
						{ cwd: "C:\\proj-b", ok: false, text: "spawn failed" },
					],
					ok: false,
					startedAt: 0,
					finishedAt: 2_000,
				},
			],
			startedAt: 0,
			finishedAt: 2_000,
			ok: false,
		};
		const output = formatWorkflowRun(result);
		expect(output).toContain('Workflow "fix-auth" — 1/2 nodes ran, 0 ok, 1 failed, 1 skipped (aborted) in 2.0s.');
		expect(output).toContain("## 1. workers (delegate, 2 targets) — failed");
		expect(output).toContain("### C:\\proj-a — ok");
		expect(output).toContain("### C:\\proj-b — failed");
	});

	it("truncates long per-target output", () => {
		const result: WorkflowRunResult = {
			definition: validDefinition,
			nodes: [
				{
					node: validDefinition.nodes[0],
					results: [{ cwd: "C:\\proj-a", ok: true, text: "x".repeat(5000) }],
					ok: true,
					startedAt: 0,
					finishedAt: 1_000,
				},
			],
			startedAt: 0,
			finishedAt: 1_000,
			ok: true,
		};
		const output = formatWorkflowRun(result);
		expect(output).toContain("1/2 nodes ran, 1 ok, 0 failed, 1 skipped (aborted)");
		expect(output).toContain("[truncated, 3000 chars omitted]");
	});
});

describe("formatWorkflowList", () => {
	it("returns an empty-state message when there are no workflows", () => {
		const output = formatWorkflowList([]);
		expect(output).toContain("No saved workflows found.");
		expect(output).toContain("_workflow save <name> --definition '{...}'");
		expect(output).toContain("_workflow run --definition '{...}'");
	});

	it("formats a numbered list with descriptions", () => {
		const output = formatWorkflowList([
			{ name: "fix-auth", description: "Fix the auth bug" },
			{ name: "lint-all" },
		]);
		expect(output).toContain("Saved workflows (2):");
		expect(output).toContain("1. fix-auth — Fix the auth bug");
		expect(output).toContain("2. lint-all");
	});
});

describe("workflow persistence", () => {
	it("saves, loads, lists, and deletes definitions under <agentDir>/workflows", () => {
		const agentDir = tempAgentDir();
		saveWorkflowDefinition(agentDir, validDefinition);

		const loaded = loadWorkflowDefinition(agentDir, "fix-auth");
		expect(loaded).not.toBeNull();
		expect(loaded?.name).toBe("fix-auth");
		expect(loaded?.nodes).toHaveLength(2);

		const summaries = listWorkflowDefinitions(agentDir);
		expect(summaries).toEqual([{ name: "fix-auth", description: "Fix the auth bug across projects" }]);

		expect(deleteWorkflowDefinition(agentDir, "fix-auth")).toBe(true);
		expect(loadWorkflowDefinition(agentDir, "fix-auth")).toBeNull();
		expect(listWorkflowDefinitions(agentDir)).toEqual([]);
	});

	it("rejects unsafe names and returns null/false for missing files", () => {
		const agentDir = tempAgentDir();
		expect(() => saveWorkflowDefinition(agentDir, { name: "../escape", nodes: validDefinition.nodes })).toThrow(
			/invalid name/,
		);
		expect(loadWorkflowDefinition(agentDir, "../escape")).toBeNull();
		expect(loadWorkflowDefinition(agentDir, "missing")).toBeNull();
		expect(deleteWorkflowDefinition(agentDir, "missing")).toBe(false);
		expect(listWorkflowDefinitions(agentDir)).toEqual([]);
	});

	it("rejects saving an invalid definition", () => {
		const agentDir = tempAgentDir();
		expect(() =>
			saveWorkflowDefinition(agentDir, {
				name: "bad",
				nodes: [{ id: "w", kind: "delegate", cwds: ["../a"] }],
			}),
		).toThrow(/delegate requires a task/);
	});
});

describe("executeWorkflow", () => {
	it("throws on an invalid definition without spawning any agents", async () => {
		await expect(
			executeWorkflow(
				{ name: "bad", nodes: [{ id: "w", kind: "delegate", cwds: ["../a"] }] },
				{ agentDir: tempAgentDir(), defaultTimeout: 100 },
			),
		).rejects.toThrow(/delegate requires a task/);
	});
});
