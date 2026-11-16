import vscode from 'vscode';
import { logger } from './logger';
import type { ChatUsage } from './types';

/**
 * 一次请求的用量快照（已归一化）。
 *
 * 为什么需要自己做统计：VS Code 内置的 usage 数据部件解码器只读取
 * `prompt_tokens` / `completion_tokens` / `completion_tokens_details.reasoning_tokens`，
 * **丢弃了 `prompt_tokens_details.cached_tokens`**（见 VS Code 1.146
 * `AgentHostByokLmHandler#_decodeUsage`）。因此 BYOK 模型的
 * 「Response details」里永远不会出现 “Cached input tokens” 一行，
 * 扩展侧能做的是把缓存命中率显示在状态栏 / 日志 / 统计命令里。
 */
export interface UsageRecord {
	at: number;
	model: string;
	keyAlias: string;
	group: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	/** 0–1；promptTokens 为 0 时为 0 */
	cacheHitRate: number;
	durationMs: number;
}

export interface NormalizedUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cacheHitRate: number;
}

/** 把各家不同写法的 usage 归一化，并算出缓存命中率 */
export function normalizeUsage(usage: ChatUsage): NormalizedUsage {
	const promptTokens = positiveInt(usage.prompt_tokens);
	const completionTokens = positiveInt(usage.completion_tokens);
	const cachedTokens = Math.min(
		promptTokens,
		firstNumber(
			usage.prompt_tokens_details?.cached_tokens,
			usage.prompt_cache_hit_tokens,
			usage.cached_tokens,
			usage.cache_read_input_tokens,
		),
	);
	return {
		promptTokens,
		completionTokens,
		totalTokens: positiveInt(usage.total_tokens) || promptTokens + completionTokens,
		cachedTokens,
		reasoningTokens: firstNumber(usage.completion_tokens_details?.reasoning_tokens),
		cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
	};
}

/** `6016 / 6022` → `99.9%` */
export function formatHitRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) {
		return '0%';
	}
	const percent = rate * 100;
	return `${percent >= 99.95 ? '100' : percent.toFixed(1)}%`;
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1000) {
		return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
	}
	return String(value);
}

/**
 * 用量统计：内存中保留最近若干次请求，并把缓存命中率显示在状态栏。
 * 因为 Copilot 的「Response details」无法显示缓存数据，这是唯一不污染
 * 聊天内容就能看到命中率的途径。
 */
export class UsageStats {
	private readonly statusItem: vscode.StatusBarItem;
	private readonly records: UsageRecord[] = [];
	private readonly maxRecords = 50;
	private hidden = true;

	constructor(private readonly showInStatusBar: () => boolean) {
		this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
		this.statusItem.command = '4sapi-copilot.showUsageStats';
		this.statusItem.name = '4SAPI 缓存命中率';
		this.statusItem.text = '$(pulse) 4SAPI';
		this.statusItem.tooltip = '4SAPI：等待首次请求…';
	}

	record(input: Omit<UsageRecord, 'at' | 'cacheHitRate' | 'reasoningTokens'> & {
		reasoningTokens?: number;
	}): UsageRecord {
		const promptTokens = input.promptTokens;
		const record: UsageRecord = {
			...input,
			reasoningTokens: input.reasoningTokens ?? 0,
			at: Date.now(),
			cacheHitRate: promptTokens > 0 ? input.cachedTokens / promptTokens : 0,
		};
		this.records.push(record);
		if (this.records.length > this.maxRecords) {
			this.records.shift();
		}
		this.render();
		return record;
	}

	get last(): UsageRecord | undefined {
		return this.records[this.records.length - 1];
	}

	/** 会话累计（用于统计命令） */
	summary(): {
		requests: number;
		promptTokens: number;
		completionTokens: number;
		cachedTokens: number;
		cacheHitRate: number;
	} {
		let promptTokens = 0;
		let completionTokens = 0;
		let cachedTokens = 0;
		for (const record of this.records) {
			promptTokens += record.promptTokens;
			completionTokens += record.completionTokens;
			cachedTokens += record.cachedTokens;
		}
		return {
			requests: this.records.length,
			promptTokens,
			completionTokens,
			cachedTokens,
			cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
		};
	}

	recent(): readonly UsageRecord[] {
		return this.records;
	}

	/** 配置变化时刷新显示 */
	refreshVisibility(): void {
		this.render();
	}

	dispose(): void {
		this.statusItem.dispose();
	}

	private render(): void {
		if (!this.showInStatusBar()) {
			if (!this.hidden) {
				this.statusItem.hide();
				this.hidden = true;
			}
			return;
		}
		const last = this.last;
		if (!last) {
			this.statusItem.hide();
			this.hidden = true;
			return;
		}
		this.statusItem.text = `$(pulse) 缓存 ${formatHitRate(last.cacheHitRate)}`;
		this.statusItem.tooltip = new vscode.MarkdownString(
			[
				`**4SAPI 最近一次请求**`,
				'',
				`模型：\`${last.model}\``,
				`Key：${last.keyAlias} · 分组 ${last.group}`,
				'',
				'| 项目 | 数量 |',
				'| --- | --- |',
				`| 输入 token | ${last.promptTokens.toLocaleString()} |`,
				`| 命中缓存 | ${last.cachedTokens.toLocaleString()}（**${formatHitRate(last.cacheHitRate)}**） |`,
				`| 输出 token | ${last.completionTokens.toLocaleString()} |`,
				`| 其中思考 | ${last.reasoningTokens.toLocaleString()} |`,
				`| 耗时 | ${(last.durationMs / 1000).toFixed(2)}s |`,
				'',
				'点击查看统计详情（Copilot 的 Response details 不显示缓存字段）',
			].join('\n'),
		);
		this.statusItem.show();
		this.hidden = false;
	}
}

/** 记录一次用量并写日志（命中率同时进日志，便于事后排查） */
export function logUsage(record: UsageRecord): void {
	logger.info(
		`用量 ${record.model}`,
		`prompt=${record.promptTokens}`,
		`cached=${record.cachedTokens}(${formatHitRate(record.cacheHitRate)})`,
		`completion=${record.completionTokens}`,
		record.reasoningTokens > 0 ? `reasoning=${record.reasoningTokens}` : '',
		`耗时=${record.durationMs}ms`,
	);
}

function firstNumber(...values: Array<number | undefined>): number {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
			return value;
		}
	}
	return 0;
}

function positiveInt(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
