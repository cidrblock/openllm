/**
 * In-memory secret store (for testing)
 */

import type { SecretStore } from './types.js';

export class MemorySecretStore implements SecretStore {
  private store = new Map<string, string>();
  
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}
