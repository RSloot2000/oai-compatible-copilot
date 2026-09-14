import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { ConfigSidebarView } from "./views/configSidebarView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { registerCodebaseTools } from "./codebase/tools";

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

	// Register the sidebar configuration view (activity bar icon).
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ConfigSidebarView.viewType, new ConfigSidebarView(context.extensionUri, context.secrets))
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
		}),
		vscode.commands.registerCommand("oaicopilot.codebaseDeleteCollection", async () => {
			const cancellation = new vscode.CancellationTokenSource();
			try {
				await codebaseIndex.deleteCollection(cancellation.token);
				vscode.window.showInformationMessage("Qdrant collection deleted. It will be recreated on the next index build.");
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to delete collection: ${error instanceof Error ? error.message : String(error)}`);
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

	// Pin / unpin files to the context (immune to conversation compaction)
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.pinFile", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor?.document?.uri?.fsPath) {
				vscode.window.showWarningMessage("No active file to pin. Open a file first.");
				return;
			}
			const filePath = editor.document.uri.fsPath;
			const config = vscode.workspace.getConfiguration();
			const pinned: string[] = config.get<string[]>("oaicopilot.pinnedFiles", []);
			if (pinned.includes(filePath)) {
				vscode.window.showInformationMessage(`Already pinned: ${filePath}`);
				return;
			}
			await config.update("oaicopilot.pinnedFiles", [...pinned, filePath], vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Pinned to context: ${filePath}`);
		}),
		vscode.commands.registerCommand("oaicopilot.unpinFile", async () => {
			const config = vscode.workspace.getConfiguration();
			const pinned: string[] = config.get<string[]>("oaicopilot.pinnedFiles", []);
			if (pinned.length === 0) {
				vscode.window.showInformationMessage("No pinned files.");
				return;
			}
			const editor = vscode.window.activeTextEditor;
			const activePath = editor?.document?.uri?.fsPath;
			const items = pinned.map((p) => ({
				label: p,
				description: p === activePath ? "(active file)" : undefined,
			}));
			const selected = await vscode.window.showQuickPick(items, {
				title: "Select a pinned file to unpin",
			});
			if (!selected) {
				return;
			}
			await config.update(
				"oaicopilot.pinnedFiles",
				pinned.filter((p) => p !== selected.label),
				vscode.ConfigurationTarget.Global
			);
			vscode.window.showInformationMessage(`Unpinned: ${selected.label}`);
		}),
		vscode.commands.registerCommand("oaicopilot.listPinnedFiles", async () => {
			const config = vscode.workspace.getConfiguration();
			const pinned: string[] = config.get<string[]>("oaicopilot.pinnedFiles", []);
			if (pinned.length === 0) {
				vscode.window.showInformationMessage("No pinned files.");
				return;
			}
			const editor = vscode.window.activeTextEditor;
			const activePath = editor?.document?.uri?.fsPath;
			const items = await Promise.all(
				pinned.map(async (p) => {
					let size: string | undefined;
					try {
						const stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
						size = formatBytes(stat.size);
					} catch {
						size = "(missing)";
					}
					return {
						label: p,
						description: [size, p === activePath ? "(active file)" : undefined]
							.filter(Boolean)
						.join(" "),
					};
				})
			);
			const selected = await vscode.window.showQuickPick(items, {
				title: `Pinned files (${pinned.length}) - select to open read-only`,
			});
			if (!selected) {
				return;
			}
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(selected.label));
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
