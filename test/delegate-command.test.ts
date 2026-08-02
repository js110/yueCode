import { describe, it, expect } from "vitest";
import { parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";

describe("parseBuiltinToolInput — delegate_agent", () => {
	it("parses `delegate_agent list`", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["list"]);
		expect(result).toEqual({ command: "delegate_agent", input: { action: "list" } });
	});

	it("parses `delegate_agent run <cwd> <task>` positionally", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "/proj", "fix", "the", "bug"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "fix the bug" },
		});
	});

	it("parses `delegate_agent run --cwd <path> --task <text>` flags", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "--cwd", "/proj", "--task", "do something"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "do something" },
		});
	});

	it("parses `delegate_agent run` with --timeout", () => {
		const result = parseBuiltinToolInput("_delegate_agent", [
			"run",
			"--cwd",
			"/proj",
			"--task",
			"go",
			"--timeout",
			"60000",
		]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "go", timeout: 60000 },
		});
	});

	it("uses short flags -d / -t", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "-d", "/proj", "-t", "quick"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "quick" },
		});
	});

	it("flags override positionals for cwd, positional remainder fills task", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "/ignored", "leftover", "--cwd", "/real"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/real", task: "leftover" },
		});
	});

	it("treats heredoc as the task for run", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "/proj"], "long\ntask\nbody");
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "long\ntask\nbody" },
		});
	});

	it("rejects an unknown action", () => {
		expect(() => parseBuiltinToolInput("_delegate_agent", ["explode"])).toThrow(/unknown action/);
	});

	it("requires an action", () => {
		expect(() => parseBuiltinToolInput("_delegate_agent", [])).toThrow(/action required/);
	});

	it("run with no cwd/task yields an action with undefined cwd/task", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run"]);
		expect(result).toEqual({ command: "delegate_agent", input: { action: "run" } });
	});

	it("parses `delegate_agent run_all <cwd-1> <cwd-2> --task <text>` positionally", () => {
		const result = parseBuiltinToolInput("_delegate_agent", [
			"run_all",
			"/proj-a",
			"/proj-b",
			"--task",
			"fix the bug",
		]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run_all", cwds: ["/proj-a", "/proj-b"], task: "fix the bug" },
		});
	});

	it("parses `delegate_agent run_all` with repeated --cwd and --concurrency", () => {
		const result = parseBuiltinToolInput("_delegate_agent", [
			"run_all",
			"--cwd",
			"/proj-a",
			"--cwd",
			"/proj-b",
			"--task",
			"go",
			"--concurrency",
			"4",
			"--timeout",
			"60000",
		]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: {
				action: "run_all",
				cwds: ["/proj-a", "/proj-b"],
				task: "go",
				concurrency: 4,
				timeout: 60000,
			},
		});
	});

	it("treats heredoc as the task for run_all", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run_all", "/proj-a", "/proj-b"], "long\ntask");
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run_all", cwds: ["/proj-a", "/proj-b"], task: "long\ntask" },
		});
	});

	it("run_all without cwds yields cwds undefined", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run_all", "--task", "go"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run_all", task: "go" },
		});
	});

	it("parses `delegate_agent verify <cwd> <criteria>` positionally", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["verify", "/proj", "all", "tests", "pass"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "verify", cwd: "/proj", criteria: "all tests pass" },
		});
	});

	it("parses `delegate_agent verify --cwd --criteria --artifact` flags", () => {
		const result = parseBuiltinToolInput("_delegate_agent", [
			"verify",
			"--cwd",
			"/proj",
			"--criteria",
			"green build",
			"--artifact",
			"worker did x",
			"--timeout",
			"60000",
		]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: {
				action: "verify",
				cwd: "/proj",
				criteria: "green build",
				artifact: "worker did x",
				timeout: 60000,
			},
		});
	});

	it("treats heredoc as the criteria for verify", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["verify", "/proj"], "criteria\nbody");
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "verify", cwd: "/proj", criteria: "criteria\nbody" },
		});
	});

	it("parses `delegate_agent verify_all <cwd-1> <cwd-2> --criteria` with concurrency", () => {
		const result = parseBuiltinToolInput("_delegate_agent", [
			"verify_all",
			"/proj-a",
			"/proj-b",
			"--criteria",
			"tests pass",
			"--concurrency",
			"4",
		]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: {
				action: "verify_all",
				cwds: ["/proj-a", "/proj-b"],
				criteria: "tests pass",
				concurrency: 4,
			},
		});
	});

	it("verify without criteria yields criteria undefined", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["verify", "/proj"]);
		expect(result).toEqual({ command: "delegate_agent", input: { action: "verify", cwd: "/proj" } });
	});
});
