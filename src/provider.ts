import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem, HFApiMode } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { parseModelId, createRetryConfig, executeWithRetry, normalizeUserModels } from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { countMessageTokens } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi } from "./commonApi";
import { logger } from "./logger";

/** Default connect timeout (ms) before a request is aborted if no response headers arrive. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;

/**
 * Combine multiple abort signals into one. Uses `AbortSignal.any` when available
 * (Node 20.3+), otherwise falls back to a manual combination so the code keeps
 * working on older extension-host runtimes.
 */
function combineSignals(signals: AbortSignal[]): AbortSignal {
	const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") {
		return anyFn.call(AbortSignal, signals);
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	for (const s of signals) {
		if (s.aborted) {
			controller.abort();
			break;
		}
		s.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

/**
 * Perform a fetch bound to the caller's abort signal AND a connect timeout.
 * The connect timeout only guards the connection phase (until response headers
 * arrive); it is cleared as soon as the fetch resolves so long-running streamed
 * bodies are not aborted. A connect timeout is surfaced as a retryable "timeout"
 * error; a user cancellation is rethrown as-is (not retryable).
 */
async function fetchWithConnectTimeout(
	url: string,
	init: RequestInit,
	abortController: AbortController,
	connectTimeoutMs: number
): Promise<Response> {
	const timeoutController = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, connectTimeoutMs);
	const signal = combineSignals([abortController.signal, timeoutController.signal]);
	try {
		const res = await fetch(url, { ...init, signal });
		clearTimeout(timer);
		return res;
	} catch (e) {
		clearTimeout(timer);
		if (timedOut && !abortController.signal.aborted) {
			throw new Error(`Request timed out after ${connectTimeoutMs}ms (no response headers received)`);
		}
		throw e;
	}
}

/** Parameters for a lightweight connection/health check. */
export interface ConnectionTestParams {
	baseUrl: string;
	apiKey: string;
	apiMode?: HFApiMode | string;
	modelId?: string;
	headers?: Record<string, string>;
}

/** Result of a connection/health check. */
export interface ConnectionTestResult {
	ok: boolean;
	message: string;
	models?: string[];
}

/**
 * Perform a lightweight connection/health check against a model endpoint.
 * The base URL always comes from user configuration; only the mode-specific
 * path suffix is fixed (matching the request paths already used per API mode).
 * Returns a friendly result instead of throwing, so the UI can display it.
 */
export async function testConnection(params: ConnectionTestParams, connectTimeoutMs: number): Promise<ConnectionTestResult> {
	const baseUrl = (params.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl || !baseUrl.startsWith("http")) {
		return { ok: false, message: "No valid base URL configured." };
	}

	const mode = params.apiMode || "openai";
	let url: string;
	switch (mode) {
		case "ollama":
			url = `${baseUrl}/api/tags`;
			break;
		case "anthropic":
			url = `${baseUrl}/v1/models`;
			break;
		case "gemini":
			url = `${baseUrl}/v1beta/models`;
			break;
		case "openai":
		case "openai-responses":
		default:
			url = `${baseUrl}/models`;
			break;
	}

	const headers: Record<string, string> = { ...(params.headers || {}) };
	if (params.apiKey) {
		if (mode === "anthropic") {
			headers["x-api-key"] = params.apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (mode === "gemini") {
			headers["x-goog-api-key"] = params.apiKey;
		} else {
			headers["Authorization"] = `Bearer ${params.apiKey}`;
		}
	}

	const controller = new AbortController();
	try {
		const res = await fetchWithConnectTimeout(url, { method: "GET", headers }, controller, connectTimeoutMs);
		if (!res.ok) {
			let detail = "";
			try {
				const text = await res.text();
				if (text) {
					detail = `: ${text.slice(0, 200)}`;
				}
			} catch {
				// Ignore body read errors; the status line is enough.
			}
			return { ok: false, message: `HTTP ${res.status} ${res.statusText}${detail}` };
		}

		let models: string[] = [];
		try {
			const data = await res.json();
			if (mode === "ollama") {
				models = (data.models || []).map((m: { name?: string; id?: string }) => m.name || m.id || "");
			} else if (mode === "gemini") {
				models = (data.models || []).map((m: { name?: string }) => m.name || "");
			} else {
				models = (data.data || []).map((m: { id?: string }) => m.id || "");
			}
			models = models.filter((m: string) => !!m);
		} catch {
			// Non-JSON body; treat as connected if the status was OK.
		}

		if (params.modelId && models.length > 0) {
			const modelId = params.modelId;
			const found = models.some((m) => m === modelId || m.startsWith(modelId));
			if (!found) {
				return {
					ok: true,
					message: `Connected, but model "${params.modelId}" was not found in the server's model list.`,
					models,
				};
			}
		}

		return {
			ok: true,
			message: `Connected successfully${models.length ? ` (${models.length} model${models.length === 1 ? "" : "s"} available)` : ""}.`,
			models,
		};
	} catch (e) {
		return { ok: false, message: `Connection failed: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();
	private readonly _openaiResponsesPreviousResponseIdUnsupportedBaseUrls = new Set<string>();

	static readonly OPENAI_RESPONSES_STATEFUL_MARKER_MIME = "application/vnd.oaicopilot.stateful-marker";

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly statusBarItem: vscode.StatusBarItem
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token, this.secrets);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return countMessageTokens(text, { includeReasoningInRequest: true });
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[OAI Compatible Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		const requestStartTime = Date.now();
		const abortController = new AbortController();
		const cancellationDisposable = token.onCancellationRequested(() => abortController.abort());
		if (token.isCancellationRequested) {
			abortController.abort();
		}
		try {
			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

			// Parse model ID to handle config ID
			const parsedModelId = parseModelId(model.id);

			// Find matching user model configuration
			// Prioritize matching models with same base ID and config ID
			// If no config ID, match models with same base ID
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// If still no model found, try to find any model matching the base ID (most lenient match, for backward compatibility)
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			// Check if using Ollama native API mode
			const apiMode = um?.apiMode ?? "openai";
			const baseUrl = um?.baseUrl || config.get<string>("oaicopilot.baseUrl", "");

			logger.info("request.start", {
				modelId: model.id,
				messageCount: messages.length,
				apiMode,
				baseUrl,
			});

			// Prepare model configuration
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
			};

			// Update Token Usage
			updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig);

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("oaicopilot.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					logger.debug("request.delay", {
						delayMs,
						elapsed,
						remainingDelay,
					});
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key for the model's provider
			const provider = um?.owned_by;
			const useGenericKey = !um?.baseUrl;
			const modelApiKey = await this.ensureApiKey(useGenericKey, provider);
			if (!modelApiKey) {
				logger.warn("apiKey.missing", {
					provider: provider ?? "",
					useGenericKey,
				});
				throw new Error("OAI Compatible API key not found");
			}

			// send chat request
			const BASE_URL = baseUrl;
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			// get retry config
			const retryConfig = createRetryConfig();

			// Connect timeout: abort a request if no response headers arrive in time.
			const configuredTimeout = config.get<number>("oaicopilot.connectTimeout");
			const connectTimeoutMs =
				typeof configuredTimeout === "number" && configuredTimeout > 0
					? configuredTimeout
					: DEFAULT_CONNECT_TIMEOUT_MS;

			// prepare headers with custom headers if specified
			const requestHeaders = CommonApi.prepareHeaders(modelApiKey, apiMode, um?.headers);
			logger.debug("request.headers", {
				headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
			});
			logger.debug("request.messages.origin", {
				messages: messages,
			});
			if (apiMode === "ollama") {
				// Ollama native API mode
				const ollamaApi = new OllamaApi(model.id);
				const ollamaMessages = ollamaApi.convertMessages(messages, modelConfig);

				let ollamaRequestBody: OllamaRequestBody = {
					model: parsedModelId.baseId,
					messages: ollamaMessages,
					stream: true,
				};
				ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, um, options);

				// send Ollama chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/api/chat`;
				logger.debug("request.body", {
					url: url,
					requestBody: ollamaRequestBody,
				});
				const response = await executeWithRetry(async () => {
					const res = await fetchWithConnectTimeout(
						url,
						{
							method: "POST",
							headers: requestHeaders,
							body: JSON.stringify(ollamaRequestBody),
						},
						abortController,
						connectTimeoutMs
					);

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Ollama Provider] Ollama API error response", errorText);
						throw new Error(
							`Ollama API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Ollama API");
				}
				await ollamaApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "anthropic") {
				// Anthropic API mode
				const anthropicApi = new AnthropicApi(model.id, um?.cache_control !== false);
				const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: AnthropicRequestBody = {
					model: parsedModelId.baseId,
					messages: anthropicMessages,
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

				// send Anthropic chat request with retry
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				// Some providers require configuring the baseUrl with a version suffix (e.g. .../v1).
				// Avoid double-appending (e.g. .../v1/v1/messages).
				const url = normalizedBaseUrl.endsWith("/v1")
					? `${normalizedBaseUrl}/messages`
					: `${normalizedBaseUrl}/v1/messages`;
				logger.debug("request.body", { url, requestBody });
				const response = await executeWithRetry(async () => {
					const res = await fetchWithConnectTimeout(
						url,
						{
							method: "POST",
							headers: requestHeaders,
							body: JSON.stringify(requestBody),
						},
						abortController,
						connectTimeoutMs
					);

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Anthropic Provider] Anthropic API error response", errorText);
						throw new Error(
							`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "openai-responses") {
				// OpenAI Responses API mode
				const openaiResponsesApi = new OpenaiResponsesApi(model.id);
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				const statefulModelId = parsedModelId.baseId;

				// Convert full history once (also extracts system `instructions`).
				const fullInput = openaiResponsesApi.convertMessages(messages, modelConfig);

				const marker = findLastOpenAIResponsesStatefulMarker(statefulModelId, messages);
				let deltaInput: unknown[] | null = null;
				if (marker && marker.index >= 0 && marker.index < messages.length - 1) {
					const deltaMessages = messages.slice(marker.index + 1);
					const converted = openaiResponsesApi.convertMessages(deltaMessages, modelConfig);
					if (converted.length > 0) {
						deltaInput = converted;
					}
				}

				const canUsePreviousResponseId =
					!!marker?.marker &&
					!this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.has(normalizedBaseUrl) &&
					Array.isArray(deltaInput) &&
					deltaInput.length > 0;

				const input = canUsePreviousResponseId ? deltaInput! : fullInput;

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					input,
					stream: true,
				};

				requestBody = openaiResponsesApi.prepareRequestBody(requestBody, um, options);

				// Add prompt_cache_key to enable OpenAI prompt caching.
				// Without this parameter, cached_tokens is always 0 even with identical requests.
				if (!requestBody.prompt_cache_key) {
					requestBody.prompt_cache_key = `oaicopilot-${parsedModelId.baseId}`;
				}
				// send Responses API request with retry
				const url = `${normalizedBaseUrl}/responses`;
				logger.debug("request.body", { url, requestBody });

				// If the user explicitly set `previous_response_id` via `extra`, don't apply stateful slicing.
				let addedPreviousResponseId = false;
				if (requestBody.previous_response_id !== undefined) {
					requestBody.input = fullInput;
				} else if (canUsePreviousResponseId) {
					requestBody.previous_response_id = marker!.marker;
					addedPreviousResponseId = true;
				}

				const sendRequest = async (body: Record<string, unknown>) =>
					await executeWithRetry(async () => {
						const res = await fetchWithConnectTimeout(
							url,
							{
								method: "POST",
								headers: requestHeaders,
								body: JSON.stringify(body),
							},
							abortController,
							connectTimeoutMs
						);

						if (!res.ok) {
							const errorText = await res.text();
							const error = new Error(
								`Responses API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							);
							(error as { status?: number; errorText?: string }).status = res.status;
							(error as { status?: number; errorText?: string }).errorText = errorText;
							throw error;
						}

						return res;
					}, retryConfig);

				let response: Response;
				try {
					response = await sendRequest(requestBody);
				} catch (err) {
					// Some Responses-compatible gateways don't support `previous_response_id`.
					// Fall back to sending full history when the previous-response attempt fails.
					const status = (err as { status?: unknown })?.status;
					const shouldFallback =
						addedPreviousResponseId && typeof status === "number" && status >= 400 && status < 500 && status !== 429;
					if (!shouldFallback) {
						throw err;
					}

					this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.add(normalizedBaseUrl);

					let fallbackBody: Record<string, unknown> = {
						model: parsedModelId.baseId,
						input: fullInput,
						stream: true,
					};
					fallbackBody = openaiResponsesApi.prepareRequestBody(fallbackBody, um, options);
					delete fallbackBody.previous_response_id;
					response = await sendRequest(fallbackBody);
				}

				if (!response.body) {
					throw new Error("No response body from Responses API");
				}
				await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);

				// Append a stateful marker so future requests can reuse `previous_response_id` (Copilot Chat style).
				const responseId = openaiResponsesApi.responseId;
				if (responseId) {
					trackingProgress.report(createOpenAIResponsesStatefulMarkerPart(statefulModelId, responseId));
				}
			} else if (apiMode === "gemini") {
				// Gemini native API mode
				const geminiApi = new GeminiApi(model.id, this._geminiToolCallMetaByCallId);
				const geminiMessages = geminiApi.convertMessages(messages, modelConfig);

				const systemParts: string[] = [];
				const contents: GeminiGenerateContentRequest["contents"] = [];
				for (const msg of geminiMessages) {
					if (msg.role === "system") {
						const text = msg.parts
							.map((p) =>
								p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
									? String((p as { text: string }).text)
									: ""
							)
							.join("")
							.trim();
						if (text) {
							systemParts.push(text);
						}
						continue;
					}
					contents.push({ role: msg.role, parts: msg.parts });
				}

				let requestBody: GeminiGenerateContentRequest = {
					contents,
				};
				if (systemParts.length > 0) {
					requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
				}
				requestBody = geminiApi.prepareRequestBody(requestBody, um, options);

				const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
				logger.debug("request.body", { url, requestBody });
				if (!url) {
					throw new Error("Invalid Gemini base URL configuration.");
				}

				const response = await executeWithRetry(async () => {
					const res = await fetchWithConnectTimeout(
						url,
						{
							method: "POST",
							headers: requestHeaders,
							body: JSON.stringify(requestBody),
						},
						abortController,
						connectTimeoutMs
					);

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Gemini Provider] Gemini API error response", errorText);
						throw new Error(
							`Gemini API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Gemini API");
				}
				await geminiApi.processStreamingResponse(response.body, trackingProgress, token);
			} else {
				// OpenAI compatible API mode (default)
				const openaiApi = new OpenaiApi(model.id);
				const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					messages: openaiMessages,
					stream: true,
					stream_options: { include_usage: true },
				};
				requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

				// send chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
				logger.debug("request.body", { url, requestBody });
				const response = await executeWithRetry(async () => {
					const res = await fetchWithConnectTimeout(
						url,
						{
							method: "POST",
							headers: requestHeaders,
							body: JSON.stringify(requestBody),
						},
						abortController,
						connectTimeoutMs
					);

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[OAI Compatible Model Provider] OAI Compatible API error response", errorText);
						throw new Error(
							`OAI Compatible API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from OAI Compatible API");
				}
				await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
			}
		} catch (err) {
			if (token.isCancellationRequested) {
				logger.info("request.cancelled", { modelId: model.id });
				return;
			}
			console.error("[OAI Compatible Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			logger.error("request.error", {
				modelId: model.id,
				messageCount: messages.length,
				errorName: err instanceof Error ? err.name : String(err),
				errorMessage: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			const durationMs = Date.now() - requestStartTime;
			logger.info("request.end", { modelId: model.id, durationMs });
			// Update last request time after successful completion
			this._lastRequestTime = Date.now();
			cancellationDisposable.dispose();
		}
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param useGenericKey If true, use generic API key.
	 * @param provider Optional provider name to get provider-specific API key.
	 */
	private async ensureApiKey(useGenericKey: boolean, provider?: string): Promise<string | undefined> {
		// Try to get provider-specific API key first
		let apiKey: string | undefined;
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.trim().toLowerCase();
			const providerKey = `oaicopilot.apiKey.${normalizedProvider}`;
			apiKey = await this.secrets.get(providerKey);

			if (!apiKey && !useGenericKey) {
				const entered = await vscode.window.showInputBox({
					title: `OAI Compatible API Key for ${normalizedProvider}`,
					prompt: `Enter your OAI Compatible API key for ${normalizedProvider}`,
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store(providerKey, apiKey);
				}
			}
		}

		// Fall back to generic API key
		if (!apiKey) {
			apiKey = await this.secrets.get("oaicopilot.apiKey");
		}

		if (!apiKey && useGenericKey) {
			const entered = await vscode.window.showInputBox({
				title: "OAI Compatible API Key",
				prompt: "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("oaicopilot.apiKey", apiKey);
			}
		}
		return apiKey;
	}
}

type OpenAIResponsesStatefulMarkerLocation = { marker: string; index: number };

function createOpenAIResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME);
}

function parseOpenAIResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== "object") {
		return null;
	}
	if (typeof maybe.mimeType !== "string") {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const sep = decoded.indexOf("\\");
		if (sep <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, sep).trim();
		const marker = decoded.slice(sep + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastOpenAIResponsesStatefulMarker(
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[]
): OpenAIResponsesStatefulMarkerLocation | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[i].content ?? []) {
			const parsed = parseOpenAIResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index: i };
			}
		}
	}
	return null;
}
