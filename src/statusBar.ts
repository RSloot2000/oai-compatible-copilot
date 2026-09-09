import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import { CodebaseIndexService, CodebaseStatus, BuildStatus } from "./codebase/indexService";

/**
 * Token-usage snapshot shown in the status bar QuickPick.
 */
interface TokenInfo {
	total: number;
	max: number;
	messages: number;
	tools: number;
	progressBar: string;
}

// Module-level state shared between the token updater and the codebase watcher.
let activeItem: vscode.StatusBarItem | undefined;
let activeService: CodebaseIndexService | undefined;
let tokenText = "$(symbol-numeric) Ready";
let tokenTooltip = "Current model token usage";
let tokenBackground: vscode.ThemeColor | undefined;
let tokenInfo: TokenInfo | undefined;
let codebaseStatus: CodebaseStatus | undefined;
let buildState: BuildStatus | undefined;

/**
 * Creates the status bar item and wires up the codebase index status + dropdown menu.
 * Clicking the item opens a QuickPick menu that stays open until the user clicks elsewhere.
 */
export function initStatusBar(context: vscode.ExtensionContext, service: CodebaseIndexService): vscode.StatusBarItem {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	item.name = "OAICopilot Status";
	item.text = "$(symbol-numeric) Ready";
	item.tooltip = "OAICopilot - Click to open the status popup";
	item.command = "oaicopilot.showMenu";

	activeItem = item;
	activeService = service;

	// Live updates from the codebase index service.
	context.subscriptions.push(
		service.onStatusChanged((status) => {
			codebaseStatus = status;
			render();
		}),
		service.onBuildChanged((build) => {
			buildState = build;
			render();
		}),
		vscode.commands.registerCommand("oaicopilot.showMenu", () => showMenu())
	);

	// Prime the codebase status in the background.
	void service.status(new vscode.CancellationTokenSource().token);

	item.show();
	return item;
}

/**
 * Combines the token-usage portion and the codebase-index portion into the status bar text.
 */
function render(): void {
	if (!activeItem) {
		return;
	}
	const cb = codebaseIndicator();
	activeItem.text = `${tokenText} ${cb}`.trim();
	activeItem.tooltip = `${tokenTooltip}\n\n${codebaseTooltip()}`;
	activeItem.backgroundColor = tokenBackground;
}

/**
 * Returns the codebase index icon + short label for the status bar.
 */
function codebaseIndicator(): string {
	if (buildState?.running) {
		return "$(loading~spin) indexing";
	}
	if (!codebaseStatus) {
		return "$(database) …";
	}
	if (!codebaseStatus.configured) {
		return "$(circle-slash) no index";
	}
	if (codebaseStatus.stale) {
		return "$(warning) stale";
	}
	if (codebaseStatus.indexed) {
		return "$(check) indexed";
	}
	return "$(circle-slash) no index";
}

function codebaseTooltip(): string {
	if (buildState?.running) {
		return "Codebase index: building in the background…";
	}
	if (!codebaseStatus) {
		return "Codebase index: loading…";
	}
	const lines = [`Codebase index: ${codebaseStatus.indexed ? "indexed" : codebaseStatus.stale ? "stale" : "not indexed"}`];
	if (codebaseStatus.indexedFiles !== undefined) {
		lines.push(`  Files: ${codebaseStatus.indexedFiles}`);
	}
	if (codebaseStatus.indexedChunks !== undefined) {
		lines.push(`  Chunks: ${codebaseStatus.indexedChunks}`);
	}
	if (codebaseStatus.pendingChanges !== undefined && codebaseStatus.pendingChanges > 0) {
		lines.push(`  Pending changes: ${codebaseStatus.pendingChanges}`);
	}
	if (codebaseStatus.lastUpdated) {
		lines.push(`  Last updated: ${codebaseStatus.lastUpdated}`);
	}
	if (codebaseStatus.message) {
		lines.push(`  ${codebaseStatus.message}`);
	}
	return lines.join("\n");
}

/**
 * Opens the status QuickPick. It stays open until the user presses Escape
 * or clicks elsewhere. Shows token usage, codebase index status, and actions.
 */
function showMenu(): void {
	const items: vscode.QuickPickItem[] = [];

	// --- Token Usage / Context ---
	items.push({ label: "Token Usage / Context", kind: vscode.QuickPickItemKind.Separator });

	if (tokenInfo) {
		items.push({
			label: tokenInfo.progressBar,
			description: `${formatTokenCount(tokenInfo.total)} / ${formatTokenCount(tokenInfo.max)}`,
			alwaysShow: true,
		});
		items.push({
			label: "Messages",
			description: formatTokenCount(tokenInfo.messages),
			alwaysShow: true,
		});
		items.push({
			label: "Tools",
			description: formatTokenCount(tokenInfo.tools),
			alwaysShow: true,
		});
	} else {
		items.push({ label: "No token data yet", alwaysShow: true });
	}

	// --- Codebase Index ---
	items.push({ label: "Codebase Index", kind: vscode.QuickPickItemKind.Separator });

	if (buildState?.running) {
		items.push({
			label: "$(loading~spin) Indexing in progress…",
			alwaysShow: true,
		});
	} else if (!codebaseStatus) {
		items.push({ label: "$(database) Loading…", alwaysShow: true });
	} else if (!codebaseStatus.configured) {
		items.push({
			label: "$(circle-slash) Not configured",
			description: "Set Qdrant & Ollama URLs in settings",
			alwaysShow: true,
		});
	} else if (codebaseStatus.stale) {
		items.push({
			label: "$(warning) Stale",
			description: `${codebaseStatus.pendingChanges ?? 0} pending change(s)`,
			alwaysShow: true,
		});
	} else if (codebaseStatus.indexed) {
		items.push({
			label: "$(check) Indexed",
			description: `Files: ${codebaseStatus.indexedFiles ?? "?"} · Chunks: ${codebaseStatus.indexedChunks ?? "?"}`,
			alwaysShow: true,
		});
	} else {
		items.push({ label: "$(circle-slash) No index", alwaysShow: true });
	}

	if (codebaseStatus?.lastUpdated) {
		items.push({
			label: "Last updated",
			description: codebaseStatus.lastUpdated,
			alwaysShow: true,
		});
	}

	// Actions
	const autoUpdate = vscode.workspace.getConfiguration("oaicopilot.codebaseIndex").get<boolean>("autoUpdate", true);
	items.push({
		label: `$(shield) Watchdog: ${autoUpdate ? "on" : "off"}`,
		description: "Toggle auto-update on file changes",
		alwaysShow: true,
	});

	if (!buildState?.running) {
		if (codebaseStatus && !codebaseStatus.indexed) {
			items.push({
				label: "$(add) Build Index",
				description: "Full rebuild of the codebase index",
			alwaysShow: true,
			});
		}
		if (codebaseStatus?.stale) {
			items.push({
				label: "$(sync) Update Index",
				description: "Incremental update for changed files",
			alwaysShow: true,
			});
		}
		if (codebaseStatus?.configured) {
			items.push({
				label: "$(search) Search Codebase",
				description: "Semantic search in the index",
			alwaysShow: true,
			});
		}
	}

	// --- Configuration ---
	items.push({ label: "Configuration", kind: vscode.QuickPickItemKind.Separator });
	items.push({
		label: "$(gear) Open Configuration",
		alwaysShow: true,
	});

	const pick = vscode.window.createQuickPick();
	pick.items = items;
	pick.title = "OAICopilot Status";
	pick.canSelectMany = false;
	pick.matchOnDescription = false;
	pick.matchOnDetail = false;
	pick.placeholder = "Select an action or press Escape to close";

	pick.onDidAccept(async () => {
		const item = pick.selectedItems[0];
		if (!item) return;
		const label = item.label;

		if (label.includes("Watchdog:")) {
			const config = vscode.workspace.getConfiguration("oaicopilot.codebaseIndex");
			const current = config.get<boolean>("autoUpdate", true);
			await config.update("autoUpdate", !current, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Codebase watchdog ${!current ? "enabled" : "disabled"}.`);
		} else if (label.includes("Build Index")) {
			await vscode.commands.executeCommand("oaicopilot.codebaseIndex");
		} else if (label.includes("Update Index")) {
			await vscode.commands.executeCommand("oaicopilot.codebaseUpdate");
		} else if (label.includes("Search Codebase")) {
			await vscode.commands.executeCommand("oaicopilot.codebaseSearch");
		} else if (label.includes("Open Configuration")) {
			await vscode.commands.executeCommand("oaicopilot.openConfig");
		}
	});

	pick.onDidHide(() => pick.dispose());
	pick.show();
}

/**
 * Format number to thousands (K, M, B) format
 * @param value The number to format
 * @returns Formatted string (e.g., "2.3K", "168.0K")
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage
 * @param usedTokens Tokens used
 * @param maxTokens Maximum tokens available
 * @returns Progress bar string (e.g., "▂▂▂▂▂▂▂▂ 75.2%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const empty = "▁";
	const full = "█";
	const totalBlocks = 8;
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const filledBlocks = Math.round((usagePercentage / 100) * totalBlocks);

	const bar = full.repeat(filledBlocks) + empty.repeat(totalBlocks - filledBlocks);
	return `${bar} ${usagePercentage.toFixed(1)}%`;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<void> {
	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) => countMessageTokens(message, modelConfig));

	const tokenCounts = await Promise.all(tokenCountPromises);
	const messagesTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Calculate tool definition tokens
	let toolTokens = 0;
	if (tools && tools.length > 0) {
		toolTokens = await countToolTokens(tools);
	}

	// Total tokens: messages + tool definitions + reserved output
	const totalTokenCount = messagesTokens + toolTokens;
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	// Create visual progress bar
	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	tokenText = `$(symbol-parameter) ${progressBar}`;
	tokenTooltip = `Token usage: ${formatTokenCount(totalTokenCount)} / ${formatTokenCount(maxTokens)}\n
${progressBar}\n
  Messages: ${formatTokenCount(messagesTokens)}
  Tools: ${formatTokenCount(toolTokens)}`;
	tokenInfo = {
		total: totalTokenCount,
		max: maxTokens,
		messages: messagesTokens,
		tools: toolTokens,
		progressBar,
	};

	// Add color coding based on token usage
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	if (usagePercentage >= 90) {
		tokenBackground = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		tokenBackground = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		tokenBackground = undefined;
	}

	render();

	statusBarItem.show();
}
