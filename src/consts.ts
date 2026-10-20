/**
 * 编译期常量（不依赖 VS Code 运行时）。
 */

/** VS Code 配置节前缀 */
export const CONFIG_SECTION = '4sapi-copilot';

/** SecretStorage 中保存 API Key 的键名 */
export const API_KEY_SECRET = '4sapi-copilot.apiKey';

/** 4SAPI 官方接入地址（可在国内/海外域名间切换） */
export const DEFAULT_BASE_URL = 'https://4sapi.com/v1';

/** 4SAPI 控制台地址 */
export const EXTERNAL_URLS = {
	home: 'https://4sapi.apifox.cn/',
	console: 'https://4sapi.com/',
} as const;

// VS Code 未公开的内部 System 角色枚举值。
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

/** anthropic 思考风格的默认预算（effort → budget_tokens） */
export const DEFAULT_ANTHROPIC_EFFORT_BUDGETS: Record<string, number> = {
	none: 0,
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	max: 32768,
};

/** 未配置时的默认上下文长度 / 最大输出 */
export const DEFAULT_MAX_INPUT_TOKENS = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
