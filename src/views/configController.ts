import * as vscode from "vscode";
import type { HFApiMode, HFModelItem } from "../types";
import { normalizeUserModels, parseModelId } from "../utils";
import { fetchModels } from "../provideModel";
import { testConnection } from "../provider";
import { VersionManager } from "../versionManager";

export interface InitPayload {
	baseUrl: string;
	apiKey: string;
	delay: number;
	readFileLines: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	commitModel: string;
	commitLanguage: string;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
	codebaseIndex: CodebaseIndexConfig;
}

export interface CodebaseIndexConfig {
	qdrantUrl: string;
	ollamaUrl: string;
	embeddingModel: string;
	embeddingDimensions: number;
	collection: string;
	include: string;
	exclude: string;
	chunkLines: number;
	chunkOverlap: number;
	maxFileBytes: number;
	searchLimit: number;
}

export interface ExportConfig {
	version: string;
	exportDate: string;
	baseUrl: string;
	apiKey: string;
	delay: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	commitLanguage: string;
	commitModel: string;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
	readFileLines: number;
}

export type IncomingMessage =
	| { type: "requestInit" }
	| {
			type: "saveGlobalConfig";
			baseUrl: string;
			apiKey: string;
			delay: number;
			readFileLines: number;
			retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] };
			commitModel: string;
			commitLanguage: string;
	  }
	| {
			type: "fetchModels";
			baseUrl: string;
			apiKey: string;
			apiMode?: HFApiMode | string;
			headers?: Record<string, string>;
	  }
	| {
			type: "addProvider";
			provider: string;
			baseUrl?: string;
			apiKey?: string;
			apiMode?: string;
			headers?: Record<string, string>;
	  }
	| {
			type: "updateProvider";
			provider: string;
			baseUrl?: string;
			apiKey?: string;
			apiMode?: string;
			headers?: Record<string, string>;
	  }
	| { type: "deleteProvider"; provider: string }
	| { type: "addModel"; model: HFModelItem }
	| { type: "updateModel"; model: HFModelItem; originalModelId?: string; originalConfigId?: string }
	| { type: "deleteModel"; modelId: string }
	| { type: "requestConfirm"; id: string; message: string; action: string }
	| { type: "exportConfig" }
	| { type: "importConfig" }
	| { type: "saveCodebaseIndexConfig"; config: CodebaseIndexConfig }
	| { type: "fetchEmbeddingModels"; ollamaUrl: string }
	| { type: "fetchCollections"; qdrantUrl: string }
	| { type: "testQdrant"; qdrantUrl: string; collection: string }
	| { type: "testEmbedding"; ollamaUrl: string; model: string; dimensions: number }
	| {
			type: "testConnection";
			baseUrl: string;
			apiKey: string;
			apiMode?: HFApiMode | string;
			modelId?: string;
			headers?: Record<string, string>;
	  };

export type OutgoingMessage =
	| { type: "init"; payload: InitPayload }
	| { type: "modelsFetched"; models: HFModelItem[] }
	| { type: "confirmResponse"; id: string; confirmed: boolean }
	| { type: "embeddingModelsFetched"; models: string[] }
	| { type: "embeddingModelsFetchError"; error: string }
	| { type: "collectionsFetched"; collections: string[] }
	| { type: "collectionsFetchError"; error: string }
	| { type: "qdrantTestResult"; ok: boolean; message: string }
	| { type: "embeddingTestResult"; ok: boolean; message: string }
	| { type: "connectionTestResult"; ok: boolean; message: string; models?: string[] };

/**
 * Shared business logic for the OAICopilot configuration UI.
 *
 * Both the editor WebviewPanel (ConfigViewPanel) and the sidebar
 * WebviewView (ConfigSidebarView) drive their front-end through this
 * controller. The controller is webview-agnostic: every method that
 * needs to talk to the front-end receives the target `vscode.Webview`
 * explicitly, so the same instance can serve multiple views.
 */
export class ConfigController {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly secrets: vscode.SecretStorage
	) {}

	async handleMessage(webview: vscode.Webview, message: IncomingMessage) {
		switch (message.type) {
			case "requestInit":
				await this.sendInit(webview);
				break;
			case "saveGlobalConfig":
				await this.saveGlobalConfig(
					webview,
					message.baseUrl,
					message.apiKey,
					message.delay,
					message.readFileLines,
					message.retry,
					message.commitModel,
					message.commitLanguage
				);
				break;
			case "fetchModels": {
				try {
					const { models } = await fetchModels(message.baseUrl, message.apiKey, message.apiMode, message.headers);
					webview.postMessage({ type: "modelsFetched", models });
				} catch (err) {
					console.error("[oaicopilot] fetchModels failed", err);
					const errorMessage = err instanceof Error ? err.message : String(err);
					webview.postMessage({ type: "modelsFetchError", error: errorMessage });
				}
				break;
			}
			case "addProvider":
				await this.addProvider(webview, message.provider, message.baseUrl, message.apiKey, message.apiMode, message.headers);
				break;
			case "updateProvider":
				await this.updateProvider(webview, message.provider, message.baseUrl, message.apiKey, message.apiMode, message.headers);
				break;
			case "deleteProvider":
				await this.deleteProvider(webview, message.provider);
				break;
			case "addModel":
				await this.addModel(webview, message.model);
				break;
			case "updateModel":
				await this.updateModel(webview, message.model, message.originalModelId, message.originalConfigId);
				break;
			case "requestConfirm":
				await this.handleConfirmRequest(webview, message.id, message.message, message.action);
				break;
			case "deleteModel":
				await this.deleteModel(webview, message.modelId);
				break;
			case "exportConfig":
				await this.exportConfig();
				break;
			case "importConfig":
				await this.importConfig(webview);
				break;
			case "saveCodebaseIndexConfig":
				await this.saveCodebaseIndexConfig(webview, message.config);
				break;
			case "fetchEmbeddingModels": {
				try {
					const models = await this.fetchEmbeddingModels(message.ollamaUrl);
					webview.postMessage({ type: "embeddingModelsFetched", models });
				} catch (err) {
					console.error("[oaicopilot] fetchEmbeddingModels failed", err);
					const errorMessage = err instanceof Error ? err.message : String(err);
					webview.postMessage({ type: "embeddingModelsFetchError", error: errorMessage });
				}
				break;
			}
			case "fetchCollections": {
				try {
					const collections = await this.fetchCollections(message.qdrantUrl);
					webview.postMessage({ type: "collectionsFetched", collections });
				} catch (err) {
					console.error("[oaicopilot] fetchCollections failed", err);
					const errorMessage = err instanceof Error ? err.message : String(err);
					webview.postMessage({ type: "collectionsFetchError", error: errorMessage });
				}
				break;
			}
			case "testQdrant": {
				const result = await this.testQdrant(message.qdrantUrl, message.collection);
				webview.postMessage({ type: "qdrantTestResult", ok: result.ok, message: result.message });
				break;
			}
			case "testEmbedding": {
				const result = await this.testEmbedding(message.ollamaUrl, message.model, message.dimensions);
				webview.postMessage({ type: "embeddingTestResult", ok: result.ok, message: result.message });
				break;
			}
			case "testConnection": {
				const configuredTimeout = vscode.workspace.getConfiguration().get<number>("oaicopilot.connectTimeout");
				const connectTimeoutMs =
					typeof configuredTimeout === "number" && configuredTimeout > 0 ? configuredTimeout : 30000;
				const result = await testConnection(
					{
						baseUrl: message.baseUrl,
						apiKey: message.apiKey,
						apiMode: message.apiMode,
						modelId: message.modelId,
						headers: message.headers,
					},
					connectTimeoutMs
				);
				webview.postMessage({
					type: "connectionTestResult",
					ok: result.ok,
					message: result.message,
					models: result.models,
				});
				break;
			}
			default:
				break;
		}
	}

	private async handleConfirmRequest(webview: vscode.Webview, id: string, message: string, action: string) {
		let confirmed: boolean | string | undefined;

		if (action === "showInfo") {
			// For informational messages, just show the message without confirmation
			await vscode.window.showInformationMessage(message);
			confirmed = true;
		} else {
			// For confirmation requests, show Yes/No dialog
			confirmed = await vscode.window.showInformationMessage(message, { modal: true }, "Yes", "No");
		}

		// Send response back to webview
		webview.postMessage({
			type: "confirmResponse",
			id: id,
			confirmed: action === "showInfo" ? true : confirmed === "Yes",
		} as OutgoingMessage);
	}

	async sendInit(webview: vscode.Webview) {
		const config = vscode.workspace.getConfiguration();
		const baseUrl = config.get<string>("oaicopilot.baseUrl", "https://api.openai.com/v1");
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		const apiKey = (await this.secrets.get("oaicopilot.apiKey")) ?? "";
		const providerKeys: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const normalized = provider.toLowerCase();
			let key = await this.secrets.get(`oaicopilot.apiKey.${normalized}`);
			if (!key && normalized !== provider) {
				// Backward compat: previous versions stored provider keys with original casing.
				const legacy = await this.secrets.get(`oaicopilot.apiKey.${provider}`);
				if (legacy) {
					key = legacy;
					await this.secrets.store(`oaicopilot.apiKey.${normalized}`, legacy);
					await this.secrets.delete(`oaicopilot.apiKey.${provider}`);
				}
			}
			if (key) {
				providerKeys[provider] = key;
			}
		}

		const delay = config.get<number>("oaicopilot.delay", 0);
		const retry = config.get<{
			enabled?: boolean;
			max_attempts?: number;
			interval_ms?: number;
			status_codes?: number[];
		}>("oaicopilot.retry", {
			enabled: true,
			max_attempts: 3,
			interval_ms: 1000,
		});

		const foundModel = models.find((model) => model.useForCommitGeneration === true);
		const commitModel = foundModel ? `${foundModel.id}${foundModel.configId ? "::" + foundModel.configId : ""}` : "";
		const commitLanguage = config.get<string>("oaicopilot.commitLanguage", "English");
		const readFileLines = config.get<number>("oaicopilot.readFileLines", 0);
		const codebaseIndex = this.getCodebaseIndexConfig();
		const payload: InitPayload = {
			baseUrl,
			apiKey,
			delay,
			readFileLines,
			retry,
			commitModel,
			commitLanguage,
			models,
			providerKeys,
			codebaseIndex,
		};
		webview.postMessage({ type: "init", payload });
	}

	private async saveGlobalConfig(
		webview: vscode.Webview,
		rawBaseUrl: string,
		rawApiKey: string,
		delay: number,
		readFileLines: number,
		retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] },
		commitModel: string,
		commitLanguage: string
	) {
		const baseUrl = rawBaseUrl.trim();
		const apiKey = rawApiKey.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("oaicopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.delay", delay, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.readFileLines", readFileLines, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.retry", retry, vscode.ConfigurationTarget.Global);
		await config.update("oaicopilot.commitLanguage", commitLanguage, vscode.ConfigurationTarget.Global);
		if (apiKey) {
			await this.secrets.store("oaicopilot.apiKey", apiKey);
		} else {
			await this.secrets.delete("oaicopilot.apiKey");
		}

		// Update models to set useForCommitGeneration based on selected commitModel
		if (commitModel) {
			const models = config.get<HFModelItem[]>("oaicopilot.models", []);
			const updatedModels = models.map((model) => {
				const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
				if (fullModelId === commitModel) {
					return { ...model, useForCommitGeneration: true };
				}
				const rest: HFModelItem = { ...model };
				delete rest.useForCommitGeneration;
				return rest;
			});
			await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		}

		vscode.window.showInformationMessage(
			"OAI Compatible base URL, Delay, Retry and API Key have been saved to global settings."
		);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	getCodebaseIndexConfig(): CodebaseIndexConfig {
		const config = vscode.workspace.getConfiguration("oaicopilot.codebaseIndex");
		return {
			qdrantUrl: config.get<string>("qdrantUrl", ""),
			ollamaUrl: config.get<string>("ollamaUrl", ""),
			embeddingModel: config.get<string>("embeddingModel", "nomic-embed-text"),
			embeddingDimensions: config.get<number>("embeddingDimensions", 768),
			collection: config.get<string>("collection", "oaicopilot_codebase"),
			include: config.get<string>("include", ""),
			exclude: config.get<string>("exclude", ""),
			chunkLines: config.get<number>("chunkLines", 120),
			chunkOverlap: config.get<number>("chunkOverlap", 20),
			maxFileBytes: config.get<number>("maxFileBytes", 1_000_000),
			searchLimit: config.get<number>("searchLimit", 8),
		};
	}

	private async fetchEmbeddingModels(ollamaUrl: string): Promise<string[]> {
		const base = ollamaUrl.replace(/\/+$/, "");
		const res = await fetch(`${base}/api/tags`);
		if (!res.ok) {
			throw new Error(`Ollama /api/tags returned ${res.status}`);
		}
		const data = (await res.json()) as { models?: Array<{ name: string }> };
		return (data.models ?? []).map((m) => m.name);
	}

	private async fetchCollections(qdrantUrl: string): Promise<string[]> {
		const base = qdrantUrl.replace(/\/+$/, "");
		const res = await fetch(`${base}/collections`);
		if (!res.ok) {
			throw new Error(`Qdrant /collections returned ${res.status}`);
		}
		const data = (await res.json()) as { result?: { collections?: Array<{ name: string }> } };
		return (data.result?.collections ?? []).map((c) => c.name);
	}

	/**
	 * Tests the Qdrant connection: verifies the server is reachable and reports
	 * whether the configured collection exists (and its vector size).
	 */
	private async testQdrant(qdrantUrl: string, collection: string): Promise<{ ok: boolean; message: string }> {
		const url = qdrantUrl.trim();
		if (!url) {
			return { ok: false, message: "No Qdrant URL configured." };
		}
		const base = url.replace(/\/+$/, "");
		try {
			const res = await fetch(`${base}/collections`);
			if (!res.ok) {
				return { ok: false, message: `Qdrant reachable but /collections returned HTTP ${res.status}.` };
			}
			const data = (await res.json()) as { result?: { collections?: Array<{ name: string }> } };
			const collections = (data.result?.collections ?? []).map((c) => c.name);
			if (!collection.trim()) {
				return { ok: true, message: `Qdrant reachable. ${collections.length} collection(s) found.` };
			}
			if (!collections.includes(collection)) {
				return {
					ok: true,
					message: `Qdrant reachable, but collection "${collection}" does not exist yet. It will be created on first index build.`,
				};
			}
			// Collection exists — check its vector size.
			const colRes = await fetch(`${base}/collections/${encodeURIComponent(collection)}`);
			if (!colRes.ok) {
				return { ok: true, message: `Qdrant reachable. Collection "${collection}" exists.` };
			}
			const colData = (await colRes.json()) as {
				result?: { config?: { params?: { vectors?: { size?: number } | Record<string, { size?: number }> } } };
			};
			const vectors = colData.result?.config?.params?.vectors;
			let size: number | undefined;
			if (vectors && typeof vectors === "object" && "size" in vectors) {
				size = (vectors as { size?: number }).size;
			} else if (vectors && typeof vectors === "object") {
				const first = Object.values(vectors)[0] as { size?: number } | undefined;
				size = first?.size;
			}
			if (size !== undefined) {
				return { ok: true, message: `Qdrant reachable. Collection "${collection}" exists with vector size ${size}.` };
			}
			return { ok: true, message: `Qdrant reachable. Collection "${collection}" exists.` };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			return { ok: false, message: `Could not reach Qdrant at ${base}: ${errorMessage}` };
		}
	}

	/**
	 * Tests the Ollama embedding endpoint: verifies the server is reachable, the
	 * model is available, and that it produces embeddings of the expected size.
	 */
	private async testEmbedding(ollamaUrl: string, model: string, dimensions: number): Promise<{ ok: boolean; message: string }> {
		const url = ollamaUrl.trim();
		if (!url) {
			return { ok: false, message: "No Ollama URL configured." };
		}
		const base = url.replace(/\/+$/, "");
		const modelName = model.trim();
		if (!modelName) {
			return { ok: false, message: "No embedding model configured." };
		}
		try {
			// Verify the model is available.
			const tagsRes = await fetch(`${base}/api/tags`);
			if (!tagsRes.ok) {
				return { ok: false, message: `Ollama reachable but /api/tags returned HTTP ${tagsRes.status}.` };
			}
			const tagsData = (await tagsRes.json()) as { models?: Array<{ name: string }> };
			const available = (tagsData.models ?? []).map((m) => m.name);
			if (!available.includes(modelName)) {
				return {
					ok: false,
					message: `Ollama reachable, but model "${modelName}" is not available. Available: ${available.join(", ") || "(none)"}.`,
				};
			}
			// Generate a real embedding and verify its dimensionality.
			const embedRes = await fetch(`${base}/api/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: modelName, input: "connection test" }),
			});
			if (!embedRes.ok) {
				return { ok: false, message: `Ollama /api/embed returned HTTP ${embedRes.status}.` };
			}
			const embedData = (await embedRes.json()) as { embeddings?: number[][] };
			const vector = embedData.embeddings?.[0];
			if (!vector || !Array.isArray(vector)) {
				return { ok: false, message: "Ollama /api/embed returned no embedding vector." };
			}
			if (dimensions > 0 && vector.length !== dimensions) {
				return {
					ok: false,
					message: `Dimension mismatch: model "${modelName}" produces ${vector.length}-dimensional vectors, but the configured dimension is ${dimensions}. Update "Embedding Dimensions" to ${vector.length}.`,
				};
			}
			return { ok: true, message: `Ollama reachable. Model "${modelName}" works and produces ${vector.length}-dimensional embeddings.` };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			return { ok: false, message: `Could not reach Ollama at ${base}: ${errorMessage}` };
		}
	}

	private async saveCodebaseIndexConfig(webview: vscode.Webview, cfg: CodebaseIndexConfig) {
		const config = vscode.workspace.getConfiguration("oaicopilot.codebaseIndex");
		await config.update("qdrantUrl", cfg.qdrantUrl.trim(), vscode.ConfigurationTarget.Global);
		await config.update("ollamaUrl", cfg.ollamaUrl.trim(), vscode.ConfigurationTarget.Global);
		await config.update("embeddingModel", cfg.embeddingModel.trim(), vscode.ConfigurationTarget.Global);
		await config.update("embeddingDimensions", cfg.embeddingDimensions, vscode.ConfigurationTarget.Global);
		await config.update("collection", cfg.collection.trim(), vscode.ConfigurationTarget.Global);
		await config.update("include", cfg.include, vscode.ConfigurationTarget.Global);
		await config.update("exclude", cfg.exclude, vscode.ConfigurationTarget.Global);
		await config.update("chunkLines", cfg.chunkLines, vscode.ConfigurationTarget.Global);
		await config.update("chunkOverlap", cfg.chunkOverlap, vscode.ConfigurationTarget.Global);
		await config.update("maxFileBytes", cfg.maxFileBytes, vscode.ConfigurationTarget.Global);
		await config.update("searchLimit", cfg.searchLimit, vscode.ConfigurationTarget.Global);

		vscode.window.showInformationMessage("Codebase index settings have been saved to global settings.");
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async addProvider(
		webview: vscode.Webview,
		provider: string,
		baseUrl?: string,
		apiKey?: string,
		apiMode?: string,
		headers?: Record<string, string>
	) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Save API key for the provider
		if (apiKey) {
			await this.secrets.store(`oaicopilot.apiKey.${normalizedProvider}`, apiKey);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
			}
		}

		// Save provider configuration to the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		// If the provider doesn't have models yet, add a default model
		const hasProviderModels = models.some((model) => model.owned_by === trimmedProvider);
		if (!hasProviderModels) {
			const defaultModel: HFModelItem = {
				id: `__provider__${trimmedProvider}`,
				owned_by: trimmedProvider,
				baseUrl: baseUrl,
				apiMode: (apiMode as HFApiMode) || "openai",
				headers: headers,
			};
			models.push(defaultModel);
		}

		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been added.`);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async updateProvider(
		webview: vscode.Webview,
		provider: string,
		baseUrl?: string,
		apiKey?: string,
		apiMode?: string,
		headers?: Record<string, string>
	) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Update provider API key
		if (apiKey) {
			await this.secrets.store(`oaicopilot.apiKey.${normalizedProvider}`, apiKey);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
			}
		} else {
			await this.secrets.delete(`oaicopilot.apiKey.${normalizedProvider}`);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
			}
		}

		// Update the provider's configuration in the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

		const updatedModels = models.map((model) => {
			if (model.owned_by === trimmedProvider) {
				const rest: HFModelItem = { ...model };
				delete rest.headers;
				return {
					...rest,
					baseUrl: baseUrl || model.baseUrl,
					apiMode: (apiMode as HFApiMode) || model.apiMode,
					...(headers !== undefined && { headers }),
				};
			}
			return model;
		});

		await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been updated.`);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async deleteProvider(webview: vscode.Webview, provider: string) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Delete provider API key
		await this.secrets.delete(`oaicopilot.apiKey.${normalizedProvider}`);
		if (trimmedProvider !== normalizedProvider) {
			await this.secrets.delete(`oaicopilot.apiKey.${trimmedProvider}`);
		}

		// Remove all models of this provider from the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));
		const filteredModels = models.filter((model) => model.owned_by !== trimmedProvider);

		await config.update("oaicopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} and all its models have been deleted.`);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async addModel(webview: vscode.Webview, model: HFModelItem) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		// Check if model with same id and configId already exists
		const existingIndex = models.findIndex(
			(m) =>
				m.id === model.id && ((model.configId && m.configId === model.configId) || (!model.configId && !m.configId))
		);
		if (existingIndex !== -1) {
			vscode.window.showErrorMessage(`Model ${model.id}${model.configId ? "::" + model.configId : ""} already exists.`);
			return;
		}

		models.push(model);
		await config.update("oaicopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Model ${model.id}${model.configId ? "::" + model.configId : ""} has been added.`
		);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async updateModel(webview: vscode.Webview, model: HFModelItem, originalModelId?: string, originalConfigId?: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);

		// Find the model to update based on original id and configId
		const updatedModels = models.map((m) => {
			// Check if this is the model we want to update
			// If originalConfigId is undefined (meaning it was originally null/undefined),
			// then look for a model with no configId
			const isTargetModel =
				m.id === originalModelId &&
				((originalConfigId && m.configId === originalConfigId) || (!originalConfigId && !m.configId));

			if (isTargetModel) {
				// Update with new values
				return model;
			}
			return m;
		});

		await config.update("oaicopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Model ${model.id}${model.configId ? "::" + model.configId : ""} has been updated.`
		);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async deleteModel(webview: vscode.Webview, modelId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("oaicopilot.models", []);
		const parsedModelId = parseModelId(modelId);

		const filteredModels = models.filter((model) => {
			return !(
				model.id === parsedModelId.baseId &&
				((parsedModelId.configId && model.configId === parsedModelId.configId) ||
					(!parsedModelId.configId && !model.configId))
			);
		});

		await config.update("oaicopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model ${modelId} has been deleted.`);
		// Send refresh signal to frontend
		await this.sendInit(webview);
	}

	private async exportConfig() {
		try {
			const config = vscode.workspace.getConfiguration();
			const baseUrl = config.get<string>("oaicopilot.baseUrl", "https://api.openai.com/v1");
			const apiKey = (await this.secrets.get("oaicopilot.apiKey")) ?? "";
			const delay = config.get<number>("oaicopilot.delay", 0);
			const retry = config.get<{
				enabled?: boolean;
				max_attempts?: number;
				interval_ms?: number;
				status_codes?: number[];
			}>("oaicopilot.retry", {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
			});
			const commitLanguage = config.get<string>("oaicopilot.commitLanguage", "English");
			const readFileLines = config.get<number>("oaicopilot.readFileLines", 0);
			const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

			const foundModel = models.find((model) => model.useForCommitGeneration === true);
			const commitModel = foundModel ? `${foundModel.id}${foundModel.configId ? "::" + foundModel.configId : ""}` : "";

			const providerKeys: Record<string, string> = {};
			const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
			for (const provider of providers) {
				const normalized = provider.toLowerCase();
				const key = await this.secrets.get(`oaicopilot.apiKey.${normalized}`);
				if (key) {
					providerKeys[provider] = key;
				}
			}

			const exportData: ExportConfig = {
				version: VersionManager.getVersion(),
				exportDate: new Date().toISOString(),
				baseUrl,
				apiKey,
				delay,
				retry,
				commitLanguage,
				commitModel,
				models,
				readFileLines,
				providerKeys,
			};

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(`oaicopilot-config-${new Date().toISOString().split("T")[0]}.json`),
				filters: { "JSON Files": ["json"] },
				title: "Export OAICopilot Configuration",
			});

			if (!uri) {
				vscode.window.showInformationMessage("Export configuration cancelled.");
				return;
			}

			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(uri, encoder.encode(JSON.stringify(exportData, null, 2)));

			vscode.window.showInformationMessage(`Configuration exported to ${uri.fsPath}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			vscode.window.showErrorMessage(`Failed to export configuration: ${errorMessage}`);
		}
	}

	private async importConfig(webview: vscode.Webview) {
		try {
			const uri = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: { "JSON Files": ["json"] },
				title: "Import OAICopilot Configuration",
			});

			if (!uri || uri.length === 0) {
				vscode.window.showInformationMessage("Import configuration cancelled.");
				return;
			}

			const content = await vscode.workspace.fs.readFile(uri[0]);
			const decoder = new TextDecoder();
			const jsonContent = decoder.decode(content);
			const importData = JSON.parse(jsonContent) as ExportConfig;

			if (!Array.isArray(importData.models)) {
				throw new Error("Invalid configuration file: models must be an array");
			}

			const config = vscode.workspace.getConfiguration();

			await config.update("oaicopilot.baseUrl", importData.baseUrl, vscode.ConfigurationTarget.Global);
			await config.update("oaicopilot.delay", importData.delay, vscode.ConfigurationTarget.Global);
			await config.update("oaicopilot.retry", importData.retry, vscode.ConfigurationTarget.Global);
			await config.update("oaicopilot.readFileLines", importData.readFileLines, vscode.ConfigurationTarget.Global);
			await config.update("oaicopilot.commitLanguage", importData.commitLanguage, vscode.ConfigurationTarget.Global);

			if (importData.apiKey) {
				await this.secrets.store("oaicopilot.apiKey", importData.apiKey);
			} else {
				await this.secrets.delete("oaicopilot.apiKey");
			}

			await config.update("oaicopilot.models", importData.models, vscode.ConfigurationTarget.Global);

			for (const [provider, key] of Object.entries(importData.providerKeys)) {
				const normalized = provider.toLowerCase();
				if (key) {
					await this.secrets.store(`oaicopilot.apiKey.${normalized}`, key);
				} else {
					await this.secrets.delete(`oaicopilot.apiKey.${normalized}`);
				}
			}

			vscode.window.showInformationMessage("Configuration imported successfully.");
			await this.sendInit(webview);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			vscode.window.showErrorMessage(`Failed to import configuration: ${errorMessage}`);
		}
	}
}
