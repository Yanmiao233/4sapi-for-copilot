import type { PricingModelEntry, PricingSnapshot } from './types';

/** `https://4sapi.com/v1` → `https://4sapi.com/api/pricing` */
export function pricingUrl(baseUrl: string): string {
	const origin = baseUrl.replace(/\/+$/u, '').replace(/\/v1$/u, '');
	return `${origin}/api/pricing`;
}

/**
 * 拉取 4SAPI 公开倍率表 `GET /api/pricing`（无需鉴权）。
 * 返回的分组倍率即控制台展示的「分组倍率」，模型消耗倍率 = 其所属分组的倍率。
 */
export async function fetchPricing(baseUrl: string, timeoutMs = 15000): Promise<PricingSnapshot> {
	const url = pricingUrl(baseUrl);
	const response = await fetch(url, {
		method: 'GET',
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`拉取倍率表失败（HTTP ${response.status}）：${url}`);
	}
	const payload = (await response.json()) as RawPricingPayload;
	return normalizePricing(payload);
}

/** `/api/pricing` 的原始返回结构 */
export interface RawPricingPayload {
	success?: boolean;
	pricing_version?: string;
	group_ratio?: Record<string, number>;
	usable_group?: Record<string, string>;
	vendors?: Array<{ id?: number; name?: string }>;
	data?: Array<{
		model_name?: string;
		model_ratio?: number;
		completion_ratio?: number;
		model_price?: number;
		quota_type?: number;
		enable_groups?: string[];
		tags?: string;
		supported_endpoint_types?: string[];
		vendor_id?: number;
		description?: string;
	}>;
}

export function normalizePricing(payload: RawPricingPayload): PricingSnapshot {
	const models: Record<string, PricingModelEntry> = {};
	for (const item of payload.data ?? []) {
		const modelName = item.model_name?.trim();
		if (!modelName) {
			continue;
		}
		models[modelName] = {
			modelName,
			modelRatio: numberOr(item.model_ratio, 0),
			completionRatio: numberOr(item.completion_ratio, 1),
			modelPrice: numberOr(item.model_price, -1),
			quotaType: numberOr(item.quota_type, 0),
			enableGroups: item.enable_groups ?? [],
			tags: (item.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
			supportedEndpoints: item.supported_endpoint_types ?? [],
			vendorId: numberOr(item.vendor_id, 0),
			description: item.description ?? '',
		};
	}

	const vendors: Record<number, string> = {};
	for (const vendor of payload.vendors ?? []) {
		if (typeof vendor.id === 'number' && vendor.name) {
			vendors[vendor.id] = vendor.name;
		}
	}

	const groupRatio: Record<string, number> = {};
	for (const [group, ratio] of Object.entries(payload.group_ratio ?? {})) {
		if (group !== 'standard-relay' && typeof ratio === 'number' && Number.isFinite(ratio)) {
			groupRatio[group] = ratio;
		}
	}

	const groups: Record<string, string> = {};
	for (const [group, description] of Object.entries(payload.usable_group ?? {})) {
		if (group !== 'standard-relay') {
			groups[group] = description;
		}
	}

	return {
		version: payload.pricing_version ?? '',
		fetchedAt: Date.now(),
		groupRatio,
		groups,
		vendors,
		models,
	};
}

const NON_CHAT_TAGS = ['图像', '视频', '音频', '向量', '嵌入', '语音'];

/**
 * 是否为可聊天模型：提供 OpenAI 兼容或 Anthropic 端点，且不是图像 / 视频 / 音频 / 向量模型。
 * 倍率表里查不到的模型（新上线等）视为可聊天，倍率按未知处理。
 */
export function isChatModel(snapshot: PricingSnapshot, modelId: string): boolean {
	const entry = snapshot.models[modelId];
	if (!entry) {
		return true;
	}
	if (entry.tags.some((tag) => NON_CHAT_TAGS.some((skip) => tag.includes(skip)))) {
		return false;
	}
	if (entry.supportedEndpoints.length === 0) {
		return true;
	}
	return entry.supportedEndpoints.includes('openai') || entry.supportedEndpoints.includes('anthropic');
}

/** 模型在指定分组下的消耗倍率（= 分组倍率）；分组无倍率条目或查不到时为 undefined */
export function modelRatio(
	snapshot: PricingSnapshot | undefined,
	modelId: string,
	group: string,
): number | undefined {
	if (!snapshot) {
		return undefined;
	}
	const ratio = snapshot.groupRatio[group];
	if (typeof ratio === 'number') {
		return ratio;
	}
	// 分组不在倍率表中：模型支持该分组时按 1x（无倍率）处理，否则视为未知
	const entry = snapshot.models[modelId];
	if (entry?.enableGroups.includes(group)) {
		return 1;
	}
	return undefined;
}

/** `0.8` → `0.8x`，`2` → `2x`，`0.375` → `0.375x` */
export function formatRatio(ratio: number | undefined): string {
	if (ratio === undefined || !Number.isFinite(ratio)) {
		return '倍率未知';
	}
	return `${Number(ratio.toFixed(4))}x`;
}

/** 添加 Key 时可选的分组（仅真实可用分组：有倍率条目） */
export interface GroupOption {
	group: string;
	/** 分组倍率；`undefined` 表示倍率表未提供（手动输入时的「未知」） */
	ratio: number | undefined;
	description: string;
	/** 该 Key 在此分组下可用、且能聊天的模型数 */
	modelCount: number;
}

/**
 * 推断某个 Key 可绑定的分组。
 * `/v1/models` 返回的模型已按 Key 自身权限过滤，故「这些模型共同支持的分组」即该 Key 的分组。
 * 只保留倍率表中的真实分组（`standard-relay` 等展示用分组会被排除）。
 */
export function listGroups(snapshot: PricingSnapshot, liveModelIds: string[]): GroupOption[] {
	const chatModels = liveModelIds.filter((modelId) => isChatModel(snapshot, modelId));

	// 统计每个真实分组覆盖了多少个该 Key 可用的模型
	const covered = new Map<string, number>();
	for (const modelId of chatModels) {
		const entry = snapshot.models[modelId];
		if (!entry) {
			continue;
		}
		for (const group of entry.enableGroups) {
			if (!(group in snapshot.groupRatio)) {
				continue;
			}
			covered.set(group, (covered.get(group) ?? 0) + 1);
		}
	}

	// 倍率表中查不到倍率的模型无法归属分组；若一个分组都推不出来，则退化为列出全部分组
	if (covered.size === 0) {
		const unknown = chatModels.filter((modelId) => !snapshot.models[modelId]).length;
		if (unknown > 0) {
			for (const group of Object.keys(snapshot.groupRatio)) {
				covered.set(group, unknown);
			}
		}
	}

	return [...covered.entries()]
		.map(([group, modelCount]) => ({
			group,
			ratio: snapshot.groupRatio[group] as number | undefined,
			description: snapshot.groups[group] ?? '',
			modelCount,
		}))
		.sort(
			(left, right) =>
				right.modelCount - left.modelCount ||
				(left.ratio ?? Number.POSITIVE_INFINITY) - (right.ratio ?? Number.POSITIVE_INFINITY),
		);
}

/** 列出倍率表中全部真实分组（推断不出时让用户自己选） */
export function allGroups(snapshot: PricingSnapshot): GroupOption[] {
	return Object.entries(snapshot.groupRatio)
		.map(([group, ratio]) => ({
			group,
			ratio,
			description: snapshot.groups[group] ?? '',
			modelCount: 0,
		}))
		.sort((left, right) => left.ratio - right.ratio);
}

/** 该 Key 在指定分组下可用、且能聊天的模型 */
export function modelsForGroup(
	snapshot: PricingSnapshot,
	liveModelIds: string[],
	group: string,
): string[] {
	return liveModelIds
		.filter((modelId) => isChatModel(snapshot, modelId))
		.filter((modelId) => {
			const entry = snapshot.models[modelId];
			// 倍率表里查不到的模型无法判断分组，保守放行
			return !entry || entry.enableGroups.includes(group);
		})
		.sort();
}

/**
 * 可选模型候选：有分组时按分组过滤；分组未知（旧配置迁移等）时只按「可聊天」过滤。
 * 倍率表不可用时退化为该 Key 的原始模型列表。
 */
export function candidateModels(
	snapshot: PricingSnapshot | undefined,
	liveModelIds: string[],
	group: string,
): string[] {
	if (!snapshot) {
		return [...liveModelIds].sort();
	}
	return group
		? modelsForGroup(snapshot, liveModelIds, group)
		: liveModelIds.filter((modelId) => isChatModel(snapshot, modelId)).sort();
}

/** 拉取倍率表的结果：`error` 非空表示本次刷新失败（可能仍返回缓存快照） */
export interface LoadPricingResult {
	snapshot: PricingSnapshot | undefined;
	error?: string;
}

export async function loadPricing(
	baseUrl: string,
	readCache: () => PricingSnapshot | undefined,
	writeCache: (snapshot: PricingSnapshot) => Promise<void>,
	options: { force?: boolean; ttlMs?: number } = {},
): Promise<LoadPricingResult> {
	const cached = readCache();
	const ttl = options.ttlMs ?? Number.POSITIVE_INFINITY;
	const fresh = cached && Date.now() - cached.fetchedAt < ttl;

	if (cached && fresh && !options.force) {
		return { snapshot: cached };
	}

	try {
		const snapshot = await fetchPricing(baseUrl);
		if (cached && snapshot.version && snapshot.version === cached.version) {
			return { snapshot: cached };
		}
		await writeCache(snapshot);
		return { snapshot };
	} catch (error) {
		return { snapshot: cached, error: error instanceof Error ? error.message : String(error) };
	}
}

function numberOr(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
