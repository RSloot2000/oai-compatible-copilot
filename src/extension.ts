import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { registerCodebaseTools } from "./codebase/tools";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	const codebaseIndex = registerCodebaseTools(context);
	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context, codebaseIndex);
	const provider = new HuggingFaceChatModelProvider(context.secrets, tokenCountStatusBarItem);
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OAI Compatible Provider API Key",
				prompt: existing ? "Update your OAI Compatible API key" : "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage("OAI Compatible API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("OAI Compatible API key saved.");
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in oaicopilot.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `OAI Compatible API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.codebaseStatus", async () => {
			const cancellation = new vscode.CancellationTokenSource();
			try {
				const status = await codebaseIndex.status(cancellation.token);
				vscode.window.showInformationMessage(`Codebase index: ${JSON.stringify(status)}`);
			} finally {
				cancellation.dispose();
			}
		}),
		vscode.commands.registerCommand("oaicopilot.codebaseIndex", async () => {
			const status = await codebaseIndex.index(new vscode.CancellationTokenSource().token);
			if (status.running) {
				vscode.window.showInformationMessage("Codebase index build started in the background. Use oaicopilot.codebaseStatus to check progress.");
			} else if (status.error) {
				vscode.window.showErrorMessage(`Codebase index build failed: ${status.error}`);
			} else if (status.lastResult) {
				vscode.window.showInformationMessage(`Codebase index built: ${status.lastResult.indexedFiles} files, ${status.lastResult.indexedChunks} chunks.`);
			}
		}),
		vscode.commands.registerCommand("oaicopilot.codebaseUpdate", async () => {
			const status = await codebaseIndex.update(new vscode.CancellationTokenSource().token);
			if (status.running) {
				vscode.window.showInformationMessage("Codebase index update started in the background. Use oaicopilot.codebaseStatus to check progress.");
			} else if (status.error) {
				vscode.window.showErrorMessage(`Codebase index update failed: ${status.error}`);
			} else if (status.lastResult) {
				vscode.window.showInformationMessage(`Codebase index updated: ${status.lastResult.indexedFiles} files, ${status.lastResult.indexedChunks} chunks.`);
			}
		}),
		vscode.commands.registerCommand("oaicopilot.codebaseSearch", async () => {
			const query = await vscode.window.showInputBox({
				title: "Search Codebase Index",
				prompt: "Describe the code or behavior to find",
				ignoreFocusOut: true,
			});
			if (!query?.trim()) {
				return;
			}
			const cancellation = new vscode.CancellationTokenSource();
			try {
				const results = await codebaseIndex.search(query.trim(), undefined, cancellation.token);
				const document = await vscode.workspace.openTextDocument({
					language: "json",
					content: JSON.stringify({ query, results }, null, 2),
				});
				await vscode.window.showTextDocument(document, { preview: true });
			} finally {
				cancellation.dispose();
			}
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("oaicopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("oaicopilot.logLevel")) {
				logger.reloadConfig();
			}
		})
	);
}

export function deactivate() {}
