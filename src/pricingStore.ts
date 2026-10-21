import vscode from 'vscode';
import { PRICING_CACHE_KEY, PRICING_CACHE_TTL_MS } from './consts';
import { loadPricing } from './pricing';
import type { PricingSnapshot } from './types';

/** 倍率表刷新结果：`error` 非空表示本次未取到最新数据（可能仍返回缓存快照） */
export interface PricingRefreshResult {
	snapshot: PricingSnapshot | undefined;
	error?: string;
}

/**
 * 倍率表（`GET /api/pricing`）的内存 + globalState 双层缓存。
 * 避免每次刷新模型选择器都请求网络，并在离线 / 接口异常时降级到最近一次快照。
 */
export class PricingStore {
	private snapshot: PricingSnapshot | undefined;
	private inflight: Promise<PricingRefreshResult> | undefined;

	constructor(private readonly globalState: vscode.Memento) {
		this.snapshot = readCache(globalState);
	}

	get(): PricingSnapshot | undefined {
		return this.snapshot;
	}

	/** 缓存过期时刷新；未过期则直接返回缓存 */
	async ensure(
		baseUrl: string,
		options: { force?: boolean } = {},
	): Promise<PricingSnapshot | undefined> {
		const stale = !this.snapshot || Date.now() - this.snapshot.fetchedAt > PRICING_CACHE_TTL_MS;
		if (!options.force && !stale) {
			return this.snapshot;
		}
		return (await this.reload(baseUrl, options)).snapshot;
	}

	/** 拉取倍率表并返回刷新结果（并发调用复用同一个请求） */
	async reload(baseUrl: string, options: { force?: boolean } = {}): Promise<PricingRefreshResult> {
		if (this.inflight) {
			return this.inflight;
		}
		this.inflight = loadPricing(
			baseUrl,
			() => this.snapshot,
			async (snapshot) => {
				this.snapshot = snapshot;
				await this.globalState.update(PRICING_CACHE_KEY, snapshot);
			},
			{ force: options.force ?? true, ttlMs: PRICING_CACHE_TTL_MS },
		);
		try {
			return await this.inflight;
		} finally {
			this.inflight = undefined;
		}
	}
}

function readCache(state: vscode.Memento): PricingSnapshot | undefined {
	const cached = state.get<PricingSnapshot>(PRICING_CACHE_KEY);
	if (
		!cached ||
		typeof cached.version !== 'string' ||
		!cached.models ||
		!cached.groupRatio ||
		!cached.groups ||
		!cached.vendors
	) {
		return undefined;
	}
	return cached;
}
