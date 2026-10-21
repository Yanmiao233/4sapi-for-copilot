/**
 * 编译期常量（不依赖 VS Code 运行时）。
 */

/** VS Code 配置节前缀 */
export const CONFIG_SECTION = '4sapi-copilot';

/** SecretStorage 中单个 API Key 的键名前缀（完整键名：`<前缀><keyId>`） */
export const KEY_SECRET_PREFIX = '4sapi-copilot.key.';

/** 历史版本中保存单一 API Key 的 SecretStorage 键名（迁移用） */
export const LEGACY_API_KEY_SECRET = '4sapi-copilot.apiKey';

/** globalState 中缓存 `/api/pricing` 倍率表的键名 */
export const PRICING_CACHE_KEY = '4sapi-copilot.pricingCache';

/** 已写入 settings.json 的配置数据版本（用于一次性迁移） */
export const CONFIG_DATA_VERSION_KEY = 'configDataVersion';

/** 倍率表缓存的建议有效期（毫秒）；过期后下次使用时静默刷新 */
export const PRICING_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

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
