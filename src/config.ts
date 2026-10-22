import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';
import { deriveModelDefaults } from './defaults';
import { logger } from './logger';
import { formatRatio, modelRatio } from './pricing';
import type {
	KeySetting,
	PricingSnapshot,
	ResolvedKey,
	ResolvedModel,
	ThinkingConfig,
} from './types';

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

/** settings.json 中配置的 API Key 元数据 */
export function getKeySettings(): KeySetting[] {
	const raw = getConfig().get<KeySetting[]>('keys', []);
	return (Array.isArray(raw) ? raw : []).filter(
		(key) => key && typeof key.id === 'string' && key.id.trim().length > 0,
	);
}

/** 把 Key 条目解析为带完整默认值的内部定义 */
export function resolveKeys(settings: KeySetting[] = getKeySettings()): ResolvedKey[] {
	return settings
		.filter((key) => key.enabled !== false)
		.map((key) => ({
			id: key.id.trim(),
			alias: key.alias?.trim() || key.group?.trim() || key.id.trim(),
			group: key.group?.trim() || '',
			groupRatio: key.groupRatio,
			models: Array.isArray(key.models) ? key.models.filter((id) => id?.trim()) : [],
			modelOverrides: key.modelOverrides ?? {},
		}));
}

/**
 * 把一个 Key 的模型解析为带完整默认值的内部定义。
 * 参数优先级：`keys[].modelOverrides[modelId]` > 倍率表元数据（上下文规格 / 模型族）> 全局默认值。
 * 选择器 ID 带 Key 前缀（`<keyId>/<modelId>`），因此不同 Key 下同名模型不会冲突，
 * 显示名带分组与消耗倍率（如 `claude-sonnet-4-6 (5x, claude-官方)`），便于区分同名但倍率不同的模型。
 */
export function resolveModelsForKey(
	key: ResolvedKey,
	pricing: PricingSnapshot | undefined,
): ResolvedModel[] {
	const globalMaxTokens = getGlobalMaxTokens();

	return key.models.map((modelId) => {
		const override = key.modelOverrides[modelId] ?? {};
		const defaults = deriveModelDefaults(modelId, pricing);
		if (pricing && !pricing.models[modelId]) {
			logger.debug('倍率表中查不到该模型，使用模型族默认参数（可手动覆盖）:', modelId);
		}

		const maxOutputTokens = positive(override.maxOutputTokens) ?? defaults.maxOutputTokens;
		const contextWindow = positive(override.contextWindow);
		const maxInputTokens =
			positive(override.maxInputTokens) ??
			(contextWindow ? contextWindow - maxOutputTokens : undefined) ??
			defaults.maxInputTokens;

		const modelMaxTokens = positive(override.maxTokens);
		// 倍率来自公开倍率表；表不可用（离线）时退回该 Key 在配置中缓存的倍率
		const ratio = modelRatio(pricing, modelId, key.group) ?? key.groupRatio;
		const suffix = [ratio === undefined ? '' : formatRatio(ratio), key.group]
			.filter(Boolean)
			.join(', ');
		const displayName = override.name?.trim() || `${modelId} (${suffix || key.alias})`;

		return {
			id: `${key.id}/${modelId}`,
			apiModelId: override.apiModelId?.trim() || modelId,
			name: displayName,
			keyId: key.id,
			keyAlias: key.alias,
			group: key.group,
			groupRatio: ratio,
			family: override.family?.trim() || defaults.family,
			version: override.version?.trim() ?? '',
			detail:
				override.detail?.trim() ||
				[defaults.vendor, `分组 ${key.group} · ${formatRatio(ratio)}`, key.alias]
					.filter(Boolean)
					.join(' · '),
			maxInputTokens,
			maxOutputTokens,
			toolCalling: override.toolCalling ?? defaults.toolCalling,
			imageInput: override.imageInput ?? defaults.imageInput,
			thinking: normalizeThinking(override.thinking ?? defaults.thinking),
			temperature: numberOrUndefined(override.temperature),
			topP: numberOrUndefined(override.topP),
			maxTokens: modelMaxTokens ?? (globalMaxTokens > 0 ? globalMaxTokens : maxOutputTokens),
			stop: Array.isArray(override.stop) && override.stop.length > 0 ? override.stop : undefined,
			extraBody:
				override.extraBody && Object.keys(override.extraBody).length > 0
					? override.extraBody
					: undefined,
			requestHeaders: override.requestHeaders ?? {},
		};
	});
}

/** 全部 Key 的全部模型（跨 Key 展平） */
export function resolveAllModels(
	pricing: PricingSnapshot | undefined,
	settings: KeySetting[] = getKeySettings(),
): ResolvedModel[] {
	return resolveKeys(settings).flatMap((key) => resolveModelsForKey(key, pricing));
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

