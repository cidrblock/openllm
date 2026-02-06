/**
 * Native module loader for @openllm/native
 * Handles loading the native bindings in both development and production (bundled) contexts.
 */

import * as path from 'path';

let nativeModule: any = null;

// Use eval to prevent esbuild from bundling this require
const dynamicRequire = eval('require');

/**
 * Get the native OpenLLM bindings.
 * In development, loads from node_modules.
 * In production (bundled), loads from the out/native directory.
 */
export function getNative(): any {
  if (nativeModule) {
    return nativeModule;
  }

  try {
    // Try loading from the bundled location first (production)
    const bundledPath = path.join(__dirname, 'native', 'index.js');
    nativeModule = dynamicRequire(bundledPath);
    return nativeModule;
  } catch {
    // Fall back to node_modules (development)
    try {
      nativeModule = dynamicRequire('@openllm/native');
      return nativeModule;
    } catch (e) {
      throw new Error(`Failed to load @openllm/native: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Type definitions for the native module exports
export interface NativeSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface NativeProviderConfig {
  name: string;
  enabled: boolean;
  apiBase?: string;
  models: string[];
}

export interface NativeFileConfigProvider {
  path: string;
  level: 'user' | 'workspace';
  exists(): boolean;
  getProviders(): Promise<NativeProviderConfig[]>;
  addProvider(config: NativeProviderConfig): Promise<void>;
  updateProvider(name: string, config: NativeProviderConfig): Promise<void>;
  removeProvider(name: string): Promise<void>;
  importProviders(providers: NativeProviderConfig[]): Promise<void>;
}
