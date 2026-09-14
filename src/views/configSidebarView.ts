import * as vscode from "vscode";
import { ConfigController } from "./configController";

/**
 * Sidebar WebviewView that hosts the same OAICopilot configuration UI as the
 * editor WebviewPanel (ConfigViewPanel).
 *
 * Both views share the same assets (assets/configView) and the same
 * {@link ConfigController}, so behaviour and settings are identical.
 */
export class ConfigSidebarView implements vscode.WebviewViewProvider {
	public static readonly viewType = "oaicopilot.configSidebar";

	private webviewView: vscode.WebviewView | undefined;
	private readonly controller: ConfigController;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		secrets: vscode.SecretStorage
	) {
		this.controller = new ConfigController(extensionUri, secrets);
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out"), vscode.Uri.joinPath(this.extensionUri, "assets")],
		};

		webviewView.webview.onDidReceiveMessage(
			async (message) => {
				this.controller.handleMessage(webviewView.webview, message).catch((err) => {
					console.error("[oaicopilot] sidebar handleMessage failed", err);
					vscode.window.showErrorMessage(
						err instanceof Error
							? err.message
							: `Unexpected error while handling configuration message[${(message as { type?: string }).type}].`
					);
				});
			},
			null,
			this.disposables
		);

		webviewView.webview.html = await this.getHtml(webviewView.webview);

		// Send initialization data once the webview is ready.
		void this.controller.sendInit(webviewView.webview);
	}

	private async getHtml(webview: vscode.Webview) {
		const nonce = this.getNonce();
		const assetsRoot = vscode.Uri.joinPath(this.extensionUri, "assets", "configView");
		const templatePath = vscode.Uri.joinPath(assetsRoot, "configView.html");
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configView.css"));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configView.js"));
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'nonce-${nonce}'`,
		].join("; ");

		const raw = await vscode.workspace.fs.readFile(templatePath);
		let html = new TextDecoder("utf-8").decode(raw);
		html = html
			.replaceAll("%CSP_SOURCE%", csp)
			.replaceAll("%NONCE%", nonce)
			.replace("%CSS_URI%", cssUri.toString())
			.replace("%SCRIPT_URI%", jsUri.toString());
		// Mark the sidebar variant so the shared CSS can apply compact
		// single-column overrides (the editor tab keeps the wide layout).
		html = html.replace("<body>", '<body class="sidebar">');
		return html;
	}

	private getNonce() {
		return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
	}

	public dispose() {
		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
}
