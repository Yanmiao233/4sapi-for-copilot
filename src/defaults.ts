import type { PricingSnapshot, ThinkingConfig } from './types';

/**
 * 按模型名与倍率表元数据推导默认参数。
 * 倍率表（`/api/pricing`）提供 `tags`（上下文规格 / 多模态）、`vendor_id`；
 * 上下文长度从这里推导，思考协议按模型族启发式推断。
 * 这些只是「可用的起点」，用户可在 `4sapi-copilot.keys[].modelOverrides` 中覆盖。
 */
export interface ModelDefaults {
	family: string;
	/** 倍率表 `tags` 声明的完整上下文窗口（输入 + 输出） */
	contextWindow: number | undefined;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	imageInput: boolean;
	thinking: ThinkingConfig | undefined;
	/** 供应商名，来自倍率表 */
	vendor: string;
}

const TAG_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
	{ pattern: /^(\d+(?:\.\d+)?)M$/iu, tokens: 1048576 },
	{ pattern: /^(\d+(?:\.\d+)?)K$/iu, tokens: 1024 },
];

/** 模型族的默认完整上下文窗口与最大输出（倍率表无规格标签时的兜底） */
const FAMILY_WINDOWS: Record<string, { window: number; maxOutput: number }> = {
	claude: { window: 200000, maxOutput: 64000 },
	gpt: { window: 200000, maxOutput: 64000 },
	gemini: { window: 1048576, maxOutput: 65536 },
	deepseek: { window: 131072, maxOutput: 65536 },
	qwen: { window: 131072, maxOutput: 32768 },
	'4sapi': { window: 128000, maxOutput: 32768 },
};

export function deriveModelDefaults(modelId: string, snapshot?: PricingSnapshot): ModelDefaults {
	const lower = modelId.toLowerCase();
	const entry = snapshot?.models[modelId];
	const vendor = entry && snapshot ? snapshot.vendors[entry.vendorId] ?? '' : '';
	const imageInput = Boolean(entry?.tags.some((tag) => tag.includes('多模态')));
	// 4SAPI 倍率表的 tags 里带上下文规格（如 "1M" / "200K"），比按模型名猜更准确
	const taggedWindow = contextWindowFromTags(entry?.tags ?? []);

	const family = inferFamily(lower);
	const familyWindow = FAMILY_WINDOWS[family] ?? FAMILY_WINDOWS['4sapi'];
	const contextWindow = taggedWindow ?? familyWindow.window;
	const maxOutputTokens = familyWindow.maxOutput;

	return {
		family,
		contextWindow,
		// 标签给出的是完整窗口，输入上限需扣掉输出预算
		maxInputTokens: Math.max(1, contextWindow - maxOutputTokens),
		maxOutputTokens,
		toolCalling: true,
		imageInput,
		thinking: defaultThinking(family),
		vendor,
	};
}

function inferFamily(lower: string): string {
	if (lower.includes('claude')) {
		return 'claude';
	}
	if (lower.includes('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
		return 'gpt';
	}
	if (lower.includes('gemini')) {
		return 'gemini';
	}
	if (lower.includes('deepseek')) {
		return 'deepseek';
	}
	if (
		lower.includes('qwen') ||
		lower.includes('glm') ||
		lower.includes('kimi') ||
		lower.includes('moonshot') ||
		lower.includes('doubao')
	) {
		return 'qwen';
	}
	return '4sapi';
}

function defaultThinking(family: string): ThinkingConfig | undefined {
	switch (family) {
		case 'claude':
			return anthropicThinking(['low', 'medium', 'high', 'max'], 'high');
		case 'gpt':
			return openaiThinking(['minimal', 'low', 'medium', 'high'], 'medium');
		case 'gemini':
			return openaiThinking(['low', 'medium', 'high'], 'medium');
		case 'deepseek':
			return deepseekThinking(['low', 'high', 'max'], 'high');
		case 'qwen':
			return openaiThinking(['low', 'medium', 'high'], 'medium');
		default:
			return undefined;
	}
}

/** `["1M","文本","多模态"]` → `1048576`（无规格标签时为 undefined） */
export function contextWindowFromTags(tags: string[]): number | undefined {
	for (const tag of tags) {
		for (const { pattern, tokens } of TAG_CONTEXT_WINDOWS) {
			const matched = pattern.exec(tag);
			if (matched) {
				return Math.round(Number(matched[1]) * tokens);
			}
		}
	}
	return undefined;
}

export function openaiThinking(efforts: string[], def: string): ThinkingConfig {
	return { style: 'openai', supportedEfforts: efforts, defaultEffort: def, canDisable: true };
}

export function deepseekThinking(efforts: string[], def: string): ThinkingConfig {
	return { style: 'deepseek', supportedEfforts: efforts, defaultEffort: def, canDisable: true };
}

export function anthropicThinking(efforts: string[], def: string): ThinkingConfig {
	return {
		style: 'anthropic',
		supportedEfforts: efforts,
		defaultEffort: def,
		canDisable: true,
		effortBudgets: { low: 4096, medium: 8192, high: 16384, max: 32768 },
	};
}

/** 生成写入 settings.json 的模型参数模板（供用户手改） */
export function describeDefaults(defaults: ModelDefaults): string {
	return [
		`${defaults.contextWindow ?? defaults.maxInputTokens}/${defaults.maxOutputTokens} tokens`,
		defaults.thinking ? `思考:${defaults.thinking.style}` : '无思考',
	].join(' · ');
}
