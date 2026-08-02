import { describe, it, expect } from "vitest";
import { getBuiltinCommandHelp, parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";

describe("parseBuiltinToolInput — workflow", () => {
	it("parses `workflow list`", () => {
		const result = parseBuiltinToolInput("_workflow", ["list"]);
		expect(result).toEqual({ command: "workflow", input: { action: "list" } });
	});

	it("parses `workflow show <name>` positionally", () => {
		const result = parseBuiltinToolInput("_workflow", ["show", "fix-auth"]);
		expect(result).toEqual({ command: "workflow", input: { action: "show", name: "fix-auth" } });
	});

	it("parses `workflow delete <name>` positionally", () => {
		const result = parseBuiltinToolInput("_workflow", ["delete", "fix-auth"]);
		expect(result).toEqual({ command: "workflow", input: { action: "delete", name: "fix-auth" } });
	});

	it("parses `workflow save <name> --definition '<json>'`", () => {
		const definition = '{"name":"fix-auth","nodes":[]}';
		const result = parseBuiltinToolInput("_workflow", ["save", "fix-auth", "--definition", definition]);
		expect(result).toEqual({
			command: "workflow",
			input: { action: "save", name: "fix-auth", definition },
		});
	});

	it("uses short flags -n / -d", () => {
		const result = parseBuiltinToolInput("_workflow", ["save", "-n", "wf", "-d", "{}"]);
		expect(result).toEqual({ command: "workflow", input: { action: "save", name: "wf", definition: "{}" } });
	});

	it("treats heredoc as the definition for save", () => {
		const result = parseBuiltinToolInput("_workflow", ["save", "fix-auth"], '{"name":"fix-auth","nodes":[]}');
		expect(result).toEqual({
			command: "workflow",
			input: { action: "save", name: "fix-auth", definition: '{"name":"fix-auth","nodes":[]}' },
		});
	});

	it("parses `workflow run <name>` positionally", () => {
		const result = parseBuiltinToolInput("_workflow", ["run", "fix-auth"]);
		expect(result).toEqual({ command: "workflow", input: { action: "run", name: "fix-auth" } });
	});

	it("parses `workflow run --definition '<json>'` inline without a name", () => {
		const definition = '{"name":"inline","nodes":[]}';
		const result = parseBuiltinToolInput("_workflow", ["run", "--definition", definition]);
		expect(result).toEqual({ command: "workflow", input: { action: "run", definition } });
	});

	it("parses `workflow run` with --timeout", () => {
		const result = parseBuiltinToolInput("_workflow", ["run", "fix-auth", "--timeout", "60000"]);
		expect(result).toEqual({ command: "workflow", input: { action: "run", name: "fix-auth", timeout: 60000 } });
	});

	it("flags override positionals for name", () => {
		const result = parseBuiltinToolInput("_workflow", ["show", "/ignored", "--name", "real"]);
		expect(result).toEqual({ command: "workflow", input: { action: "show", name: "real" } });
	});

	it("run with no name/definition yields an action with undefined name/definition", () => {
		const result = parseBuiltinToolInput("_workflow", ["run"]);
		expect(result).toEqual({ command: "workflow", input: { action: "run" } });
	});

	it("rejects an unknown action", () => {
		expect(() => parseBuiltinToolInput("_workflow", ["explode"])).toThrow(/unknown action/);
	});

	it("requires an action", () => {
		expect(() => parseBuiltinToolInput("_workflow", [])).toThrow(/action required/);
	});
});

describe("getBuiltinCommandHelp — workflow", () => {
	it("returns help text for _workflow", () => {
		const help = getBuiltinCommandHelp("_workflow");
		expect(help).toBeDefined();
		expect(help).toContain("_workflow -");
		expect(help).toContain("Actions:");
		expect(help).toContain("Node kinds:");
		expect(help).toContain("save <name>");
		expect(help).toContain("run <name>");
		expect(help).toContain("list");
		expect(help).toContain("show <name>");
		expect(help).toContain("delete <name>");
		expect(help).toContain("--definition, -d");
		expect(help).toContain("--timeout");
		expect(help).toContain("<<EOF");
		expect(help).toContain("Examples:");
	});

	it("returns undefined for a non-built-in command", () => {
		expect(getBuiltinCommandHelp("_grep")).toBeUndefined();
	});
});
