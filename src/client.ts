import type { CancellationToken } from 'vscode';
import { logger } from './logger';
import type {
	ChatRequest,
	ChatToolCall,
	ChatUsage,
	StreamCallbacks,
	StreamChunk,
} from './types';

/** 面向用户的请求错误（带 HTTP 状态码） */
export class ApiRequestError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly serverMessage?: string,
	) {
		super(message);
		this.name = 'ApiRequestError';
	}
}

/**
 * 轻量 SSE 流式 OpenAI 兼容客户端。
 * 零运行时依赖 —— 只用 Node 内置 fetch。
 */
export class ApiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly requestHeaders: Readonly<Record<string, string>> = {},
	) {}

	/** 流式 chat completions，解析 SSE 并分发 content / thinking / tool_call 回调 */
	async streamChatCompletion(
		request: ChatRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => controller.abort());
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}

		try {
			const body = { ...request, stream_options: { include_usage: true } };
			const headers = new Headers({
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			});
			for (const [name, value] of Object.entries(this.requestHeaders)) {
				headers.set(name, value);
			}

			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await createHttpError(response);
			}
			if (!response.body) {
				throw new ApiRequestError('4SAPI 返回了空响应体');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let latestUsage: ChatUsage | undefined;
			// 按 index 累积 tool_call 增量，finish 时统一派发
			const pendingToolCalls = new Map<number, ChatToolCall>();

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					return;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(':')) {
						continue;
					}
					if (trimmed === 'data: [DONE]') {
						flushToolCalls(pendingToolCalls, callbacks);
						reportUsage(callbacks, latestUsage);
						callbacks.onDone();
						return;
					}
					if (!trimmed.startsWith('data: ')) {
						continue;
					}
					let chunk: StreamChunk;
					try {
						chunk = JSON.parse(trimmed.slice(6)) as StreamChunk;
					} catch (error) {
						logger.warn('无法解析 SSE 片段:', trimmed.slice(0, 200), String(error));
						continue;
					}

					if (chunk.usage) {
						latestUsage = chunk.usage;
					}
					const choice = chunk.choices?.[0];
					if (!choice?.delta) {
						continue;
					}

					const reasoning =
						choice.delta.reasoning_content ?? choice.delta.reasoning ?? choice.delta.thinking;
					if (reasoning) {
						callbacks.onThinking(reasoning);
					}
					if (choice.delta.content) {
						callbacks.onContent(choice.delta.content);
					}
					if (choice.delta.tool_calls) {
						for (const tc of choice.delta.tool_calls) {
							let pending = pendingToolCalls.get(tc.index);
							if (!pending && tc.id) {
								pending = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
								pendingToolCalls.set(tc.index, pending);
							}
							if (pending) {
								if (tc.function?.name) {
									pending.function.name += tc.function.name;
								}
								if (tc.function?.arguments) {
									pending.function.arguments += tc.function.arguments;
								}
							}
						}
					}
					if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
						flushToolCalls(pendingToolCalls, callbacks);
					}
				}
			}

			flushToolCalls(pendingToolCalls, callbacks);
			reportUsage(callbacks, latestUsage);
			callbacks.onDone();
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			callbacks.onError(normalizeError(error, this.baseUrl));
		} finally {
			cancelListener?.dispose();
		}
	}

	/** GET {baseUrl}/models —— 拉取账户可用模型列表 */
	async listModels(cancellationToken?: CancellationToken): Promise<string[]> {
		const headers = new Headers({ Authorization: `Bearer ${this.apiKey}` });
		for (const [name, value] of Object.entries(this.requestHeaders)) {
			headers.set(name, value);
		}
		const response = await fetch(`${this.baseUrl}/models`, {
			method: 'GET',
			headers,
			signal: cancellationToken?.isCancellationRequested ? AbortSignal.abort() : undefined,
		});
		if (!response.ok) {
			throw await createHttpError(response);
		}
		const payload = (await response.json()) as {
			data?: Array<{ id?: string; name?: string } | string>;
		};
		const ids = (payload.data ?? []).map((item) =>
			typeof item === 'string' ? item : item.id ?? item.name ?? '',
		);
		return ids.filter((id) => id.length > 0).sort();
	}
}

function flushToolCalls(
	pending: Map<number, ChatToolCall>,
	callbacks: StreamCallbacks,
): void {
	for (const call of pending.values()) {
		callbacks.onToolCall(call);
	}
	pending.clear();
}

function reportUsage(callbacks: StreamCallbacks, usage: ChatUsage | undefined): void {
	if (usage && callbacks.onUsage) {
		callbacks.onUsage(usage);
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

async function createHttpError(response: Response): Promise<ApiRequestError> {
	const responseText = await response.text().catch(() => '');
	let serverMessage: string | undefined;
	try {
		const parsed = JSON.parse(responseText) as { error?: { message?: string }; message?: string };
		serverMessage = parsed.error?.message ?? parsed.message;
	} catch {
		serverMessage = responseText.slice(0, 500) || undefined;
	}

	const hint =
		response.status === 401 || response.status === 403
			? 'API Key 无效或已过期，请运行命令「4SAPI: 设置 API Key」。'
			: response.status === 402
				? '账户余额不足，请到 4SAPI 控制台充值。'
				: response.status === 429
					? '请求频率超限或配额耗尽，请稍后重试。'
					: `4SAPI 请求失败（HTTP ${response.status}）。`;

	return new ApiRequestError(
		serverMessage ? `${hint} 服务端信息：${serverMessage}` : hint,
		response.status,
		serverMessage,
	);
}

function normalizeError(error: unknown, baseUrl: string): Error {
	if (error instanceof ApiRequestError) {
		return error;
	}
	if (error instanceof Error) {
		if (error.name === 'AbortError') {
			return new ApiRequestError('请求已取消');
		}
		return new ApiRequestError(
			`无法连接 4SAPI（${baseUrl}）：${error.message}。请检查网络或改用国内直连域名（4sapi.org / 4sapi.top / 4stoken.com）。`,
		);
	}
	return new ApiRequestError(`4SAPI 请求失败：${String(error)}`);
}
