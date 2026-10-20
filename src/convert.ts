import vscode from 'vscode';
import { LANGUAGE_MODEL_CHAT_SYSTEM_ROLE } from './consts';
import type { ChatContentPart, ChatMessage, ChatTool, ChatToolCall } from './types';

interface PendingToolResult {
	callId: string;
	parts: Array<{ kind: 'text'; text: string } | { kind: 'image'; mimeType: string; data: Uint8Array }>;
}

/**
 * VS Code 会话消息 → OpenAI 兼容 messages。
 * - 支持 system（内部角色 3）/ user / assistant / tool
 * - assistant 思考内容回填为 reasoning_content（DeepSeek 系历史缓存友好）
 * - 模型支持图片时把图片部件转成 image_url data URL
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: { isThinkingModel: boolean; imageInput: boolean },
): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);

		let text = '';
		let thinking = '';
		const imageParts: Array<{ mimeType: string; data: Uint8Array }> = [];
		const toolCalls: ChatToolCall[] = [];
		const toolResults: PendingToolResult[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (isImagePart(part)) {
				imageParts.push({ mimeType: part.mimeType, data: part.data });
			} else if (isThinkingPart(part)) {
				thinking += Array.isArray(part.value) ? part.value.join('') : part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: stringify(part.input ?? {}),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push(normalizeToolResult(part));
			}
		}

		if (role === 'assistant') {
			if (text || toolCalls.length > 0) {
				const msg: ChatMessage = { role: 'assistant', content: text || '' };
				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}
				if (options.isThinkingModel && thinking) {
					msg.reasoning_content = thinking;
				}
				result.push(msg);
			}
		} else if (role === 'system') {
			if (text) {
				result.push({ role: 'system', content: text });
			}
		} else if (options.imageInput && imageParts.length > 0) {
			const content: ChatContentPart[] = [];
			if (text) {
				content.push({ type: 'text', text });
			}
			for (const image of imageParts) {
				content.push({ type: 'image_url', image_url: { url: toImageDataUrl(image) } });
			}
			result.push({ role: 'user', content });
		} else if (text) {
			result.push({ role: 'user', content: text });
		}

		for (const toolResult of toolResults) {
			result.push({
				role: 'tool',
				tool_call_id: toolResult.callId,
				content: renderToolResultContent(toolResult, options.imageInput),
			});
		}
	}

	return result;
}

/** VS Code 工具定义 → OpenAI function 工具 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ChatTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			// 部分兼容端点要求无参数工具也必须显式给出 schema
			parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
		},
	}));
}

/** 统计消息字符数（用于 token 估算校准） */
export function countMessageChars(messages: ChatMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += typeof message.content === 'string'
			? message.content.length
			: message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
		total += message.reasoning_content?.length ?? 0;
		for (const call of message.tool_calls ?? []) {
			total += call.function.name.length + call.function.arguments.length;
		}
	}
	return total;
}

function normalizeToolResult(part: vscode.LanguageModelToolResultPart): PendingToolResult {
	const parts: PendingToolResult['parts'] = [];
	for (const item of part.content) {
		if (item instanceof vscode.LanguageModelTextPart) {
			parts.push({ kind: 'text', text: item.value });
		} else if (isImagePart(item)) {
			parts.push({ kind: 'image', mimeType: item.mimeType, data: item.data });
		} else if (item instanceof vscode.LanguageModelDataPart) {
			parts.push({ kind: 'text', text: `[二进制数据 ${item.mimeType}]` });
		}
	}
	return { callId: part.callId, parts };
}

function renderToolResultContent(
	result: PendingToolResult,
	imageInput: boolean,
): string | ChatContentPart[] {
	const hasImages = result.parts.some((part) => part.kind === 'image');
	if (!imageInput || !hasImages) {
		const text = result.parts
			.filter((part) => part.kind === 'text')
			.map((part) => part.text)
			.join('\n');
		if (text) {
			return text;
		}
		return hasImages ? '[工具返回了图片，但当前模型不支持图片输入]' : '';
	}

	const content: ChatContentPart[] = [];
	for (const part of result.parts) {
		if (part.kind === 'text') {
			content.push({ type: 'text', text: part.text });
		} else {
			content.push({ type: 'image_url', image_url: { url: toImageDataUrl(part) } });
		}
	}
	return content;
}

function toImageDataUrl(image: { mimeType: string; data: Uint8Array }): string {
	return `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`;
}

function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
	return (
		part instanceof vscode.LanguageModelDataPart &&
		typeof part.mimeType === 'string' &&
		part.mimeType.toLowerCase().startsWith('image/')
	);
}

function isThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

function mapRole(role: vscode.LanguageModelChatMessageRole | number): 'system' | 'user' | 'assistant' {
	if ((role as number) === LANGUAGE_MODEL_CHAT_SYSTEM_ROLE) {
		return 'system';
	}
	switch (role) {
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return '{}';
	}
}
