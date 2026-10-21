import vscode from 'vscode';

export type LogLevel = 'minimal' | 'metadata' | 'verbose';

/** 输出通道名称（用户可在「输出」面板的下拉框中看到） */
export const CHANNEL_NAME = '4SAPI';

let channel: vscode.OutputChannel | undefined;
let level: LogLevel = 'minimal';

export function initLogger(name: string, initialLevel: LogLevel): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel(name);
	}
	level = initialLevel;
	return channel;
}

export function setLogLevel(next: LogLevel): void {
	level = next;
}

export function getLogLevel(): LogLevel {
	return level;
}

/**
 * 把输出面板切到本扩展的通道。
 * 通道是懒创建的 —— 即使 `initLogger` 因故没跑，这里也会补上，
 * 避免命令执行成功却「什么都没发生」。
 */
export function showLogs(preserveFocus = true): boolean {
	if (!channel) {
		channel = vscode.window.createOutputChannel(CHANNEL_NAME);
	}
	channel.show(preserveFocus);
	return true;
}

/** 无论当前日志级别都立即输出（用于用户主动触发的诊断信息） */
export function logLine(kind: string, message: string, ...rest: unknown[]): void {
	write(kind, message, rest);
}

export const logger = {
	error(message: string, ...rest: unknown[]): void {
		write('ERROR', message, rest);
	},
	warn(message: string, ...rest: unknown[]): void {
		write('WARN', message, rest);
	},
	info(message: string, ...rest: unknown[]): void {
		// metadata 及以上才输出
		if (level !== 'minimal') {
			write('INFO', message, rest);
		}
	},
	debug(message: string, ...rest: unknown[]): void {
		// verbose 才输出（请求/响应体等敏感内容）
		if (level === 'verbose') {
			write('DEBUG', message, rest);
		}
	},
};

function write(kind: string, message: string, rest: unknown[]): void {
	if (!channel) {
		return;
	}
	const time = new Date().toISOString().slice(11, 23);
	const suffix = rest
		.map((item) => {
			if (typeof item === 'string') {
				return item;
			}
			if (item instanceof Error) {
				return `${item.name}: ${item.message}`;
			}
			try {
				return JSON.stringify(item);
			} catch {
				return String(item);
			}
		})
		.filter((item) => item.length > 0)
		.join(' ');
	channel.appendLine(`[${time}] ${kind.padEnd(5)} ${message}${suffix ? ` ${suffix}` : ''}`);
}
