import vscode from 'vscode';
import { AuthManager } from './auth';
import { ApiClient, ApiRequestError } from './client';
import {
	getBaseUrl,
	getDebugMode,
	getModelSettings,
} from './config';
import { EXTERNAL_URLS } from './consts';
import { initLogger, logger, setLogLevel, showLogs } from './logger';
import { FourSapiChatProvider } from './provider';
import type { ModelSetting, ThinkingConfig } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	initLogger('4SAPI', getDebugMode());
	setLogLevel(getDebugMode());

	const auth = new AuthManager(context.secrets);
	const provider = new FourSapiChatProvider(context, auth);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('4sapi', provider),
		vscode.commands.registerCommand('4sapi-copilot.setApiKey', async () => {
			if (await auth.promptForApiKey()) {
				provider.refreshModelPicker();
			}
		}),
		vscode.commands.registerCommand('4sapi-copilot.clearApiKey', async () => {
			const confirm = '清除';
			const picked = await vscode.window.showWarningMessage(
				'确定清除已保存的 4SAPI API Key？',
				{ modal: true },
				confirm,
			);
			if (picked !== confirm) {
				return;
			}
			await auth.deleteApiKey();
			provider.refreshModelPicker();
			void vscode.window.showInformationMessage('4SAPI: API Key 已清除。');
		}),
		vscode.commands.registerCommand('4sapi-copilot.testConnection', () =>
			testConnection(auth),
		),
		vscode.commands.registerCommand('4sapi-copilot.fetchModels', () =>
			fetchModels(auth, provider),
		),
		vscode.commands.registerCommand('4sapi-copilot.reloadModels', () => {
			provider.refreshModelPicker();
			void vscode.window.showInformationMessage('4SAPI: 模型列表已重新加载。');
		}),
		vscode.commands.registerCommand('4sapi-copilot.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '4sapi-copilot');
		}),
		vscode.commands.registerCommand('4sapi-copilot.showLogs', () => showLogs()),
	);

	// 让模型尽快可被发现（Copilot 可能还在等自身激活）
	provider.refreshModelPicker();
	void vscode.extensions.getExtension('github.copilot-chat')?.activate().then(
		() => provider.refreshModelPicker(),
		(error: unknown) => logger.warn('激活 Copilot Chat 失败（不影响本扩展）:', String(error)),
	);

	logger.info('4SAPI for Copilot 已激活', `baseUrl=${getBaseUrl()}`);
}

export function deactivate(): void {
	// 输出通道随扩展释放
}

// ---- 命令实现 ----

async function testConnection(auth: AuthManager): Promise<void> {
	const apiKey = await requireApiKey(auth);
	if (!apiKey) {
		return;
	}
	const client = new ApiClient(getBaseUrl(), apiKey, {});
	try {
		const models = await client.listModels();
		const preview = models.slice(0, 8).join('、');
		void vscode.window.showInformationMessage(
			`4SAPI 连接成功：当前 Key 可用模型 ${models.length} 个${preview ? `（${preview}${models.length > 8 ? '…' : ''}）` : ''}`,
		);
		logger.info('连接测试成功', `模型数=${models.length}`);
	} catch (error) {
		reportError('连接测试失败', error);
	}
}

/** 拉取 GET /v1/models 并按命名启发式生成模型配置，写入 settings.json */
async function fetchModels(auth: AuthManager, provider: FourSapiChatProvider): Promise<void> {
	const apiKey = await requireApiKey(auth);
	if (!apiKey) {
		return;
	}
	const client = new ApiClient(getBaseUrl(), apiKey, {});
	let modelIds: string[];
	try {
		modelIds = await client.listModels();
	} catch (error) {
		reportError('拉取模型列表失败', error);
		return;
	}
	if (modelIds.length === 0) {
		void vscode.window.showWarningMessage('4SAPI 未返回任何模型，请检查 Key 权限或套餐。');
		return;
	}

	const existing = new Set(getModelSettings().map((m) => m.id));
	const picked = await vscode.window.showQuickPick(
		modelIds.map((id) => ({
			label: existing.has(id) ? `$(check) ${id}` : id,
			description: existing.has(id) ? '已在配置中' : suggestParams(id),
			picked: !existing.has(id),
			id,
		})),
		{
			canPickMany: true,
			title: '选择要暴露到 Copilot Chat 的 4SAPI 模型',
			placeHolder: '勾选模型后将写入 4sapi-copilot.models（可在设置中继续调整上下文长度、思考深度等参数）',
		},
	);
	if (!picked || picked.length === 0) {
		return;
	}

	const current = getModelSettings();
	const currentById = new Map(current.map((m) => [m.id, m]));
	const merged: ModelSetting[] = [...current];
	for (const item of picked) {
		if (!currentById.has(item.id)) {
			merged.push(generateModelSetting(item.id));
		}
	}

	await vscode.workspace
		.getConfiguration('4sapi-copilot')
		.update('models', merged, vscode.ConfigurationTarget.Global);
	provider.refreshModelPicker();

	const added = merged.length - current.length;
	void vscode.window.showInformationMessage(
		added > 0
			? `4SAPI: 已添加 ${added} 个模型。默认参数为建议值，请到设置中按需调整上下文长度、最大输出与思考深度。`
			: '4SAPI: 所选模型已在配置中。',
	);
	if (added > 0) {
		void vscode.commands.executeCommand('workbench.action.openSettings', '4sapi-copilot.models');
	}
}

async function requireApiKey(auth: AuthManager): Promise<string | undefined> {
	const apiKey = await auth.getApiKey();
	if (apiKey) {
		return apiKey;
	}
	const picked = await vscode.window.showWarningMessage(
		'尚未配置 4SAPI API Key。',
		{ modal: true },
		'立即设置',
	);
	if (picked === '立即设置') {
		if (await auth.promptForApiKey()) {
			return auth.getApiKey();
		}
	}
	return undefined;
}

function reportError(prefix: string, error: unknown): void {
	const message =
		error instanceof ApiRequestError
			? `${prefix}：${error.message}`
			: `${prefix}：${error instanceof Error ? error.message : String(error)}`;
	void vscode.window.showErrorMessage(message);
	logger.error(prefix, error instanceof Error ? error.message : String(error));
}

// ---- 模型名启发式（仅为建议默认值，最终以 4SAPI 控制台参数为准） ----

function suggestParams(id: string): string {
	const p = generateModelSetting(id);
	return `${p.maxInputTokens}/${p.maxOutputTokens} tokens`;
}

function generateModelSetting(id: string): ModelSetting {
	const lower = id.toLowerCase();
	const base: ModelSetting = {
		id,
		name: `${id} (4SAPI)`,
		enabled: true,
		toolCalling: true,
		imageInput: false,
		maxInputTokens: 128000,
		maxOutputTokens: 32768,
	};

	if (lower.includes('claude')) {
		return {
			...base,
			family: 'claude',
			imageInput: true,
			maxInputTokens: 200000,
			maxOutputTokens: 64000,
			thinking: anthropicThinking(['low', 'medium', 'high', 'max'], 'high'),
		};
	}
	if (lower.includes('gpt-5') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) {
		return {
			...base,
			family: 'gpt',
			imageInput: !lower.includes('codex'),
			maxInputTokens: 200000,
			maxOutputTokens: 64000,
			thinking: openaiThinking(['minimal', 'low', 'medium', 'high'], 'medium'),
		};
	}
	if (lower.includes('gemini')) {
		return {
			...base,
			family: 'gemini',
			imageInput: true,
			maxInputTokens: 1048576,
			maxOutputTokens: 65536,
			thinking: openaiThinking(['low', 'medium', 'high'], 'medium'),
		};
	}
	if (lower.includes('deepseek')) {
		return {
			...base,
			family: 'deepseek',
			maxInputTokens: 131072,
			maxOutputTokens: 65536,
			thinking: deepseekThinking(['low', 'high', 'max'], 'high'),
		};
	}
	if (
		lower.includes('qwen') ||
		lower.includes('glm') ||
		lower.includes('kimi') ||
		lower.includes('moonshot') ||
		lower.includes('doubao')
	) {
		return {
			...base,
			family: 'qwen',
			maxInputTokens: 131072,
			maxOutputTokens: 32768,
			thinking: openaiThinking(['low', 'medium', 'high'], 'medium'),
		};
	}
	return base;
}

function openaiThinking(efforts: string[], def: string): ThinkingConfig {
	return { style: 'openai', supportedEfforts: efforts, defaultEffort: def, canDisable: true };
}

function deepseekThinking(efforts: string[], def: string): ThinkingConfig {
	return { style: 'deepseek', supportedEfforts: efforts, defaultEffort: def, canDisable: true };
}

function anthropicThinking(efforts: string[], def: string): ThinkingConfig {
	return {
		style: 'anthropic',
		supportedEfforts: efforts,
		defaultEffort: def,
		canDisable: true,
		effortBudgets: { low: 4096, medium: 8192, high: 16384, max: 32768 },
	};
}

// 保留外部链接常量引用（README / 未来 UI 使用）
void EXTERNAL_URLS;
