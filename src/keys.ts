import vscode from 'vscode';
import { ApiClient } from './client';
import { getBaseUrl, getDebugMode, getKeySettings, resolveKeys } from './config';
import { CHANNEL_NAME, logger, logLine, showLogs } from './logger';
import {
	allGroups,
	candidateModels,
	formatRatio,
	listGroups,
	pricingUrl,
	type GroupOption,
} from './pricing';
import type { PricingStore } from './pricingStore';
import type { KeySetting, PricingSnapshot } from './types';
import type { KeyVault } from './vault';

export interface KeyCommandDeps {
	vault: KeyVault;
	pricing: PricingStore;
	/** 配置或密钥变化后刷新 Copilot 模型选择器 */
	refresh(): void;
}

/** 提示倍率表无法读取（`GET /api/pricing` 失败），调用方随后会退化为手动选择分组 */
function warnPricingUnavailable(error: string): void {
	void vscode.window.showWarningMessage(
		`4SAPI: 无法获取分组倍率表（${error}），分组需手动选择，倍率显示为「倍率未知」。`,
	);
}

/** 4SAPI: 添加 API Key —— 输入 Key → 只读校验 → 选分组 → 选模型（全部确认后才落盘） */
export async function addKey(deps: KeyCommandDeps): Promise<void> {
	const apiKey = await deps.vault.promptForKey('4SAPI: 输入 API Key');
	if (!apiKey) {
		return;
	}

	let snapshot: PricingSnapshot | undefined;
	let liveModelIds: string[];
	try {
		// 倍率表刷新与 Key 校验并行，缩短整体等待
		const [pricingResult, models] = await Promise.all([
			deps.pricing.reload(getBaseUrl()),
			new ApiClient(getBaseUrl(), apiKey, {}).listModels(),
		]);
		snapshot = pricingResult.snapshot;
		liveModelIds = models;
		if (pricingResult.error && !snapshot) {
			warnPricingUnavailable(pricingResult.error);
		}
	} catch (error) {
		void vscode.window.showErrorMessage(
			`4SAPI: 无法用该 Key 获取模型列表（${error instanceof Error ? error.message : String(error)}）。请确认 Key 有效、网络可访问 ${getBaseUrl()}。`,
		);
		return;
	}
	if (liveModelIds.length === 0) {
		void vscode.window.showWarningMessage('4SAPI: 该 Key 未返回任何模型，请检查 Key 的分组与套餐权限。');
		return;
	}
	logger.info('添加 Key：候选模型', `数量=${liveModelIds.length}`);

	const group = await pickGroup(snapshot, liveModelIds);
	if (!group) {
		return;
	}

	const candidates = candidateModels(snapshot, liveModelIds, group.group);
	const models = await pickModels(candidates, snapshot, group.group, `${group.group} 分组下的模型`);
	if (models.length === 0) {
		void vscode.window.showWarningMessage('4SAPI: 未选择任何模型，已取消添加。');
		return;
	}

	const id = newKeyId();
	const alias = await pickAlias(group.group);
	const setting: KeySetting = {
		id,
		alias,
		enabled: true,
		group: group.group,
		groupRatio: group.ratio,
		models,
	};

	await deps.vault.setApiKey(id, apiKey);
	// 立即回读验证：密钥库写入失败时不能留下一个「有配置、无密钥」的坏 Key
	const persisted = await deps.vault.getApiKey(id);
	if (!persisted) {
		void vscode.window.showErrorMessage(
			'4SAPI: API Key 写入系统密钥库失败（回读为空）。Key 未添加，配置未被修改。\n' +
				'请检查系统凭据管理器是否可用，或运行「4SAPI: 诊断信息」查看详情。',
		);
		logger.error('密钥库写入后回读为空', `keyId=${id}`);
		await deps.vault.deleteApiKey(id);
		return;
	}

	const keys = [...getKeySettings(), setting];
	if (!(await saveKeys(keys))) {
		await deps.vault.deleteApiKey(id);
		return;
	}
	deps.refresh();

	void vscode.window.showInformationMessage(
		`4SAPI: 已添加 Key「${alias}」（分组 ${group.group} · ${formatRatio(group.ratio)}），暴露 ${models.length} 个模型。`,
	);
}

/** 4SAPI: 删除 API Key —— 删除密钥并清理该 Key 的全部模型 */
export async function removeKey(deps: KeyCommandDeps): Promise<void> {
	const keys = getKeySettings();
	if (keys.length === 0) {
		void vscode.window.showInformationMessage('4SAPI: 当前没有配置任何 API Key。');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		keys.map((key) => ({
			label: key.alias?.trim() || key.group || key.id,
			description: `${key.group || '未指定分组'} · ${formatRatio(key.groupRatio)} · ${(key.models ?? []).length} 个模型`,
			detail: `id: ${key.id}`,
			key,
		})),
		{ title: '选择要删除的 4SAPI API Key', placeHolder: '删除后该 Key 及其全部模型会从 Copilot 模型选择器中移除' },
	);
	if (!picked) {
		return;
	}

	const confirm = '删除';
	const confirmed = await vscode.window.showWarningMessage(
		`确定删除 Key「${picked.label}」？其密钥将从系统密钥库移除，配置中该 Key 的 ${(picked.key.models ?? []).length} 个模型也会一并删除。`,
		{ modal: true },
		confirm,
	);
	if (confirmed !== confirm) {
		return;
	}

	await deps.vault.deleteApiKey(picked.key.id);
	const remaining = keys.filter((key) => key.id !== picked.key.id);
	if (!(await saveKeys(remaining))) {
		return;
	}
	deps.refresh();
	void vscode.window.showInformationMessage(`4SAPI: 已删除 Key「${picked.label}」及其模型。`);
}

/** 4SAPI: 编辑 Key 的模型列表 —— 重新拉取该 Key 可用模型并多选 */
export async function editKeyModels(deps: KeyCommandDeps): Promise<void> {
	const key = await pickKey('选择要编辑模型列表的 4SAPI API Key');
	if (!key) {
		return;
	}

	const apiKey = await deps.vault.getApiKey(key.id);
	if (!apiKey) {
		void vscode.window.showErrorMessage(
			`4SAPI: Key「${key.alias ?? key.id}」的密钥已丢失，请删除后重新添加。`,
		);
		return;
	}

	let liveModelIds: string[];
	try {
		liveModelIds = await new ApiClient(getBaseUrl(), apiKey, {}).listModels();
	} catch (error) {
		void vscode.window.showErrorMessage(
			`4SAPI: 无法获取该 Key 的模型列表（${error instanceof Error ? error.message : String(error)}）。`,
		);
		return;
	}

	const snapshot = await deps.pricing.ensure(getBaseUrl());
	const group = key.group?.trim() ?? '';
	const candidates = candidateModels(snapshot, liveModelIds, group);
	const current = new Set(key.models ?? []);
	const models = await pickModels(
		candidates,
		snapshot,
		group,
		`${key.alias ?? key.id} 的模型`,
		(modelId) => current.has(modelId),
	);
	if (models.length === 0) {
		void vscode.window.showWarningMessage('4SAPI: 未选择任何模型，已取消。');
		return;
	}

	const keys = getKeySettings().map((item) =>
		item.id === key.id ? { ...item, models } : item,
	);
	if (!(await saveKeys(keys))) {
		return;
	}
	deps.refresh();
	void vscode.window.showInformationMessage(
		`4SAPI: Key「${key.alias ?? key.id}」现在暴露 ${models.length} 个模型。`,
	);
}

/** 4SAPI: 重命名 Key —— 修改选择器中显示用的别名 */
export async function renameKey(deps: KeyCommandDeps): Promise<void> {
	const key = await pickKey('选择要重命名的 4SAPI API Key');
	if (!key) {
		return;
	}
	const alias = await vscode.window.showInputBox({
		title: `4SAPI: 重命名 Key（当前：${key.alias ?? key.id}）`,
		prompt: '别名会显示在模型选择器的描述里，用于区分不同 Key',
		value: key.alias ?? key.group ?? key.id,
		validateInput: (value: string) => (value?.trim() ? undefined : '别名不能为空'),
	});
	if (!alias?.trim()) {
		return;
	}
	const keys = getKeySettings().map((item) =>
		item.id === key.id ? { ...item, alias: alias.trim() } : item,
	);
	if (!(await saveKeys(keys))) {
		return;
	}
	deps.refresh();
	void vscode.window.showInformationMessage(`4SAPI: Key 已重命名为「${alias.trim()}」。`);
}

/** 4SAPI: 刷新分组倍率表 —— 强制重新拉取 /api/pricing 并更新模型显示倍率 */
export async function refreshPricing(deps: KeyCommandDeps): Promise<void> {
	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: '4SAPI: 正在刷新分组倍率表…' },
		() => deps.pricing.reload(getBaseUrl(), { force: true }),
	);
	const snapshot = result.snapshot;
	if (!snapshot) {
		void vscode.window.showErrorMessage(
			`4SAPI: 无法获取倍率表（${pricingUrl(getBaseUrl())}）：${result.error ?? '未知错误'}`,
		);
		return;
	}

	// 倍率可能随分组调整，同步写回每个 Key 缓存的倍率
	const keys = getKeySettings();
	const updated = keys.map((key) => {
		const ratio = key.group ? snapshot.groupRatio[key.group] : undefined;
		return ratio === undefined ? key : { ...key, groupRatio: ratio };
	});
	const ratioChanged = updated.some((key, index) => key.groupRatio !== keys[index].groupRatio);
	if (ratioChanged) {
		await saveKeys(updated);
	}
	deps.refresh();

	const stale = result.error ? `（本次未取到最新数据：${result.error}）` : '';
	void vscode.window.showInformationMessage(
		`4SAPI: 倍率表已更新（版本 ${snapshot.version || '未知'}，共 ${Object.keys(snapshot.models).length} 个模型）${stale}`,
	);
}

/** 4SAPI: 测试连接 —— 逐个验证已配置 Key 及其模型数 */
export async function testConnections(deps: KeyCommandDeps): Promise<void> {
	const keys = resolveKeys(getKeySettings());
	if (keys.length === 0) {
		const picked = await vscode.window.showWarningMessage(
			'尚未配置任何 4SAPI API Key。',
			{ modal: true },
			'立即添加',
		);
		if (picked === '立即添加') {
			await addKey(deps);
		}
		return;
	}

	const results = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: '4SAPI: 正在测试连接…' },
		async () => {
			const lines: string[] = [];
			for (const key of keys) {
				const apiKey = await deps.vault.getApiKey(key.id);
				if (!apiKey) {
					lines.push(`✗ ${key.alias}（${key.group}）：密钥缺失，请重新添加`);
					continue;
				}
				try {
					const ids = await new ApiClient(getBaseUrl(), apiKey, {}).listModels();
					lines.push(
						`✓ ${key.alias}（${key.group} · ${formatRatio(key.groupRatio)}）：${ids.length} 个可用模型`,
					);
				} catch (error) {
					lines.push(
						`✗ ${key.alias}（${key.group}）：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return lines;
		},
	);

	const failed = results.filter((line) => line.startsWith('✗')).length;
	logger.info('连接测试:', results.join(' | '));
	// VS Code 的通知不会自动换行，先拼成多行字符串再展示
	if (failed === 0) {
		void vscode.window.showInformationMessage(`4SAPI 连接正常：\n${results.join('\n')}`);
	} else {
		void vscode.window.showWarningMessage(
			`4SAPI 连接测试：${failed} 个 Key 失败\n${results.join('\n')}`,
		);
	}
}

/** 4SAPI: 诊断信息 —— 把 Key 存储 / 配置 / 倍率表状态打到输出通道（绕开日志级别限制） */
export async function showDiagnostics(deps: KeyCommandDeps): Promise<void> {
	const settings = getKeySettings();
	const lines: string[] = [];
	lines.push('================ 4SAPI 诊断 ================');
	lines.push(`baseUrl            : ${getBaseUrl()}`);
	lines.push(`倍率表地址          : ${pricingUrl(getBaseUrl())}`);
	lines.push(`debugMode          : ${getDebugMode()}`);

	const snapshot = deps.pricing.get();
	lines.push(
		snapshot
			? `倍率表缓存          : 版本 ${snapshot.version || '未知'}，${Object.keys(snapshot.models).length} 个模型，` +
					`${Object.keys(snapshot.groupRatio).length} 个分组，抓取于 ${new Date(snapshot.fetchedAt).toLocaleString()}`
			: '倍率表缓存          : 无（可用命令「4SAPI: 刷新分组倍率表」获取）',
	);

	lines.push('');
	lines.push(`配置中的 Key 数量    : ${settings.length}`);
	if (settings.length === 0) {
		lines.push('  （没有任何 Key，请用命令「4SAPI: 添加 API Key」添加）');
	}

	for (const key of settings) {
		const apiKey = await deps.vault.getApiKey(key.id);
		lines.push('');
		lines.push(`── Key 「${key.alias?.trim() || key.id}」`);
		lines.push(`   id            : ${key.id}`);
		lines.push(`   分组 / 倍率    : ${key.group || '(未设置)'} · ${formatRatio(key.groupRatio)}`);
		lines.push(`   启用           : ${key.enabled !== false ? '是' : '否'}`);
		lines.push(`   模型数         : ${(key.models ?? []).length}`);
		if (apiKey) {
			// 只显示足以核对的前后几位，避免完整密钥出现在日志里
			const masked = `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}（共 ${apiKey.length} 字符）`;
			lines.push(`   密钥           : 已存入密钥库 ✓ ${masked}`);
		} else {
			lines.push('   密钥           : ✗ 缺失！请删除后重新添加该 Key');
		}
	}

	lines.push('');
	lines.push(`密钥库已写入条目     : ${(await countStoredSecrets(deps)).join(', ') || '(无)'}`);
	lines.push('');

	// 逐行强制输出，不受 debugMode 限制
	for (const line of lines) {
		logLine('DIAG', line);
	}
	// 关键一步：把输出面板切到本通道，否则用户看不到任何输出
	showLogs(false);
	logger.info(`4SAPI 诊断已输出（${settings.length} 个 Key）`);

	const broken = (
		await Promise.all(settings.map(async (key) => ((await deps.vault.getApiKey(key.id)) ? '' : key.id)))
	).filter(Boolean);
	void vscode.window.showInformationMessage(
		broken.length === 0
			? `4SAPI: 诊断已输出（${settings.length} 个 Key，密钥均正常）。已打开「输出」面板 → 右上角下拉框选择「${CHANNEL_NAME}」。`
			: `4SAPI: 有 ${broken.length} 个 Key 的密钥在密钥库中缺失，请删除后重新添加。已打开「输出」面板查看详情。`,
	);
}

async function countStoredSecrets(deps: KeyCommandDeps): Promise<string[]> {
	try {
		return await deps.vault.listStoredKeys();
	} catch {
		return [];
	}
}

// ---- 内部 ----
async function pickKey(title: string): Promise<KeySetting | undefined> {
	const keys = getKeySettings();
	if (keys.length === 0) {
		void vscode.window.showInformationMessage('4SAPI: 当前没有配置任何 API Key。');
		return undefined;
	}
	if (keys.length === 1) {
		return keys[0];
	}
	const picked = await vscode.window.showQuickPick(
		keys.map((key) => ({
			label: key.alias?.trim() || key.group || key.id,
			description: `${key.group || '未指定分组'} · ${formatRatio(key.groupRatio)}`,
			detail: `${(key.models ?? []).length} 个模型 · id: ${key.id}`,
			key,
		})),
		{ title, placeHolder: '选择要操作的 Key' },
	);
	return picked?.key;
}

/** 选定该 Key 所在的分组：优先从可用模型自动推断，推断不出时退化为手动选择/输入 */
async function pickGroup(
	snapshot: PricingSnapshot | undefined,
	liveModelIds: string[],
): Promise<GroupOption | undefined> {
	if (!snapshot) {
		return manualGroup(liveModelIds);
	}

	const inferred = listGroups(snapshot, liveModelIds);
	const options = inferred.length > 0 ? inferred : allGroups(snapshot);
	if (options.length === 0) {
		return manualGroup(liveModelIds);
	}

	const picked = await vscode.window.showQuickPick(
		options.map((option) => ({
			label: `${option.group} · ${formatRatio(option.ratio)}`,
			description:
				option.modelCount > 0 ? `${option.modelCount} 个可用模型` : undefined,
			detail: option.description || undefined,
			option,
		})),
		{
			title: '选择该 Key 绑定的 4SAPI 分组',
			placeHolder:
				inferred.length > 0
					? '已按该 Key 的可用模型推断；倍率即控制台的分组倍率'
					: '未能自动推断，请按控制台创建 Key 时选的分组选择',
			ignoreFocusOut: true,
		},
	);
	logger.info('选定分组', picked?.option.group ?? '(取消)');
	if (!picked) {
		return undefined;
	}
	return picked.option;
}

/** 倍率表不可用时的兜底：手动输入分组名与倍率 */
async function manualGroup(liveModelIds: string[]): Promise<GroupOption | undefined> {
	const group = await vscode.window.showInputBox({
		title: '4SAPI: 输入分组名称',
		prompt: '无法读取倍率表，请手动输入创建 Key 时选择的分组名称',
		placeHolder: '如 企业推荐全模型分组 / claude-官方 / deepseek',
		ignoreFocusOut: true,
		validateInput: (value: string) => (value?.trim() ? undefined : '分组名称不能为空'),
	});
	if (!group?.trim()) {
		return undefined;
	}
	const ratioInput = await vscode.window.showInputBox({
		title: '4SAPI: 输入分组倍率',
		prompt: '控制台展示的消耗倍率（仅用于显示，可留空表示未知）',
		placeHolder: '如 0.8 / 2 / 5',
		ignoreFocusOut: true,
		validateInput: (value: string) => {
			if (!value?.trim()) {
				return undefined;
			}
			const parsed = Number(value);
			return Number.isFinite(parsed) && parsed >= 0 ? undefined : '请输入非负数字';
		},
	});
	const ratio = ratioInput?.trim() ? Number(ratioInput) : undefined;
	return {
		group: group.trim(),
		ratio,
		description: '',
		modelCount: liveModelIds.length,
	};
}

/** 多选模型；`isPicked` 决定默认勾选状态；返回空数组表示用户取消或没有候选 */
async function pickModels(
	candidates: string[],
	snapshot: PricingSnapshot | undefined,
	group: string,
	title: string,
	isPicked: (modelId: string) => boolean = () => true,
): Promise<string[]> {
	if (candidates.length === 0) {
		void vscode.window.showWarningMessage(
			`4SAPI: 该 Key 在分组「${group}」下没有可聊天的模型，请检查分组是否正确。`,
		);
		return [];
	}

	const picked = await vscode.window.showQuickPick(
		candidates.map((modelId) => {
			const entry = snapshot?.models[modelId];
			const vendor = entry && snapshot ? snapshot.vendors[entry.vendorId] : undefined;
			return {
				label: modelId,
				description: entry?.tags.join(' · ') || undefined,
			detail: vendor ? `供应商 ${vendor} · ${formatRatio(snapshot?.groupRatio[group])}` : undefined,
				picked: isPicked(modelId),
				modelId,
			};
		}),
		{
			canPickMany: true,
			title: `4SAPI: 选择要暴露到 Copilot 的模型（${title}）`,
			placeHolder: '勾选的模型会出现在 Copilot Chat 模型选择器中',
			ignoreFocusOut: true,
		},
	);
	if (!picked) {
		return [];
	}
	return picked.map((item) => item.modelId);
}

async function pickAlias(defaultAlias: string): Promise<string> {
	const alias = await vscode.window.showInputBox({
		title: '4SAPI: 为这个 Key 起个别名',
		prompt: '别名会显示在模型描述里，用于区分不同 Key（可直接回车用默认值）',
		value: defaultAlias,
		ignoreFocusOut: true,
	});
	return alias?.trim() || defaultAlias;
}

async function saveKeys(keys: KeySetting[]): Promise<boolean> {
	try {
		await vscode.workspace
			.getConfiguration('4sapi-copilot')
			.update('keys', keys, vscode.ConfigurationTarget.Global);
		return true;
	} catch (error) {
		void vscode.window.showErrorMessage(
			`4SAPI: 写入配置失败（${error instanceof Error ? error.message : String(error)}）。`,
		);
		return false;
	}
}

function newKeyId(): string {
	const random = Math.random().toString(36).slice(2, 8);
	return `key-${Date.now().toString(36)}-${random}`;
}

