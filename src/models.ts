import vscode from 'vscode';
import { DEFAULT_ANTHROPIC_EFFORT_BUDGETS } from './consts';
import type { ChatRequest, ResolvedModel, ThinkingConfig } from './types';

/**
 * NOTE: `configurationSchema` / `isBYOK` / `isUserSelectable` / `statusIcon`
 * 不是 @types/vscode 的稳定字段，但与 GitHub Copilot Chat 渲染模型选择器
 * 元数据和"思考深度"下拉框所消费的结构一致（参考 Vizards/deepseek-v4-for-copilot）。
 */
export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isBYOK: true;
	readonly isUserSelectable: true;
	readonly statusIcon?: vscode.ThemeIcon;
	readonly configurationSchema?: ReturnType<typeof buildThinkingEffortSchema>;
};

/** 请求级思考深度来源：Copilot 模型选择器的配置项 */
export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelOptions?: Record<string, unknown>;
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

/** 把解析后的模型转成 Copilot 模型选择器条目 */
export function toChatInfo(model: ResolvedModel, hasApiKey: boolean): ModelPickerChatInformation {
	return {
		id: model.id,
		name: model.name,
		family: model.family,
		version: model.version,
		detail: hasApiKey ? model.detail : '需要先配置 4SAPI API Key',
		tooltip: hasApiKey
			? `${model.detail}\n上下文长度: ${model.maxInputTokens.toLocaleString()} · 最大输出: ${model.maxOutputTokens.toLocaleString()}`
			: '运行命令「4SAPI: 设置 API Key」',
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
		capabilities: {
			toolCalling: model.toolCalling,
			imageInput: model.imageInput,
		},
		isBYOK: true,
		isUserSelectable: true,
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		...(model.thinking ? { configurationSchema: buildThinkingEffortSchema(model.thinking) } : {}),
	} as ModelPickerChatInformation;
}

/** 生成"思考深度"下拉框的 schema（Copilot 模型选择器渲染） */
export function buildThinkingEffortSchema(thinking: ThinkingConfig) {
	const efforts = [
		...(thinking.canDisable ? (['none'] as const) : []),
		...(thinking.supportedEfforts ?? []),
	];

	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: '思考深度',
				enum: efforts,
				enumItemLabels: efforts.map((effort) => EFFORT_LABELS[effort] ?? effort),
				enumDescriptions: efforts.map((effort) => EFFORT_DESCRIPTIONS[effort] ?? effort),
				default: thinking.defaultEffort ?? efforts[0],
				group: 'navigation',
			},
		},
	} as const;
}

const EFFORT_LABELS: Record<string, string> = {
	none: '关闭思考',
	minimal: '极简',
	low: '低',
	medium: '中',
	high: '高',
	max: '极限',
	xhigh: '超高',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
	none: '完全关闭思考模式，响应最快',
	minimal: '极少量思考',
	low: '轻度思考，适合简单任务',
	medium: '平衡思考深度与速度',
	high: '深度思考，适合复杂推理',
	max: '最大思考预算，最慢也最贵',
	xhigh: '超高思考深度',
};

/** 解析本次请求实际生效的思考深度 */
export function getConfiguredThinkingEffort(
	options: ModelConfigurationOptions,
	thinking: ThinkingConfig,
): string {
	const configured =
		options.modelOptions?.reasoningEffort ??
		options.modelConfiguration?.reasoningEffort ??
		options.configuration?.reasoningEffort;

	if (configured === 'none') {
		return thinking.canDisable ? 'none' : thinking.defaultEffort ?? 'medium';
	}
	if (typeof configured === 'string' && thinking.supportedEfforts?.includes(configured)) {
		return configured;
	}
	return thinking.defaultEffort ?? thinking.supportedEfforts?.[0] ?? 'medium';
}

/**
 * 按模型的思考协议把深度档位映射进请求体：
 * - openai   → 顶层 `reasoning_effort`（none → minimal 或省略）
 * - deepseek → `thinking:{type}` + `reasoning_effort`
 * - anthropic→ `thinking:{type,budget_tokens}`（effort → 预算映射）
 * - custom   → 仅靠 extraBody（支持 {{effort}} 占位符）
 */
export function applyThinking(
	request: ChatRequest,
	thinking: ThinkingConfig,
	effort: string,
): void {
	const disabled = effort === 'none';

	switch (thinking.style) {
		case 'openai': {
			if (disabled) {
				const mapped = thinking.supportedEfforts?.includes('minimal') ? 'minimal' : undefined;
				if (mapped) {
					request.reasoning_effort = mapped;
				}
			} else {
				request.reasoning_effort = effort;
			}
			break;
		}
		case 'deepseek': {
			request.thinking = { type: disabled ? 'disabled' : 'enabled' };
			if (!disabled) {
				request.reasoning_effort = effort;
			}
			break;
		}
		case 'anthropic': {
			if (disabled) {
				request.thinking = { type: 'disabled' };
			} else {
				const budget =
					thinking.effortBudgets?.[effort] ??
					thinking.budgetTokens ??
					DEFAULT_ANTHROPIC_EFFORT_BUDGETS[effort] ??
					DEFAULT_ANTHROPIC_EFFORT_BUDGETS.medium;
				request.thinking = { type: 'enabled', budget_tokens: budget };
			}
			break;
		}
		case 'custom':
		default:
			// custom 由 extraBody 表达（{{effort}} 占位符在 mergeExtraBody 中替换）
			break;
	}
}

/** 递归合并 extraBody 到请求体，字符串中的 {{effort}} 替换为当前深度 */
export function mergeExtraBody(
	target: ChatRequest,
	extra: Record<string, unknown> | undefined,
	effort: string,
): void {
	if (!extra) {
		return;
	}
	for (const [key, value] of Object.entries(extra)) {
		target[key] = substituteEffort(value, effort);
	}
}

function substituteEffort(value: unknown, effort: string): unknown {
	if (typeof value === 'string') {
		return value.split('{{effort}}').join(effort);
	}
	if (Array.isArray(value)) {
		return value.map((item) => substituteEffort(item, effort));
	}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = substituteEffort(item, effort);
		}
		return result;
	}
	return value;
}

// ---- token 估算（chars/4 启发式 + 用量校准） ----

export function estimateTokens(text: string, charsPerToken: number): number {
	if (!text) {
		return 0;
	}
	return Math.max(1, Math.round(text.length / Math.max(1, charsPerToken)));
}

/** 用 API 上报的真实 prompt_tokens 校准 chars/token 比（EMA） */
export function calibrateCharsPerToken(
	requestChars: number,
	promptTokens: number,
	current: number,
): number {
	if (requestChars > 0 && promptTokens > 0) {
		const observed = requestChars / promptTokens;
		return current * 0.7 + observed * 0.3;
	}
	return current;
}
