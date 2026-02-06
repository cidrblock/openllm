import * as vscode from 'vscode';
import { CancellationToken } from '../types';

/**
 * Adapter to bridge VS Code CancellationToken to core CancellationToken
 */
export class VSCodeCancellationTokenAdapter implements CancellationToken {
  private listeners: Array<() => void> = [];

  constructor(private vscodeToken: vscode.CancellationToken) {
    // Register listener on VS Code token
    this.vscodeToken.onCancellationRequested(() => {
      this.listeners.forEach(listener => listener());
    });
  }

  get isCancellationRequested(): boolean {
    return this.vscodeToken.isCancellationRequested;
  }

  onCancellationRequested(listener: () => void): void {
    if (this.isCancellationRequested) {
      // Already cancelled, call immediately
      listener();
    } else {
      this.listeners.push(listener);
    }
  }
}
