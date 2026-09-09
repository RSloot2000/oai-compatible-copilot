import * as crypto from "crypto";
import * as vscode from "vscode";

interface CodebaseConfig {
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
	autoUpdate: boolean;
	autoUpdateDebounceMs: number;
}

interface IndexedFile {
	mtime: number;
	size: number;
	chunks: number;
}

interface IndexManifest {
	workspaceId: string;
	files: Record<string, IndexedFile>;
	updatedAt: string;
}

interface Chunk {
	id: string;
	uri: string;
	workspacePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

export interface IndexResult {
	indexedFiles: number;
	removedFiles: number;
	indexedChunks: number;
	skippedFiles: number;
}

export interface CodebaseStatus {
	configured: boolean;
	indexed: boolean;
	stale: boolean;
	watcherActive: boolean;
	building?: boolean;
	workspaceId?: string;
	collection?: string;
	indexedFiles?: number;
	indexedChunks?: number;
	pendingChanges?: number;
	lastUpdated?: string;
	message?: string;
}

export interface BuildStatus {
	running: boolean;
	startedAt?: string;
	lastResult?: IndexResult;
	error?: string;
}

export interface SearchResult {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	content: string;
}

interface QdrantPoint {
	id: string;
	vector: number[];
	payload: Record<string, unknown>;
}

const MANIFEST_PREFIX = "oaicopilot.codebase.manifest.";

export class CodebaseIndexService implements vscode.Disposable {
	private readonly changedUris = new Set<string>();
	private watchers: vscode.FileSystemWatcher[] = [];
	private buildState: BuildStatus = { running: false };
	private autoUpdateTimer: NodeJS.Timeout | undefined;
	private cachedStatus: CodebaseStatus | undefined;

	private readonly onStatusEmitter = new vscode.EventEmitter<CodebaseStatus>();
	private readonly onBuildEmitter = new vscode.EventEmitter<BuildStatus>();

	readonly onStatusChanged: vscode.Event<CodebaseStatus> = this.onStatusEmitter.event;
	readonly onBuildChanged: vscode.Event<BuildStatus> = this.onBuildEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.configureWatchers();
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("oaicopilot.codebaseIndex")) {
					this.configureWatchers();
					this.scheduleAutoUpdate();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.configureWatchers();
				this.cachedStatus = undefined;
				this.emitStatus();
			})
		);
	}

	dispose(): void {
		this.disposeWatchers();
		if (this.autoUpdateTimer) {
			clearTimeout(this.autoUpdateTimer);
			this.autoUpdateTimer = undefined;
		}
		this.onStatusEmitter.dispose();
		this.onBuildEmitter.dispose();
	}

	/**
	 * Returns the last known status immediately (for cheap UI polling),
	 * refreshing it in the background when it is missing or stale.
	 */
	async status(token: vscode.CancellationToken): Promise<CodebaseStatus> {
		const current = await this.computeStatus(token);
		this.cachedStatus = current;
		this.emitStatus();
		return current;
	}

	getCachedStatus(): CodebaseStatus | undefined {
		return this.cachedStatus;
	}

	private emitStatus(): void {
		if (this.cachedStatus) {
			this.onStatusEmitter.fire(this.cachedStatus);
		}
	}

	private emitBuild(): void {
		this.onBuildEmitter.fire({ ...this.buildState });
	}

	private async computeStatus(token: vscode.CancellationToken): Promise<CodebaseStatus> {
		const workspaceId = this.getWorkspaceId();
		if (!workspaceId) {
			return {
				configured: false,
				indexed: false,
				stale: false,
				watcherActive: false,
				message: "Open a workspace before using codebase indexing.",
			};
		}

		const config = this.getConfig();
		const configured = config.qdrantUrl.trim() !== "" && config.ollamaUrl.trim() !== "";
		if (!configured) {
			return {
				configured: false,
				indexed: false,
				stale: false,
				watcherActive: this.watchers.length > 0,
				building: this.buildState.running,
				workspaceId,
				collection: config.collection,
				message: "Set the Qdrant and Ollama URLs in the configuration UI.",
			};
		}

		const manifest = this.getManifest(workspaceId);
		const pendingChanges = manifest ? await this.countManifestChanges(config, manifest, token) : 0;
		let indexedChunks = 0;
		let collectionExists = false;
		try {
			collectionExists = await this.collectionExists(config, token);
			if (collectionExists) {
				indexedChunks = await this.countWorkspacePoints(config, workspaceId, token);
			}
		} catch (error) {
			return {
				configured: true,
				indexed: false,
				stale: false,
				watcherActive: this.watchers.length > 0,
				building: this.buildState.running,
				workspaceId,
				collection: config.collection,
				message: this.errorMessage(error),
			};
		}

		const indexedFiles = manifest ? Object.keys(manifest.files).length : 0;
		return {
			configured: true,
			indexed: collectionExists && indexedChunks > 0,
			stale: pendingChanges > 0,
			watcherActive: this.watchers.length > 0,
			building: this.buildState.running,
			workspaceId,
			collection: config.collection,
			indexedFiles,
			indexedChunks,
			pendingChanges,
			lastUpdated: manifest?.updatedAt,
		};
	}

	async index(_token: vscode.CancellationToken): Promise<BuildStatus> {
		return this.startBuild(true);
	}

	async update(_token: vscode.CancellationToken): Promise<BuildStatus> {
		return this.startBuild(false);
	}

	getBuildStatus(): BuildStatus {
		return { ...this.buildState };
	}

	private startBuild(full: boolean): BuildStatus {
		if (this.buildState.running) {
			return { ...this.buildState };
		}
		const source = new vscode.CancellationTokenSource();
		this.buildState = {
			running: true,
			startedAt: new Date().toISOString(),
			lastResult: this.buildState.lastResult,
			error: undefined,
		};
		void this.runIndex(full, source.token)
			.then((result) => {
				this.buildState = {
					running: false,
					startedAt: this.buildState.startedAt,
					lastResult: result,
					error: undefined,
				};
			})
			.catch((error) => {
				this.buildState = {
					running: false,
					startedAt: this.buildState.startedAt,
					lastResult: this.buildState.lastResult,
					error: this.errorMessage(error),
				};
			})
			.finally(() => {
				source.dispose();
				this.emitBuild();
				void this.status(new vscode.CancellationTokenSource().token);
			});
		this.emitBuild();
		return { ...this.buildState };
	}

	/**
	 * Schedules a debounced incremental update when the auto-update watchdog is enabled.
	 * Called from file watchers and configuration changes.
	 */
	scheduleAutoUpdate(): void {
		const config = this.getConfig();
		if (!config.autoUpdate) {
			return;
		}
		if (this.buildState.running) {
			return;
		}
		if (this.autoUpdateTimer) {
			clearTimeout(this.autoUpdateTimer);
		}
		this.autoUpdateTimer = setTimeout(() => {
			this.autoUpdateTimer = undefined;
			if (this.changedUris.size === 0) {
				return;
			}
			this.startBuild(false);
		}, config.autoUpdateDebounceMs);
	}

	async search(query: string, limit: number | undefined, token: vscode.CancellationToken): Promise<SearchResult[]> {
		const workspaceId = this.requireWorkspaceId();
		const config = this.getConfig();
		const vector = (await this.embed(config, [query], token))[0];
		const response = await this.qdrantRequest<{ result?: Array<{ score: number; payload?: Record<string, unknown> }> }>(
			config,
			`/collections/${encodeURIComponent(config.collection)}/points/search`,
			{
				method: "POST",
				body: JSON.stringify({
					vector,
					limit: Math.max(1, Math.min(limit ?? config.searchLimit, 20)),
					with_payload: true,
					with_vector: false,
					filter: this.workspaceFilter(workspaceId),
				}),
			},
			token
		);

		return (response.result ?? []).map((item) => ({
			path: String(item.payload?.path ?? ""),
			startLine: Number(item.payload?.start_line ?? 0),
			endLine: Number(item.payload?.end_line ?? 0),
			score: item.score,
			content: String(item.payload?.content ?? ""),
		}));
	}

	private async runIndex(full: boolean, token: vscode.CancellationToken): Promise<IndexResult> {
		const workspaceId = this.requireWorkspaceId();
		const config = this.getConfig();
		await this.ensureCollection(config, token);

		const previous = this.getManifest(workspaceId);
		const uris = await vscode.workspace.findFiles(config.include, config.exclude);
		const currentFiles: Record<string, IndexedFile> = {};
		const changed: Array<{ uri: vscode.Uri; workspacePath: string; stat: vscode.FileStat }> = [];
		let skippedFiles = 0;

		for (const uri of uris) {
			this.throwIfCancelled(token);
			const stat = await vscode.workspace.fs.stat(uri);
			const workspacePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
			if (stat.type !== vscode.FileType.File || stat.size > config.maxFileBytes) {
				skippedFiles++;
				continue;
			}
			const old = previous?.files[workspacePath];
			currentFiles[workspacePath] = { mtime: stat.mtime, size: stat.size, chunks: old?.chunks ?? 0 };
			if (full || !old || old.mtime !== stat.mtime || old.size !== stat.size || this.changedUris.has(uri.toString())) {
				changed.push({ uri, workspacePath, stat });
			}
		}

		const removed = previous
			? Object.keys(previous.files).filter((workspacePath) => currentFiles[workspacePath] === undefined)
			: [];

		if (full) {
			await this.deleteByFilter(config, this.workspaceFilter(workspaceId), token);
		} else {
			for (const workspacePath of [...removed, ...changed.map((file) => file.workspacePath)]) {
				await this.deleteByFilter(config, this.fileFilter(workspaceId, workspacePath), token);
			}
		}

		let indexedChunks = 0;
		for (const file of changed) {
			this.throwIfCancelled(token);
			const bytes = await vscode.workspace.fs.readFile(file.uri);
			const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			if (content.includes("\u0000")) {
				skippedFiles++;
				delete currentFiles[file.workspacePath];
				continue;
			}

			const chunks = this.chunkFile(file.uri, file.workspacePath, content, config);
			for (let offset = 0; offset < chunks.length; offset += 16) {
				this.throwIfCancelled(token);
				const batch = chunks.slice(offset, offset + 16);
				const vectors = await this.embed(
					config,
					batch.map((chunk) => `${chunk.workspacePath}:${chunk.startLine}-${chunk.endLine}\n${chunk.content}`),
					token
				);
				const points: QdrantPoint[] = batch.map((chunk, index) => ({
					id: chunk.id,
					vector: vectors[index],
					payload: {
						workspace_id: workspaceId,
						path: chunk.workspacePath,
						uri: chunk.uri,
						start_line: chunk.startLine,
						end_line: chunk.endLine,
						content: chunk.content,
					},
				}));
				await this.upsertPoints(config, points, token);
				indexedChunks += points.length;
			}
			currentFiles[file.workspacePath].chunks = chunks.length;
		}

		const manifest: IndexManifest = {
			workspaceId,
			files: currentFiles,
			updatedAt: new Date().toISOString(),
		};
		await this.context.workspaceState.update(`${MANIFEST_PREFIX}${workspaceId}`, manifest);
		this.changedUris.clear();

		return {
			indexedFiles: changed.length,
			removedFiles: removed.length,
			indexedChunks,
			skippedFiles,
		};
	}

	private async countManifestChanges(
		config: CodebaseConfig,
		manifest: IndexManifest,
		token: vscode.CancellationToken
	): Promise<number> {
		const uris = await vscode.workspace.findFiles(config.include, config.exclude);
		const currentPaths = new Set<string>();
		let changes = 0;
		for (const uri of uris) {
			this.throwIfCancelled(token);
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type !== vscode.FileType.File || stat.size > config.maxFileBytes) {
				continue;
			}
			const workspacePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
			currentPaths.add(workspacePath);
			const indexed = manifest.files[workspacePath];
			if (!indexed || indexed.mtime !== stat.mtime || indexed.size !== stat.size) {
				changes++;
			}
		}
		for (const workspacePath of Object.keys(manifest.files)) {
			if (!currentPaths.has(workspacePath)) {
				changes++;
			}
		}
		return changes;
	}

	private chunkFile(uri: vscode.Uri, workspacePath: string, content: string, config: CodebaseConfig): Chunk[] {
		const lines = content.replace(/\r\n/g, "\n").split("\n");
		const chunks: Chunk[] = [];
		const step = Math.max(1, config.chunkLines - config.chunkOverlap);
		for (let start = 0; start < lines.length; start += step) {
			const end = Math.min(lines.length, start + config.chunkLines);
			const chunkContent = lines.slice(start, end).join("\n").trim();
			if (chunkContent) {
				const key = `${this.getWorkspaceId()}:${workspacePath}:${start + 1}:${chunkContent}`;
				chunks.push({
					id: this.uuidFromText(key),
					uri: uri.toString(),
					workspacePath,
					startLine: start + 1,
					endLine: end,
					content: chunkContent,
				});
			}
			if (end === lines.length) {
				break;
			}
		}
		return chunks;
	}

	private async embed(config: CodebaseConfig, input: string[], token: vscode.CancellationToken): Promise<number[][]> {
		const controller = this.abortController(token);
		try {
			const response = await fetch(`${config.ollamaUrl.replace(/\/+$/, "")}/api/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: config.embeddingModel, input }),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`Ollama embeddings failed: ${response.status} ${await response.text()}`);
			}
			const body = (await response.json()) as { embeddings?: number[][] };
			if (!body.embeddings || body.embeddings.length !== input.length) {
				throw new Error("Ollama returned an unexpected embeddings response.");
			}
			for (const vector of body.embeddings) {
				if (vector.length !== config.embeddingDimensions) {
					throw new Error(
						`Embedding dimension mismatch: expected ${config.embeddingDimensions}, received ${vector.length}.`
					);
				}
			}
			return body.embeddings;
		} finally {
			controller.dispose();
		}
	}

	private async collectionExists(config: CodebaseConfig, token: vscode.CancellationToken): Promise<boolean> {
		const controller = this.abortController(token);
		try {
			const response = await fetch(
				`${config.qdrantUrl.replace(/\/+$/, "")}/collections/${encodeURIComponent(config.collection)}`,
				{ signal: controller.signal }
			);
			if (response.status === 404) {
				return false;
			}
			if (!response.ok) {
				throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`);
			}
			return true;
		} finally {
			controller.dispose();
		}
	}

	private async ensureCollection(config: CodebaseConfig, token: vscode.CancellationToken): Promise<void> {
		if (await this.collectionExists(config, token)) {
			return;
		}
		await this.qdrantRequest(
			config,
			`/collections/${encodeURIComponent(config.collection)}`,
			{
				method: "PUT",
				body: JSON.stringify({ vectors: { size: config.embeddingDimensions, distance: "Cosine" } }),
			},
			token
		);
	}

	private async countWorkspacePoints(
		config: CodebaseConfig,
		workspaceId: string,
		token: vscode.CancellationToken
	): Promise<number> {
		const body = await this.qdrantRequest<{ result?: { count?: number } }>(
			config,
			`/collections/${encodeURIComponent(config.collection)}/points/count`,
			{
				method: "POST",
				body: JSON.stringify({ filter: this.workspaceFilter(workspaceId), exact: true }),
			},
			token
		);
		return body.result?.count ?? 0;
	}

	private async upsertPoints(config: CodebaseConfig, points: QdrantPoint[], token: vscode.CancellationToken): Promise<void> {
		await this.qdrantRequest(
			config,
			`/collections/${encodeURIComponent(config.collection)}/points?wait=true`,
			{ method: "PUT", body: JSON.stringify({ points }) },
			token
		);
	}

	private async deleteByFilter(
		config: CodebaseConfig,
		filter: Record<string, unknown>,
		token: vscode.CancellationToken
	): Promise<void> {
		await this.qdrantRequest(
			config,
			`/collections/${encodeURIComponent(config.collection)}/points/delete?wait=true`,
			{ method: "POST", body: JSON.stringify({ filter }) },
			token
		);
	}

	private async qdrantRequest<T = unknown>(
		config: CodebaseConfig,
		endpoint: string,
		init: RequestInit,
		token: vscode.CancellationToken
	): Promise<T> {
		const controller = this.abortController(token);
		try {
			const response = await fetch(`${config.qdrantUrl.replace(/\/+$/, "")}${endpoint}`, {
				...init,
				headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`);
			}
			return (await response.json()) as T;
		} finally {
			controller.dispose();
		}
	}

	private abortController(token: vscode.CancellationToken): AbortController & { dispose(): void } {
		const controller = new AbortController() as AbortController & { dispose(): void };
		const subscription = token.onCancellationRequested(() => controller.abort());
		if (token.isCancellationRequested) {
			controller.abort();
		}
		controller.dispose = () => subscription.dispose();
		return controller;
	}

	private workspaceFilter(workspaceId: string): Record<string, unknown> {
		return { must: [{ key: "workspace_id", match: { value: workspaceId } }] };
	}

	private fileFilter(workspaceId: string, workspacePath: string): Record<string, unknown> {
		return {
			must: [
				{ key: "workspace_id", match: { value: workspaceId } },
				{ key: "path", match: { value: workspacePath } },
			],
		};
	}

	private getManifest(workspaceId: string): IndexManifest | undefined {
		return this.context.workspaceState.get<IndexManifest>(`${MANIFEST_PREFIX}${workspaceId}`);
	}

	private getWorkspaceId(): string | undefined {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return undefined;
		}
		const source = folders.map((folder) => folder.uri.toString()).sort().join("\n");
		return crypto.createHash("sha256").update(source).digest("hex").slice(0, 24);
	}

	private requireWorkspaceId(): string {
		const workspaceId = this.getWorkspaceId();
		if (!workspaceId) {
			throw new Error("Open a workspace before using codebase indexing.");
		}
		return workspaceId;
	}

	private uuidFromText(value: string): string {
		const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
		return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
	}

	private getConfig(): CodebaseConfig {
		const config = vscode.workspace.getConfiguration("oaicopilot.codebaseIndex");
		return {
			qdrantUrl: config.get("qdrantUrl", ""),
			ollamaUrl: config.get("ollamaUrl", ""),
			embeddingModel: config.get("embeddingModel", ""),
			embeddingDimensions: config.get("embeddingDimensions", 768),
			collection: config.get("collection", "oaicopilot_codebase"),
			include: config.get("include", ""),
			exclude: config.get("exclude", ""),
			chunkLines: Math.max(20, config.get("chunkLines", 120)),
			chunkOverlap: Math.max(0, config.get("chunkOverlap", 20)),
			maxFileBytes: Math.max(1024, config.get("maxFileBytes", 1_000_000)),
			searchLimit: Math.max(1, config.get("searchLimit", 8)),
			autoUpdate: config.get("autoUpdate", true),
			autoUpdateDebounceMs: Math.max(500, config.get("autoUpdateDebounceMs", 3000)),
		};
	}

	private configureWatchers(): void {
		this.disposeWatchers();
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return;
		}
		const config = this.getConfig();
		for (const folder of folders) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder, config.include),
				false,
				false,
				false
			);
			const track = (uri: vscode.Uri) => {
				this.changedUris.add(uri.toString());
				this.scheduleAutoUpdate();
			};
			watcher.onDidCreate(track);
			watcher.onDidChange(track);
			watcher.onDidDelete(track);
			this.watchers.push(watcher);
		}
	}

	private disposeWatchers(): void {
		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.watchers = [];
	}

	private throwIfCancelled(token: vscode.CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
