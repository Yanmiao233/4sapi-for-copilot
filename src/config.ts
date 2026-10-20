import vscode from 'vscode';
import {
	CONFIG_SECTION,
	DEFAULT_MAX_INPUT_TOKENS,
	DEFAULT_MAX_OUTPUT_TOKENS,
} from './consts';
import type { ModelSetting, ResolvedModel, ThinkingConfig } from './types';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** 4SAPI 接入地址（去掉尾部斜杠） */
export function getBaseUrl(): string {
	const raw = getConfig().get<string>('baseUrl') || 'https://4sapi.com/v1';
	return raw.trim().replace(/\/+$/u, '');
}

export function getRequestHeaders(): Record<string, string> {
	return getConfig().get<Record<string, string>>('requestHeaders', {});
}

/** 全局 max_tokens 上限（0 = 不限制） */
export function getGlobalMaxTokens(): number {
	return getConfig().get<number>('maxTokens', 0);
}

/** 全局采样温度（-1 = 不发送） */
export function getGlobalTemperature(): number {
	return getConfig().get<number>('temperature', -1);
}

/** 全局 top_p（-1 = 不发送） */
export function getGlobalTopP(): number {
	return getConfig().get<number>('topP', -1);
}

export function getUsageReportingEnabled(): boolean {
	return getConfig().get<boolean>('enableUsageReporting', true);
}

export function getDebugMode(): DebugMode {
	const value = getConfig().get<string>('debugMode', 'minimal');
	return value === 'metadata' || value === 'verbose' ? value : 'minimal';
}

/** settings.json 中启用的模型条目 */
export function getModelSettings(): ModelSetting[] {
	const raw = getConfig().get<ModelSetting[]>('models', []);
	return (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m.id === 'string');
}

/** 把模型条目解析为带完整默认值的内部定义 */
export function resolveModels(): ResolvedModel[] {
	return getModelSettings()
		.filter((m) => m.enabled !== false)
		.map(resolveModel);
}

export function resolveModel(setting: ModelSetting): ResolvedModel {
	const maxOutputTokens = positive(setting.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const contextWindow = positive(setting.contextWindow);
	const maxInputTokens =
		positive(setting.maxInputTokens) ??
		(contextWindow ? contextWindow - maxOutputTokens : undefined) ??
		DEFAULT_MAX_INPUT_TOKENS;

	const globalMaxTokens = getGlobalMaxTokens();
	const modelMaxTokens = positive(setting.maxTokens);

	return {
		id: setting.id.trim(),
		apiModelId: setting.apiModelId?.trim() || setting.id.trim(),
		name: setting.name?.trim() || setting.id.trim(),
		family: setting.family?.trim() || '4sapi',
		version: setting.version?.trim() ?? '',
		detail: setting.detail?.trim() || '4SAPI 聚合模型',
		maxInputTokens,
		maxOutputTokens,
		toolCalling: setting.toolCalling !== false,
		imageInput: setting.imageInput === true,
		thinking: normalizeThinking(setting.thinking),
		temperature: numberOrUndefined(setting.temperature),
		topP: numberOrUndefined(setting.topP),
		maxTokens: modelMaxTokens ?? (globalMaxTokens > 0 ? globalMaxTokens : maxOutputTokens),
		stop: Array.isArray(setting.stop) && setting.stop.length > 0 ? setting.stop : undefined,
		extraBody: setting.extraBody && Object.keys(setting.extraBody).length > 0
			? setting.extraBody
			: undefined,
		requestHeaders: setting.requestHeaders ?? {},
	};
}

function normalizeThinking(thinking: ThinkingConfig | undefined): ThinkingConfig | undefined {
	if (!thinking || thinking.style === 'none' || !thinking.style) {
		return undefined;
	}
	return {
		style: thinking.style,
		supportedEfforts:
			Array.isArray(thinking.supportedEfforts) && thinking.supportedEfforts.length > 0
				? thinking.supportedEfforts
				: ['low', 'medium', 'high'],
		defaultEffort: thinking.defaultEffort ?? thinking.supportedEfforts?.[0] ?? 'medium',
		canDisable: thinking.canDisable !== false,
		budgetTokens: positive(thinking.budgetTokens),
		effortBudgets: thinking.effortBudgets,
		extraBody: thinking.extraBody,
	};
}

function positive(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function numberOrUndefined(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
