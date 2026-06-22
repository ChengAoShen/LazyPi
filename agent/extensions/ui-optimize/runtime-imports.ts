import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getCodingAgentRoot } from "./paths.ts";

export type RuntimeTheme = { fg?: (color: string, text: string) => string };

export async function loadInteractiveRuntime(): Promise<{
	ToolExecutionComponent?: { prototype: Record<PropertyKey, unknown> };
	AssistantMessageComponent?: { prototype: Record<PropertyKey, unknown> };
	theme?: RuntimeTheme;
}> {
	const root = getCodingAgentRoot();
	const interactivePath = (...segments: string[]) => pathToFileURL(join(root, "dist/modes/interactive", ...segments)).href;

	const [{ ToolExecutionComponent }, { AssistantMessageComponent }, themeModule] = await Promise.all([
		import(interactivePath("components/tool-execution.js")) as Promise<{ ToolExecutionComponent?: { prototype: Record<PropertyKey, unknown> } }>,
		import(interactivePath("components/assistant-message.js")) as Promise<{ AssistantMessageComponent?: { prototype: Record<PropertyKey, unknown> } }>,
		import(interactivePath("theme/theme.js")).catch(() => undefined) as Promise<{ theme?: RuntimeTheme } | undefined>,
	]);

	return { ToolExecutionComponent, AssistantMessageComponent, theme: themeModule?.theme };
}
