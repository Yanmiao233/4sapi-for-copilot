import vscode from 'vscode';

export type LogLevel = 'minimal' | 'metadata' | 'verbose';

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

export function showLogs(): void {
	channel?.show(true);
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
		.join(' ');
	channel.appendLine(`[${time}] ${kind.padEnd(5)} ${message}${suffix ? ` ${suffix}` : ''}`);
}
