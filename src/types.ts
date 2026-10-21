/**
 * 4SAPI for Copilot — 共享类型定义
 */

// ---- 思考（推理）配置 ----

/** 思考参数映射协议 */
export type ThinkingStyle = 'none' | 'openai' | 'deepseek' | 'anthropic' | 'custom';

export interface ThinkingConfig {
	/** 映射协议 */
	style: ThinkingStyle;
	/** 支持的思考深度档位，如 ["minimal","low","medium","high"] */
	supportedEfforts?: string[];
	/** 默认思考深度 */
	defaultEffort?: string;
	/** 是否允许把思考深度设为 none（完全关闭思考） */
	canDisable?: boolean;
	/** anthropic 风格的默认思考预算 */
	budgetTokens?: number;
	/** anthropic 风格：思考深度 → budget_tokens 映射 */
	effortBudgets?: Record<string, number>;
	/** 合并进请求体的额外参数；字符串值中的 {{effort}} 会被替换 */
	extraBody?: Record<string, unknown>;
}

// ---- settings.json 中的模型条目 ----

export interface ModelSetting {
	/** VS Code 模型选择器中的唯一 ID */
	id: string;
	/** 实际发送给 4SAPI 的模型名（缺省时 = id） */
	apiModelId?: string;
	name?: string;
	family?: string;
	version?: string;
	detail?: string;
	enabled?: boolean;
	/** 模型完整上下文窗口（输入 + 输出） */
	contextWindow?: number;
	/** 上下文长度（最大输入 token 数） */
	maxInputTokens?: number;
	/** 最大输出 token 数 */
	maxOutputTokens?: number;
	toolCalling?: boolean;
	imageInput?: boolean;
	thinking?: ThinkingConfig;
	temperature?: number;
	topP?: number;
	/** 请求体 max_tokens（缺省时取 maxOutputTokens） */
	maxTokens?: number;
	stop?: string[];
	/** 合并进请求体的额外参数（最后合并，可覆盖生成的字段） */
	extraBody?: Record<string, unknown>;
	/** 模型专属附加 HTTP 头 */
	requestHeaders?: Record<string, string>;
}

/** settings.json 中单个模型的参数覆盖（Key 驱动生成后的微调） */
export type ModelOverride = Omit<ModelSetting, 'id'>;

/**
 * settings.json 中的 API Key 元数据。
 * Key 明文只存 SecretStorage（键名 `4sapi-copilot.key.<id>`），此处不含任何机密。
 */
export interface KeySetting {
	/** 稳定 ID，用于拼接 SecretStorage 键名与模型选择器 ID */
	id: string;
	/** 用户可读别名（默认取分组名） */
	alias?: string;
	enabled?: boolean;
	/** 该 Key 绑定的 4SAPI 分组（创建 Key 时选定，一个 Key 固定一个分组） */
	group?: string;
	/** 分组倍率，来自 `/api/pricing` 的 `group_ratio` */
	groupRatio?: number;
	/** 暴露到 Copilot 模型选择器的模型名列表 */
	models?: string[];
	/** 逐模型参数覆盖（可选，缺省时按 /api/pricing 推导） */
	modelOverrides?: Record<string, ModelOverride>;
}

/** 解析完默认值后的 Key 定义 */
export interface ResolvedKey {
	id: string;
	alias: string;
	group: string;
	groupRatio: number | undefined;
	models: string[];
	modelOverrides: Record<string, ModelOverride>;
}

// ---- /api/pricing（公开倍率表） ----

export interface PricingModelEntry {
	modelName: string;
	modelRatio: number;
	completionRatio: number;
	modelPrice: number;
	quotaType: number;
	/** 该模型可用的分组 */
	enableGroups: string[];
	tags: string[];
	supportedEndpoints: string[];
	vendorId: number;
	description: string;
}

export interface PricingSnapshot {
	/** 服务端倍率表版本号，用于判断是否需要刷新 */
	version: string;
	/** 本地抓取时间（毫秒） */
	fetchedAt: number;
	/** 分组 → 倍率 */
	groupRatio: Record<string, number>;
	/** 分组 → 说明（`usable_group`，即真实可选分组） */
	groups: Record<string, string>;
	/** 厂商 id → 名称 */
	vendors: Record<number, string>;
	/** 模型 id → 条目 */
	models: Record<string, PricingModelEntry>;
}

/** 解析完默认值后的内部模型定义 */
export interface ResolvedModel {
	/** 模型选择器中的唯一 ID（含 Key 维度，避免同名模型冲突） */
	id: string;
	/** 实际发送给 4SAPI 的模型名 */
	apiModelId: string;
	/** 选择器中的显示名（含分组与消耗倍率） */
	name: string;
	/** 所属 Key */
	keyId: string;
	keyAlias: string;
	/** 所属分组与消耗倍率 */
	group: string;
	groupRatio: number | undefined;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	imageInput: boolean;
	thinking: ThinkingConfig | undefined;
	temperature: number | undefined;
	topP: number | undefined;
	maxTokens: number | undefined;
	stop: string[] | undefined;
	extraBody: Record<string, unknown> | undefined;
	requestHeaders: Record<string, string>;
}

// ---- OpenAI 兼容请求 / 响应 ----

export interface ChatTextPart {
	type: 'text';
	text: string;
}

export interface ChatImageUrlPart {
	type: 'image_url';
	image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImageUrlPart;

export interface ChatToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ChatContentPart[];
	tool_call_id?: string;
	tool_calls?: ChatToolCall[];
	/** DeepSeek 系模型的历史思考内容回填 */
	reasoning_content?: string;
}

export interface ChatTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface ChatUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	stream: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stop?: string[];
	tools?: ChatTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	/** Anthropic / DeepSeek 风格思考开关 */
	thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
	/** OpenAI / DeepSeek 风格思考深度 */
	reasoning_effort?: string;
	stream_options?: { include_usage: boolean };
	[key: string]: unknown;
}

export interface StreamChunk {
	choices?: Array<{
		index?: number;
		delta?: {
			role?: string;
			content?: string | null;
			/** DeepSeek / 部分中转 */
			reasoning_content?: string | null;
			/** 部分兼容端点 */
			reasoning?: string | null;
			thinking?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ChatUsage;
}

export interface StreamCallbacks {
	onContent: (text: string) => void;
	onThinking: (text: string) => void;
	onToolCall: (call: ChatToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: ChatUsage) => void;
}
