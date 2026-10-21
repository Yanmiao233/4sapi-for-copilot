import vscode from 'vscode';
import { KEY_SECRET_PREFIX, LEGACY_API_KEY_SECRET } from './consts';

/**
 * 多 API Key 管理：每个 Key 的明文单独存放在系统密钥库
 * （`4sapi-copilot.key.<id>`），settings.json 中只保留分组、别名等非机密元数据。
 */
export class KeyVault {
	constructor(private readonly secretStorage: vscode.SecretStorage) {}

	async getApiKey(keyId: string): Promise<string | undefined> {
		const value = await this.secretStorage.get(KEY_SECRET_PREFIX + keyId);
		return value?.trim() || undefined;
	}

	async setApiKey(keyId: string, apiKey: string): Promise<void> {
		await this.secretStorage.store(KEY_SECRET_PREFIX + keyId, apiKey.trim());
	}

	async deleteApiKey(keyId: string): Promise<void> {
		await this.secretStorage.delete(KEY_SECRET_PREFIX + keyId);
	}

	async hasApiKey(keyId: string): Promise<boolean> {
		return (await this.getApiKey(keyId)) !== undefined;
	}

	/** 读取历史版本存放单一 Key 的密钥（`4sapi-copilot.apiKey`） */
	async getLegacyApiKey(): Promise<string | undefined> {
		const legacy = await this.secretStorage.get(LEGACY_API_KEY_SECRET);
		return legacy?.trim() || undefined;
	}

	/** 迁移成功后再删除历史密钥，避免中途失败导致密钥丢失 */
	async deleteLegacyApiKey(): Promise<void> {
		await this.secretStorage.delete(LEGACY_API_KEY_SECRET);
	}

	/** 列出密钥库中本扩展写入的全部条目（供诊断使用） */
	async listStoredKeys(): Promise<string[]> {
		const keys = await this.secretStorage.keys();
		return keys.filter((key) => key.startsWith(KEY_SECRET_PREFIX)).sort();
	}

	/** 清理已从配置中删除的 Key 的密钥 */
	async pruneOrphans(knownKeyIds: readonly string[]): Promise<string[]> {
		const known = new Set(knownKeyIds.map((id) => KEY_SECRET_PREFIX + id));
		const orphans = (await this.secretStorage.keys()).filter(
			(key) => key.startsWith(KEY_SECRET_PREFIX) && !known.has(key),
		);
		await Promise.all(orphans.map((key) => this.secretStorage.delete(key)));
		return orphans;
	}

	/** 弹窗输入 API Key（不落盘），用于「添加 Key」流程 */
	async promptForKey(title: string): Promise<string | undefined> {
		const apiKey = await vscode.window.showInputBox({
			title,
			prompt: '在 4SAPI 控制台按目标分组创建 Key，再粘贴到此处（形如 sk-...）',
			placeHolder: 'sk-...',
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => (value?.trim() ? undefined : 'API Key 不能为空'),
		});
		return apiKey?.trim() || undefined;
	}
}
