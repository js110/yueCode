import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	deriveWorkspaceId,
	ensureWorkspaceMeta,
	getWorkspaceDir,
	listKnownWorkspaces,
} from "../src/core/event-store/workspace.js";
import {
	buildVerificationPrompt,
	clampConcurrency,
	createDelegateAgentToolDefinition,
	mapWithConcurrency,
} from "../src/core/tools/delegate-agent.js";

describe("listKnownWorkspaces", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `yue-ws-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (agentDir && existsSync(agentDir)) {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("returns [] when the workspaces directory does not exist", () => {
		expect(listKnownWorkspaces(agentDir)).toEqual([]);
	});

	test("returns [] when the workspaces directory is empty", () => {
		mkdirSync(join(agentDir, "workspaces"), { recursive: true });
		expect(listKnownWorkspaces(agentDir)).toEqual([]);
	});

	test("enumerates workspaces with valid meta.json, sorted by last_accessed_at desc", () => {
		const cwdA = join(tmpdir(), `project-a-${Date.now()}`);
		const cwdB = join(tmpdir(), `project-b-${Date.now()}`);
		const idA = deriveWorkspaceId(cwdA);
		const idB = deriveWorkspaceId(cwdB);

		// Create workspace A (older access) then B (newer access).
		ensureWorkspaceMeta(idA, cwdA, agentDir);
		// Manually backdate A's last_accessed_at.
		const metaAPath = join(getWorkspaceDir(idA, agentDir), "meta.json");
		writeFileSync(
			metaAPath,
			JSON.stringify({ workspace_id: idA, cwd: cwdA, created_at: 1000, last_accessed_at: 1000 }),
		);

		ensureWorkspaceMeta(idB, cwdB, agentDir);
		const metaBPath = join(getWorkspaceDir(idB, agentDir), "meta.json");
		writeFileSync(
			metaBPath,
			JSON.stringify({ workspace_id: idB, cwd: cwdB, created_at: 2000, last_accessed_at: 2000 }),
		);

		const workspaces = listKnownWorkspaces(agentDir);

		expect(workspaces).toHaveLength(2);
		// Most recent first.
		expect(workspaces[0].workspace_id).toBe(idB);
		expect(workspaces[1].workspace_id).toBe(idA);
		expect(workspaces[0].cwd).toBe(cwdB);
		expect(workspaces[0].has_event_db).toBe(false);
	});

	test("skips workspaces with malformed meta.json", () => {
		const cwd = join(tmpdir(), `project-c-${Date.now()}`);
		const id = deriveWorkspaceId(cwd);
		const dir = getWorkspaceDir(id, agentDir);
		// Write a malformed meta.json.
		writeFileSync(join(dir, "meta.json"), "{ not valid json");

		expect(listKnownWorkspaces(agentDir)).toEqual([]);
	});

	test("skips meta.json missing workspace_id or cwd", () => {
		const dir = join(agentDir, "workspaces", "ws_partial");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ workspace_id: "ws_partial" }));

		expect(listKnownWorkspaces(agentDir)).toEqual([]);
	});

	test("excludes the main agent's own cwd when excludeCwd is provided", () => {
		const mainCwd = join(tmpdir(), `main-${Date.now()}`);
		const otherCwd = join(tmpdir(), `other-${Date.now()}`);
		const mainId = deriveWorkspaceId(mainCwd);
		const otherId = deriveWorkspaceId(otherCwd);

		ensureWorkspaceMeta(mainId, mainCwd, agentDir);
		ensureWorkspaceMeta(otherId, otherCwd, agentDir);

		const workspaces = listKnownWorkspaces(agentDir, mainCwd);

		expect(workspaces).toHaveLength(1);
		expect(workspaces[0].workspace_id).toBe(otherId);
	});

	test("reports has_event_db=true when events.sqlite exists", () => {
		const cwd = join(tmpdir(), `project-d-${Date.now()}`);
		const id = deriveWorkspaceId(cwd);
		ensureWorkspaceMeta(id, cwd, agentDir);
		// Touch the events database file.
		writeFileSync(join(getWorkspaceDir(id, agentDir), "events.sqlite"), "");

		const workspaces = listKnownWorkspaces(agentDir);
		expect(workspaces).toHaveLength(1);
		expect(workspaces[0].has_event_db).toBe(true);
	});
});

describe("createDelegateAgentToolDefinition", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `yue-delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (agentDir && existsSync(agentDir)) {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
	test("exposes the expected name, description, and prompt guidelines", () => {
		const def = createDelegateAgentToolDefinition({ agentDir });

		expect(def.name).toBe("delegate_agent");
		expect(def.description).toContain("sub-agent");
		expect(def.promptSnippet).toContain("delegate_agent");
		expect(def.promptGuidelines).toBeDefined();
		expect(def.promptGuidelines!.length).toBeGreaterThan(0);
	});

	test("list action returns the known workspace list without spawning", async () => {
		// Register one workspace so the list is non-empty.
		const cwd = join(tmpdir(), `project-list-${Date.now()}`);
		const id = deriveWorkspaceId(cwd);
		ensureWorkspaceMeta(id, cwd, agentDir);

		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute(
			"call-1",
			{ action: "list" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("Known workspace agents");
		expect(text).toContain(cwd);
	});

	test("list reports an empty state when no workspaces are known", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute("call-2", { action: "list" }, undefined, undefined, {} as any);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("No known workspace agents found");
	});

	test("run without cwd or task returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute("call-3", { action: "run" }, undefined, undefined, {} as any);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires both");
	});

	test("run with cwd+task but a non-existent target returns an error result (no throw)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		// Use a cwd that does not exist and a cliPath that does not exist so
		// the spawn fails fast — the tool must catch and return a text error
		// rather than throwing out of the tool executor.
		const result = await def.execute(
			"call-4",
			{
				action: "run",
				cwd: join(tmpdir(), `no-such-${Date.now()}`),
				task: "do something",
				timeout: 1000,
			},
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("delegate_agent to");
		expect(text).toContain("failed");
	});

	test("run_all without cwds returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute("call-5", { action: "run_all" }, undefined, undefined, {} as any);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires at least one `cwd`");
	});

	test("run_all without a task returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute(
			"call-6",
			{ action: "run_all", cwds: [join(tmpdir(), `some-dir-${Date.now()}`)] },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires a `task`");
	});

	test("run_all with non-existent targets returns a fan-out report (no throw)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute(
			"call-7",
			{
				action: "run_all",
				cwds: [
					join(tmpdir(), `no-such-a-${Date.now()}`),
					join(tmpdir(), `no-such-b-${Date.now()}`),
				],
				task: "do something",
				timeout: 1000,
			},
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("Fan-out delegation (2 targets");
		expect(text).toContain("failed");
		expect(text).toContain("Summary: 0 ok, 2 failed");
	});

	test("verify without criteria returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute(
			"call-8",
			{ action: "verify", cwd: join(tmpdir(), `some-dir-${Date.now()}`) },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires `criteria`");
	});

	test("verify without cwd returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute("call-9", { action: "verify", criteria: "tests pass" }, undefined, undefined, {} as any);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires a `cwd`");
	});

	test("verify with a non-existent target returns an error result (no throw)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute(
			"call-10",
			{ action: "verify", cwd: join(tmpdir(), `no-such-v-${Date.now()}`), criteria: "tests pass", timeout: 1000 },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("verification of");
		expect(text).toContain("failed");
	});

	test("verify_all without criteria returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute("call-11", { action: "verify_all" }, undefined, undefined, {} as any);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires `criteria`");
	});

	test("verify_all without cwds returns a helpful error (no spawn)", async () => {
		const def = createDelegateAgentToolDefinition({ agentDir });
		const result = await def.execute(
			"call-12",
			{ action: "verify_all", criteria: "tests pass" },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("requires at least one `cwd`");
	});
});

describe("buildVerificationPrompt", () => {
	test("frames the verifier role, includes criteria, and demands a structured verdict", () => {
		const prompt = buildVerificationPrompt("all tests pass", "worker changed auth.ts");
		expect(prompt).toContain("verification agent");
		expect(prompt).toContain("Do NOT modify code");
		expect(prompt).toContain("CRITERIA:");
		expect(prompt).toContain("all tests pass");
		expect(prompt).toContain("WORKER OUTPUT TO CHECK:");
		expect(prompt).toContain("worker changed auth.ts");
		expect(prompt).toContain("VERDICT: PASS | PARTIAL | FAIL");
	});

	test("omits the worker-output section when no artifact is provided", () => {
		const prompt = buildVerificationPrompt("all tests pass");
		expect(prompt).not.toContain("WORKER OUTPUT TO CHECK:");
	});
});

describe("mapWithConcurrency", () => {
	test("preserves input order and respects the concurrency cap", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const results = await mapWithConcurrency(
			[1, 2, 3, 4, 5],
			2,
			async (n) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 20));
				inFlight--;
				return n * 10;
			},
		);
		expect(results).toEqual([10, 20, 30, 40, 50]);
		expect(maxInFlight).toBe(2);
	});

	test("returns [] for no items", async () => {
		const results = await mapWithConcurrency([], 4, async (n: number) => n);
		expect(results).toEqual([]);
	});

	test("stops claiming items once the signal is aborted", async () => {
		const controller = new AbortController();
		const processed: number[] = [];
		const results = await mapWithConcurrency(
			[1, 2, 3, 4],
			1,
			async (n) => {
				processed.push(n);
				if (n === 2) controller.abort();
				return n;
			},
			controller.signal,
		);
		expect(processed).toEqual([1, 2]);
		expect(results[0]).toBe(1);
		expect(results[1]).toBe(2);
		expect(results.slice(2).every((r) => r === undefined)).toBe(true);
	});
});

describe("clampConcurrency", () => {
	test("defaults to 8 and clamps into 1..16", () => {
		expect(clampConcurrency(undefined)).toBe(8);
		expect(clampConcurrency(NaN)).toBe(8);
		expect(clampConcurrency(0)).toBe(1);
		expect(clampConcurrency(-3)).toBe(1);
		expect(clampConcurrency(4)).toBe(4);
		expect(clampConcurrency(100)).toBe(16);
		expect(clampConcurrency(2.9)).toBe(2);
	});
});

