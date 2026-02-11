/**
 * Keychain secret store using keytar
 */

import type { SecretStore } from './types.js';

const SERVICE_NAME = 'openllm';

/**
 * Keychain-based secret store using system keyring
 * 
 * Uses keytar for cross-platform keychain access:
 * - macOS: Keychain
 * - Linux: libsecret (GNOME Keyring / KDE Wallet)
 * - Windows: Credential Vault
 */
export class KeychainSecretStore implements SecretStore {
  private keytar: typeof import('keytar') | null = null;
  private loadError: string | null = null;
  
  constructor() {
    // Load keytar lazily since it's a native module
    this.loadKeytar();
  }
  
  private async loadKeytar(): Promise<typeof import('keytar') | null> {
    if (this.keytar) return this.keytar;
    if (this.loadError) return null;
    
    try {
      this.keytar = await import('keytar');
      return this.keytar;
    } catch (error: any) {
      this.loadError = error.message;
      console.warn(`[Secrets] keytar not available: ${error.message}. Keychain storage disabled.`);
      return null;
    }
  }
  
  async get(key: string): Promise<string | null> {
    const kt = await this.loadKeytar();
    if (!kt) return null;
    
    try {
      return await kt.getPassword(SERVICE_NAME, key);
    } catch (error: any) {
      console.error(`[Secrets] Failed to get key '${key}':`, error.message);
      return null;
    }
  }
  
  async set(key: string, value: string): Promise<void> {
    const kt = await this.loadKeytar();
    if (!kt) {
      throw new Error('Keychain storage not available');
    }
    
    try {
      await kt.setPassword(SERVICE_NAME, key, value);
    } catch (error: any) {
      throw new Error(`Failed to store key '${key}': ${error.message}`);
    }
  }
  
  async delete(key: string): Promise<boolean> {
    const kt = await this.loadKeytar();
    if (!kt) return false;
    
    try {
      return await kt.deletePassword(SERVICE_NAME, key);
    } catch (error: any) {
      console.error(`[Secrets] Failed to delete key '${key}':`, error.message);
      return false;
    }
  }
  
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null && value.length > 0;
  }
}
