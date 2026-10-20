import vscode from 'vscode';
import { AuthManager } from './auth';
import { ApiClient, ApiRequestError } from './client';
import {
	getBaseUrl,
	getDebugMode,
	getGlobalTemperature,
	getGlobalTopP,
	getRequestHeaders,
	getUsageReportingEnabled,
	resolveModels,
} from './config';
import { countMessageChars, convertMessages, convertTools } from './convert';
import { logger, setLogLevel } from './logger';
import {
	applyThinking,
	calibrateCharsPerToken,
	estimateTokens,
	getConfiguredThinkingEffort,
	mergeExtraBody,
	toChatInfo,
	type ModelConfigurationOptions,
	type ModelPickerChatInformation,
} from './models';
import type { ChatRequest, ChatUsage, ResolvedModel } from './types';

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

/**
 * 4SAPI Chat Provider — 实现 vscode.LanguageModelChatProvider，
 * 让 4SAPI 聚合模型出现在 Copilot Chat 的模型选择器里。
 */
export class FourSapiChatProvider implements vscode.LanguageModelChatProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	/** 自适应 chars/token 比，用 API 上报的真实 token 数持续校准 */
	private charsPerToken = 4.0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly auth: AuthManager,
	) {
		context.subscriptions.push(
			this.onDidChangeEmitter,
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('4sapi-copilot')) {
					setLogLevel(getDebugMode());
					this.refreshModelPicker();
				}
			}),
			// 多窗口：密钥库变化不会触发 onDidChangeConfiguration
			context.secrets.onDidChange((event) => {
				if (event.key === '4sapi-copilot.apiKey') {
					this.refreshModelPicker();
				}
			}),
		);
	}

	/** 强制 Copilot Chat 重新查询模型信息 */
	refreshModelPicker(): void {
		this.onDidChangeEmitter.fire();
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const hasKey = await this.auth.hasApiKey();
		return resolveModels().map((model) => toChatInfo(model, hasKey));
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const started = Date.now();
		const model = this.resolveRequestedModel(modelInfo);
		const apiKey = await this.auth.getApiKey();
		if (!apiKey) {
			throw new ApiRequestError('未配置 4SAPI API Key，请运行命令「4SAPI: 设置 API Key」。');
		}

		const headers = { ...getRequestHeaders(), ...model.requestHeaders };
		const client = new ApiClient(getBaseUrl(), apiKey, headers);
		const request = this.buildRequest(model, messages, options);

		const requestChars = countMessageChars(request.messages);
		logger.info(
			`请求 → ${model.apiModelId}`,
			`思考=${model.thinking ? String(request.reasoning_effort ?? request.thinking?.type ?? 'none') : 'n/a'}`,
			`max_tokens=${String(request.max_tokens ?? 'default')}`,
			`消息数=${request.messages.length}`,
		);
		logger.debug('请求体:', safeJson(request));

		let thinkingEmitted = false;

		await client.streamChatCompletion(
			request,
			{
				onContent: (text: string) => {
					progress.report(new vscode.LanguageModelTextPart(text));
				},
				onThinking: (text: string) => {
					thinkingEmitted = reportThinking(text, progress);
				},
				onToolCall: (call) => {
					try {
						const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
						progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, args));
					} catch {
						progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, {}));
					}
				},
				onError: (error: Error) => {
					throw error;
				},
				onDone: () => {
					logger.info(
						`响应 ← ${model.apiModelId}`,
						`耗时=${Date.now() - started}ms`,
						thinkingEmitted ? '含思考内容' : '',
					);
				},
				onUsage: (usage: ChatUsage) => {
					this.charsPerToken = calibrateCharsPerToken(
						requestChars,
						usage.prompt_tokens,
						this.charsPerToken,
					);
					reportUsageToCopilot(progress, usage, getUsageReportingEnabled());
					logger.info(
						`用量 ${model.apiModelId}`,
						`prompt=${usage.prompt_tokens}`,
						`completion=${usage.completion_tokens}`,
						`cached=${usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0}`,
					);
				},
			},
			token,
		);
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		if (typeof text === 'string') {
			return estimateTokens(text, this.charsPerToken);
		}
		let chars = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				chars += part.value.length;
			}
		}
		return estimateTokens(' '.repeat(chars), this.charsPerToken);
	}

	// ---- 内部 ----

	private resolveRequestedModel(modelInfo: vscode.LanguageModelChatInformation): ResolvedModel {
		const models = resolveModels();
		const found = models.find((model) => model.id === modelInfo.id);
		if (found) {
			return found;
		}
		// 信息未刷新时的兜底：仅按 id 构造
		return {
			id: modelInfo.id,
			apiModelId: modelInfo.id,
			name: modelInfo.name,
			family: modelInfo.family ?? '4sapi',
			version: modelInfo.version ?? '',
			detail: modelInfo.detail ?? '',
			maxInputTokens: modelInfo.maxInputTokens,
			maxOutputTokens: modelInfo.maxOutputTokens,
			toolCalling: modelInfo.capabilities?.toolCalling === true,
			imageInput: modelInfo.capabilities?.imageInput === true,
			thinking: undefined,
			temperature: undefined,
			topP: undefined,
			maxTokens: undefined,
			stop: undefined,
			extraBody: undefined,
			requestHeaders: {},
		};
	}

	private buildRequest(
		model: ResolvedModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
	): ChatRequest {
		const converted = convertMessages(messages, {
			isThinkingModel: Boolean(model.thinking),
			imageInput: model.imageInput,
		});
		const tools = model.toolCalling ? convertTools(options.tools) : undefined;

		const request: ChatRequest = {
			model: model.apiModelId,
			messages: converted,
			stream: true,
			max_tokens: model.maxTokens,
			tools,
			tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
		};

		const temperature = model.temperature ?? getGlobalTemperature();
		if (temperature >= 0) {
			request.temperature = temperature;
		}
		const topP = model.topP ?? getGlobalTopP();
		if (topP >= 0) {
			request.top_p = topP;
		}
		if (model.stop) {
			request.stop = model.stop;
		}

		let effort = 'none';
		if (model.thinking) {
			effort = getConfiguredThinkingEffort(options as ModelConfigurationOptions, model.thinking);
			applyThinking(request, model.thinking, effort);
			mergeExtraBody(request, model.thinking.extraBody, effort);
		}
		mergeExtraBody(request, model.extraBody, effort);

		return request;
	}
}

function reportThinking(
	text: string,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): boolean {
	// LanguageModelThinkingPart 是提议中的 API：可用时渲染为可折叠思考块
	if (typeof vscode.LanguageModelThinkingPart === 'function') {
		progress.report(
			new vscode.LanguageModelThinkingPart(text) as unknown as vscode.LanguageModelResponsePart,
		);
		return true;
	}
	logger.debug('思考内容（当前 VS Code 不支持 ThinkingPart，已跳过渲染）:', text.slice(0, 200));
	return false;
}

function reportUsageToCopilot(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: ChatUsage,
	enabled: boolean,
): void {
	if (!enabled) {
		return;
	}
	const data = {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		prompt_tokens_details: {
			cached_tokens:
				usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
		},
	};
	try {
		progress.report(
			new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(data)), COPILOT_USAGE_DATA_PART_MIME),
		);
	} catch (error) {
		logger.warn('上报用量失败:', String(error));
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return '<unserializable>';
	}
}
