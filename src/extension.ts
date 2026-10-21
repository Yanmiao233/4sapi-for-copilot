import vscode from 'vscode';
import { ApiClient } from './client';
import { getBaseUrl, getConfig, getDebugMode, getKeySettings, resolveKeys } from './config';
import { CONFIG_DATA_VERSION_KEY, EXTERNAL_URLS } from './consts';
import {
	addKey,
	editKeyModels,
	refreshPricing,
	removeKey,
	renameKey,
	showDiagnostics,
	testConnections,
	type KeyCommandDeps,
} from './keys';
import { CHANNEL_NAME, initLogger, logLine, logger, setLogLevel, showLogs } from './logger';
import { formatRatio, isChatModel, listGroups } from './pricing';
import { PricingStore } from './pricingStore';
import { FourSapiChatProvider } from './provider';
import type { KeySetting, ModelSetting } from './types';
import { KeyVault } from './vault';

/** settings.json 配置数据的当前版本（用于一次性迁移旧结构） */
const CONFIG_DATA_VERSION = 1;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	initLogger(CHANNEL_NAME, getDebugMode());
	setLogLevel(getDebugMode());

	const vault = new KeyVault(context.secrets);
	const pricing = new PricingStore(context.globalState);
	const provider = new FourSapiChatProvider(context, vault, pricing);
	const deps: KeyCommandDeps = {
		vault,
		pricing,
		refresh: () => provider.refreshModelPicker(),
	};

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('4sapi', provider),
		vscode.commands.registerCommand('4sapi-copilot.addKey', () => addKey(deps)),
		vscode.commands.registerCommand('4sapi-copilot.removeKey', () => removeKey(deps)),
		vscode.commands.registerCommand('4sapi-copilot.editKeyModels', () => editKeyModels(deps)),
		vscode.commands.registerCommand('4sapi-copilot.renameKey', () => renameKey(deps)),
		vscode.commands.registerCommand('4sapi-copilot.refreshPricing', () => refreshPricing(deps)),
		vscode.commands.registerCommand('4sapi-copilot.testConnection', () => testConnections(deps)),
		vscode.commands.registerCommand('4sapi-copilot.reloadModels', () => {
			provider.refreshModelPicker();
			void vscode.window.showInformationMessage('4SAPI: 模型列表已重新加载。');
		}),
		vscode.commands.registerCommand('4sapi-copilot.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '4sapi-copilot');
		}),
		vscode.commands.registerCommand('4sapi-copilot.showLogs', () => {
			// 面板可能因当前 debugMode 过滤而几乎为空，先说明一下，免得用户以为没反应
			logLine(
				'INFO',
				`已打开「${CHANNEL_NAME}」输出面板`,
				`debugMode=${getDebugMode()}`,
				getDebugMode() === 'minimal'
					? '（当前只记录错误；想看请求详情请把 4sapi-copilot.debugMode 设为 metadata 或 verbose）'
					: '',
			);
			showLogs(false);
		}),
		vscode.commands.registerCommand('4sapi-copilot.diagnostics', () => showDiagnostics(deps)),
	);

	await migrateLegacyConfig(context, vault, pricing);
	await vault.pruneOrphans(getKeySettings().map((key) => key.id));
	// 预热倍率表，让模型名里的消耗倍率在首次打开选择器时就可显示
	void pricing.ensure(getBaseUrl()).then(() => provider.refreshModelPicker());

	// 让模型尽快可被发现（Copilot 可能还在等自身激活）
	provider.refreshModelPicker();
	void vscode.extensions.getExtension('github.copilot-chat')?.activate().then(
		() => provider.refreshModelPicker(),
		(error: unknown) => logger.warn('激活 Copilot Chat 失败（不影响本扩展）:', String(error)),
	);

	const keys = resolveKeys(getKeySettings());
	// 无条件写一行激活横幅：否则在 debugMode=minimal 且一切正常时输出通道是空白的，
	// 用户会误以为「显示日志」命令没反应（日志按级别过滤，minimal 只记录错误）。
	logLine(
		'INFO',
		'4SAPI 已就绪',
		`版本=${context.extension.packageJSON?.version ?? '?'}`,
		`baseUrl=${getBaseUrl()}`,
		`Key 数=${keys.length}`,
		`模型数=${keys.reduce((sum, key) => sum + key.models.length, 0)}`,
		`debugMode=${getDebugMode()}`,
	);
	logger.info(
		'4SAPI for Copilot 已激活',
		`baseUrl=${getBaseUrl()}`,
		`Key 数=${keys.length}`,
		`模型数=${keys.reduce((sum, key) => sum + key.models.length, 0)}`,
	);
}

export function deactivate(): void {
	// 输出通道随扩展释放
}

// ---- 旧配置迁移 ----

/**
 * 一次性迁移旧版本（0.1.x）配置：单个 API Key（SecretStorage 或 settings 的 `apiKey`）
 * + `models` 数组 → 第一个 `keys[]` 条目，并按 `/api/pricing` 推断分组与倍率。
 */
async function migrateLegacyConfig(
	context: vscode.ExtensionContext,
	vault: KeyVault,
	pricing: PricingStore,
): Promise<void> {
	const version = context.globalState.get<number>(CONFIG_DATA_VERSION_KEY, 0);
	if (version >= CONFIG_DATA_VERSION) {
		return;
	}

	if (getKeySettings().length === 0) {
		const legacyApiKey =
			(await vault.getLegacyApiKey()) || getConfig().get<string>('apiKey')?.trim() || undefined;
		if (legacyApiKey) {
			const key = await buildMigratedKey(legacyApiKey, pricing);
			// 先落盘新结构、确认成功后再清理旧密钥，避免中途失败导致 Key 丢失
			await saveKeys([key]);
			await vault.setApiKey(key.id, legacyApiKey);
			await vault.deleteLegacyApiKey();
			void vscode.window.showInformationMessage(
				`4SAPI: 已把原来的 API Key 迁移为 Key「${key.alias}」` +
					`${key.group ? `（分组 ${key.group} · ${formatRatio(key.groupRatio)}）` : ''}，` +
					`共 ${key.models?.length ?? 0} 个模型。可用「4SAPI: 编辑 Key 的模型列表」调整。`,
			);
		}
	}

	const config = getConfig();
	if ((config.get<unknown[]>('models') ?? []).length > 0) {
		await config.update('models', undefined, vscode.ConfigurationTarget.Global);
	}
	await context.globalState.update(CONFIG_DATA_VERSION_KEY, CONFIG_DATA_VERSION);
}

async function buildMigratedKey(apiKey: string, pricing: PricingStore): Promise<KeySetting> {
	const baseUrl = getBaseUrl();
	const legacyModels = getConfig().get<ModelSetting[]>('models', []) ?? [];

	// 旧 `models` 条目的 id 即发给 4SAPI 的真实模型名
	let models = legacyModels
		.map((model) => (model?.apiModelId ?? model?.id ?? '').trim())
		.filter((id) => id.length > 0);

	let group = '';
	let groupRatio: number | undefined;
	let alias = '默认 Key';

	try {
		const liveModelIds = await new ApiClient(baseUrl, apiKey, {}).listModels();
		const snapshot = (await pricing.reload(baseUrl)).snapshot;
		if (models.length === 0) {
			models = liveModelIds.filter((id) => !snapshot || isChatModel(snapshot, id));
		}
		if (snapshot) {
			// `/v1/models` 已按该 Key 的权限过滤，其可用分组即该 Key 绑定的分组
			const inferred = listGroups(snapshot, liveModelIds);
			if (inferred.length > 0) {
				group = inferred[0].group;
				groupRatio = inferred[0].ratio;
				alias = group;
			}
			if (group) {
				const allowed = new Set(
					liveModelIds.filter((id) => {
						const entry = snapshot.models[id];
						return !entry || entry.enableGroups.includes(group);
					}),
				);
				models = models.filter((id) => allowed.has(id));
			}
		}
	} catch (error) {
		logger.warn('迁移旧配置时无法获取模型 / 倍率:', String(error));
	}

	return { id: 'key-legacy', alias, enabled: true, group, groupRatio, models };
}

async function saveKeys(keys: KeySetting[]): Promise<void> {
	await getConfig().update('keys', keys, vscode.ConfigurationTarget.Global);
}

// 保留外部链接常量引用（README / 未来 UI 使用）
void EXTERNAL_URLS;
