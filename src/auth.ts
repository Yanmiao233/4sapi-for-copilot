import vscode from 'vscode';
import { API_KEY_SECRET, CONFIG_SECTION } from './consts';

/**
 * API Key 管理：优先 SecretStorage（系统密钥库），
 * settings.json 中的 `4sapi-copilot.apiKey` 仅作 CI/自动化的后备。
 */
export class AuthManager {
	constructor(private readonly secretStorage: vscode.SecretStorage) {}

	async getApiKey(): Promise<string | undefined> {
		const fromSecret = await this.secretStorage.get(API_KEY_SECRET);
		if (fromSecret?.trim()) {
			return fromSecret.trim();
		}
		const fromSettings = vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.get<string>('apiKey');
		return fromSettings?.trim() || undefined;
	}

	async setApiKey(apiKey: string): Promise<void> {
		await this.secretStorage.store(API_KEY_SECRET, apiKey.trim());
	}

	async deleteApiKey(): Promise<void> {
		await this.secretStorage.delete(API_KEY_SECRET);
	}

	async hasApiKey(): Promise<boolean> {
		return (await this.getApiKey()) !== undefined;
	}

	/** 弹窗输入 API Key 并保存到密钥库 */
	async promptForApiKey(): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: '输入 4SAPI API Key（在 4SAPI 控制台创建，形如 sk-...）',
			placeHolder: 'sk-...',
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => (value?.trim() ? undefined : 'API Key 不能为空'),
		});
		if (!apiKey) {
			return false;
		}
		await this.setApiKey(apiKey);
		void vscode.window.showInformationMessage('4SAPI: API Key 已保存到系统密钥库。');
		return true;
	}
}
