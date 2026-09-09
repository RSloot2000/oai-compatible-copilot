import * as vscode from "vscode";
import { CodebaseIndexService } from "./indexService";

interface SearchInput {
	query: string;
	limit?: number;
}

function textResult(value: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))]);
}

class CodebaseStatusTool implements vscode.LanguageModelTool<Record<string, never>> {
	constructor(private readonly service: CodebaseIndexService) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		return textResult(await this.service.status(token));
	}

	prepareInvocation(): vscode.PreparedToolInvocation {
		return { invocationMessage: "Checking the local codebase index" };
	}
}

class CodebaseIndexTool implements vscode.LanguageModelTool<Record<string, never>> {
	constructor(private readonly service: CodebaseIndexService) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const status = await this.service.index(token);
		return textResult({
			message: status.running
				? "Codebase index build started in the background. Use oaicopilot_codebase_status to check progress."
				: status.error
					? `Codebase index build failed: ${status.error}`
					: `Codebase index built: ${status.lastResult?.indexedFiles ?? 0} files, ${status.lastResult?.indexedChunks ?? 0} chunks.`,
			status,
		});
	}

	prepareInvocation(): vscode.PreparedToolInvocation {
		return {
			invocationMessage: "Starting the local codebase index build (runs in the background)",
			confirmationMessages: {
				title: "Build codebase index?",
				message:
					"This sends workspace text to the configured Ollama embedding server and stores vectors in Qdrant. The build runs in the background; use oaicopilot_codebase_status to check progress.",
			},
		};
	}
}

class CodebaseUpdateTool implements vscode.LanguageModelTool<Record<string, never>> {
	constructor(private readonly service: CodebaseIndexService) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const status = await this.service.update(token);
		return textResult({
			message: status.running
				? "Codebase index update started in the background. Use oaicopilot_codebase_status to check progress."
				: status.error
					? `Codebase index update failed: ${status.error}`
					: `Codebase index updated: ${status.lastResult?.indexedFiles ?? 0} files, ${status.lastResult?.indexedChunks ?? 0} chunks.`,
			status,
		});
	}

	prepareInvocation(): vscode.PreparedToolInvocation {
		return {
			invocationMessage: "Starting the local codebase index update (runs in the background)",
			confirmationMessages: {
				title: "Update codebase index?",
				message:
					"This embeds changed workspace files and updates their vectors in Qdrant. The update runs in the background; use oaicopilot_codebase_status to check progress.",
			},
		};
	}
}

class CodebaseSearchTool implements vscode.LanguageModelTool<SearchInput> {
	constructor(private readonly service: CodebaseIndexService) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const results = await this.service.search(options.input.query, options.input.limit, token);
		return textResult({ query: options.input.query, results });
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchInput>): vscode.PreparedToolInvocation {
		return { invocationMessage: `Searching the local codebase for “${options.input.query}”` };
	}
}

export function registerCodebaseTools(context: vscode.ExtensionContext): CodebaseIndexService {
	const service = new CodebaseIndexService(context);
	context.subscriptions.push(
		service,
		vscode.lm.registerTool("oaicopilot_codebase_status", new CodebaseStatusTool(service)),
		vscode.lm.registerTool("oaicopilot_codebase_index", new CodebaseIndexTool(service)),
		vscode.lm.registerTool("oaicopilot_codebase_update", new CodebaseUpdateTool(service)),
		vscode.lm.registerTool("oaicopilot_codebase_search", new CodebaseSearchTool(service))
	);
	return service;
}
