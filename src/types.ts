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

/** 解析完默认值后的内部模型定义 */
export interface ResolvedModel {
	id: string;
	apiModelId: string;
	name: string;
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
