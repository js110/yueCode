/**
 * Built-in skills registry.
 *
 * Built-in skills ship with Yue and are enabled by default. They behave exactly
 * like user skills (loaded via the same `Skill` shape, injected into the system
 * prompt, and readable via `_read`) but are always present unless the user
 * explicitly disables one in `settings.json` under `disabledBuiltinSkills`.
 *
 * To add a new built-in skill:
 * 1. Create `src/builtin-skills/<id>/SKILL.md` (frontmatter + body).
 * 2. Register it below in `BUILTIN_SKILLS`.
 * 3. Add `shx cp` lines in `copy-assets` / `copy-binary-assets` so the file is
 *    shipped next to the compiled output (mirrors the theme/export-html flow).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBundledSkillsDir } from "../config.js";
import type { Skill, SkillFrontmatter } from "../core/skills.js";
import { createSyntheticSourceInfo } from "../core/source-info.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

const GRILLING_SKILL_ID = "grilling";

/** Content used when the on-disk SKILL.md is unavailable (e.g. Bun single binary). */
const GRILLING_SKILL_CONTENT = `---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.
`;

interface BuiltinSkillDefinition {
	/** Stable id used in `settings.disabledBuiltinSkills`. */
	id: string;
	/** Human-readable name shown in UI. */
	name: string;
	/** Short, human-readable description shown in UI. */
	description: string;
	/** Raw SKILL.md content (frontmatter + body), used as a fallback when the on-disk file is absent. */
	fallbackContent: string;
}

/** All built-in skills, in load order. */
export const BUILTIN_SKILLS: readonly BuiltinSkillDefinition[] = [
	{
		id: GRILLING_SKILL_ID,
		name: "grilling",
		description: "Grill the user relentlessly about a plan, decision, or idea.",
		fallbackContent: GRILLING_SKILL_CONTENT,
	},
];

/** On-disk SKILL.md path for a built-in skill id (relative to the bundled skills dir). */
export function builtinSkillFilePath(id: string): string {
	return join(getBundledSkillsDir(), id, "SKILL.md");
}

/**
 * Build a Skill for a built-in skill definition.
 *
 * Prefers the on-disk SKILL.md (so the model can `_read` the real file and the
 * path is resolvable). Falls back to the inlined content with a virtual path
 * when the file is missing (e.g. running from a Bun single binary).
 */
export function createBuiltinSkill(def: BuiltinSkillDefinition): Skill {
	const filePath = builtinSkillFilePath(def.id);
	const sourceBaseDir = getBundledSkillsDir();

	let rawContent: string;
	let resolvedFilePath: string;
	if (existsSync(filePath)) {
		rawContent = readFileSync(filePath, "utf-8");
		resolvedFilePath = filePath;
	} else {
		rawContent = def.fallbackContent;
		resolvedFilePath = `<builtin:${def.id}>`;
	}

	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
	return {
		name: frontmatter.name || def.id,
		description: frontmatter.description || def.description,
		filePath: resolvedFilePath,
		baseDir: resolvedFilePath.startsWith("<") ? resolvedFilePath : sourceBaseDir,
		sourceInfo: createSyntheticSourceInfo(resolvedFilePath, {
			source: "builtin",
			scope: "temporary",
			origin: "package",
			baseDir: sourceBaseDir,
		}),
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	};
}

/** Return all built-in skills, excluding any disabled ids. */
export function getBuiltinSkills(disabledIds: ReadonlySet<string>): Skill[] {
	return BUILTIN_SKILLS.filter((def) => !disabledIds.has(def.id)).map(createBuiltinSkill);
}

/** All built-in skill ids (for diagnostics / UI). */
export function getBuiltinSkillIds(): string[] {
	return BUILTIN_SKILLS.map((def) => def.id);
}

/** Info (id/name/description) for every built-in skill, regardless of enabled state. */
export interface BuiltinSkillInfo {
	id: string;
	name: string;
	description: string;
}

export function getBuiltinSkillInfos(): BuiltinSkillInfo[] {
	return BUILTIN_SKILLS.map((def) => ({ id: def.id, name: def.name, description: def.description }));
}
