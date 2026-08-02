import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { createBuiltinSkill, getBuiltinSkillIds, getBuiltinSkillInfos, getBuiltinSkills } from "../src/builtin-skills/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("built-in skills registry", () => {
	it("registers the grilling skill", () => {
		const ids = getBuiltinSkillIds();
		expect(ids).toContain("grilling");
	});

	it("exposes info for every built-in skill", () => {
		const infos = getBuiltinSkillInfos();
		expect(infos.some((i) => i.id === "grilling" && i.name === "grilling")).toBe(true);
	});

	it("creates a Skill with a readable on-disk file path", () => {
		const skill = createBuiltinSkill(getBuiltinSkillInfos()[0]);
		expect(skill.filePath).not.toMatch(/^</);
		expect(readFileSync(skill.filePath, "utf-8")).toContain("Interview me relentlessly");
		expect(skill.sourceInfo.source).toBe("builtin");
	});

	it("excludes disabled skills", () => {
		const skills = getBuiltinSkills(new Set(["grilling"]));
		expect(skills).toHaveLength(0);
	});
});

describe("DefaultResourceLoader built-in skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-builtin-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		// Isolate from the user's global ~/.agents/skills auto-discovery so the
		// bundled grilling skill is not shadowed by a same-named user skill.
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads built-in skills by default", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		// The bundled grilling skill is loaded. When the user also has a
		// same-named skill (e.g. from ~/.agents/skills auto-discovery), the user
		// skill wins — see "lets a user skill with the same name win" below.
		// In a clean environment the loaded skill is the built-in one.
		const grilling = skills.find((s) => s.name === "grilling");
		expect(grilling).toBeDefined();
		expect(grilling!.description).toContain("Grill the user relentlessly");
	});

	it("skips built-in skills when noBuiltinSkills is true", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noBuiltinSkills: true });
		await loader.reload();

		const { skills } = loader.getSkills();
		expect(skills.find((s) => s.name === "grilling" && s.sourceInfo.source === "builtin")).toBeUndefined();
	});

	it("skips built-in skills when noSkills is true", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
		await loader.reload();

		const { skills } = loader.getSkills();
		expect(skills.find((s) => s.name === "grilling" && s.sourceInfo.source === "builtin")).toBeUndefined();
	});

	it("skips a built-in skill disabled in settings", async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setBuiltinSkillDisabled("grilling", true);

		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		const { skills } = loader.getSkills();
		expect(skills.find((s) => s.name === "grilling" && s.sourceInfo.source === "builtin")).toBeUndefined();
	});

	it("lets a user skill with the same name win over the built-in", async () => {
		const skillsDir = join(agentDir, "skills", "grilling");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, "SKILL.md"),
			`---
name: grilling
description: A custom grilling override
---
Custom content.`,
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills, diagnostics } = loader.getSkills();
		const grilling = skills.find((s) => s.name === "grilling");
		expect(grilling).toBeDefined();
		// The user-supplied skill (agentDir or ~/.agents auto-discovery) wins; the
		// built-in copy is shadowed and a collision diagnostic is reported.
		expect(grilling!.sourceInfo.source).not.toBe("builtin");
		expect(diagnostics.some((d) => d.type === "collision")).toBe(true);
	});

	it("exposes the bundled skills dir as a real directory", () => {
		const dir = getBundledSkillsDir();
		expect(join(dir, "grilling", "SKILL.md")).toBe(createBuiltinSkill({ id: "grilling", name: "grilling", description: "x", fallbackContent: "x" }).filePath);
	});
});
