import * as vscode from 'vscode';
import { ILogger } from '../types';

/**
 * Adapter to use VS Code OutputChannel as core ILogger
 */
export class VSCodeLoggerAdapter implements ILogger {
  constructor(private channel: vscode.OutputChannel) {}

  debug(message: string, ...args: unknown[]): void {
    const formatted = this.format('DEBUG', message, args);
    this.channel.appendLine(formatted);
  }

  info(message: string, ...args: unknown[]): void {
    const formatted = this.format('INFO', message, args);
    this.channel.appendLine(formatted);
  }

  warn(message: string, ...args: unknown[]): void {
    const formatted = this.format('WARN', message, args);
    this.channel.appendLine(formatted);
  }

  error(message: string, ...args: unknown[]): void {
    const formatted = this.format('ERROR', message, args);
    this.channel.appendLine(formatted);
  }

  private format(level: string, message: string, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ' ' + args.map(a => 
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ') : '';
    return `[${timestamp}] ${level}: ${message}${argsStr}`;
  }
}
