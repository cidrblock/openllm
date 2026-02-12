/**
 * DaemonState.listModels() unit tests
 *
 * Mocks all external dependencies (config loading, provider adapters, secret store)
 * to test the filtering logic in isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModelInfo } from './state.js';
import type { ProviderConfig, ConfigFile } from './config/loader.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock config/loader
const mockLoadConfig = vi.fn<any>().mockReturnValue({ providers: {} });
const mockLoadWorkspaceConfig = vi.fn<any>().mockReturnValue(null);
const mockMergeConfigs = vi.fn<any>();
const mockMergeMultipleWorkspaceConfigs = vi.fn<any>().mockReturnValue({ providers: {} });

vi.mock('./config/loader.js', () => ({
  loadConfig: (...a: any[]) => mockLoadConfig(...a),
  loadWorkspaceConfig: (...a: any[]) => mockLoadWorkspaceConfig(...a),
  mergeConfigs: (...a: any[]) => mockMergeConfigs(...a),
  mergeMultipleWorkspaceConfigs: (...a: any[]) => mockMergeMultipleWorkspaceConfigs(...a),
}));

// Mock providers/adapter
const mockGetSupportedProviders = vi.fn<any>().mockReturnValue([]);
const mockProviderRequiresKey = vi.fn<any>().mockReturnValue(true);
const mockFetchModels = vi.fn<any>().mockResolvedValue([]);
const mockGetProviderDisplayName = vi.fn<any>().mockImplementation((id: string) => id);
const mockGetDefaultEnvVar = vi.fn<any>().mockReturnValue(null);
const mockStreamChat = vi.fn<any>();

vi.mock('./providers/adapter.js', () => ({
  getSupportedProviders: (...a: any[]) => mockGetSupportedProviders(...a),
  providerRequiresKey: (...a: any[]) => mockProviderRequiresKey(...a),
  fetchModels: (...a: any[]) => mockFetchModels(...a),
  getProviderDisplayName: (...a: any[]) => mockGetProviderDisplayName(...a),
  getDefaultEnvVar: (...a: any[]) => mockGetDefaultEnvVar(...a),
  streamChat: (...a: any[]) => mockStreamChat(...a),
}));

// Mock secrets/keychain — provide an in-memory SecretStore
const mockSecretStoreData = new Map<string, string>();

vi.mock('./secrets/keychain.js', () => ({
  KeychainSecretStore: class {
    async get(key: string): Promise<string | null> {
      return mockSecretStoreData.get(key) ?? null;
    }
    async set(key: string, value: string): Promise<void> {
      mockSecretStoreData.set(key, value);
    }
    async delete(key: string): Promise<boolean> {
      return mockSecretStoreData.delete(key);
    }
    async has(key: string): Promise<boolean> {
      return mockSecretStoreData.has(key);
    }
  },
}));

// Now import DaemonState (after mocks are set up)
import { DaemonState } from './state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create mock ModelInfo objects for a given provider */
function makeModels(provider: string, ids: string[]): ModelInfo[] {
  return ids.map((id) => ({
    id: `${provider}/${id}`,
    provider,
    displayName: id,
    contextWindow: 128000,
    capabilities: { supportsTools: true, supportsVision: false },
  }));
}

// ── Setup ────────────────────────────────────────────────────────────────────

let state: DaemonState;

beforeEach(() => {
  vi.clearAllMocks();
  mockSecretStoreData.clear();

  state = new DaemonState();

  // Default: only openrouter and mock providers
  mockGetSupportedProviders.mockReturnValue(['mock', 'openrouter']);

  // mock provider doesn't require a key, openrouter does
  mockProviderRequiresKey.mockImplementation((id: string) => id !== 'mock');

  // Default display names
  mockGetProviderDisplayName.mockImplementation((id: string) => id);
  mockGetDefaultEnvVar.mockReturnValue(null);

  // Default: fetchModels returns nothing
  mockFetchModels.mockResolvedValue([]);

  // Default: loadConfig returns empty
  mockLoadConfig.mockReturnValue({ providers: {} });
  mockLoadWorkspaceConfig.mockReturnValue(null);
  mockMergeConfigs.mockImplementation((user, ws) => {
    if (!ws) return user;
    return {
      providers: { ...user.providers, ...ws.providers },
    };
  });
  mockMergeMultipleWorkspaceConfigs.mockReturnValue({ providers: {} });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DaemonState.listModels', () => {
  describe('enabled_models filtering', () => {
    it('should filter models when enabled_models is set', async () => {
      const allOpenRouterModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'anthropic/claude-opus-4.6',
        'anthropic/claude-3-haiku',
        'google/gemini-pro',
        'meta/llama-3-70b',
      ]);

      // Config: only 1 model enabled
      const config: ConfigFile = {
        providers: {
          openrouter: {
            enabled_models: ['openrouter/anthropic/claude-opus-4.5'],
            api_key_keychain_name: 'OPENROUTER_API_KEY',
          },
        },
      };

      // When no workspace paths, loadProviderConfig is used (calls loadConfig + mergeConfigs)
      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);

      // Provide API key
      mockSecretStoreData.set('OPENROUTER_API_KEY', 'sk-test-key');

      // fetchModels returns all 5
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return allOpenRouterModels;
        return [];
      });

      const models = await state.listModels();

      // Only the 1 enabled model should survive
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('openrouter/anthropic/claude-opus-4.5');
    });

    it('should return all models when enabled_models is not set', async () => {
      const allModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'google/gemini-pro',
      ]);

      const config: ConfigFile = {
        providers: {
          openrouter: {
            api_key_keychain_name: 'OPENROUTER_API_KEY',
            // NO enabled_models
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('OPENROUTER_API_KEY', 'sk-test-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return allModels;
        return [];
      });

      const models = await state.listModels();

      expect(models).toHaveLength(2);
    });

    it('should return all models when enabled_models is empty array', async () => {
      const allModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'google/gemini-pro',
      ]);

      const config: ConfigFile = {
        providers: {
          openrouter: {
            enabled_models: [], // empty
            api_key_keychain_name: 'OPENROUTER_API_KEY',
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('OPENROUTER_API_KEY', 'sk-test-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return allModels;
        return [];
      });

      const models = await state.listModels();

      expect(models).toHaveLength(2);
    });

    it('should match by full ID (provider/model)', async () => {
      const allModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'anthropic/claude-opus-4.6',
      ]);

      const config: ConfigFile = {
        providers: {
          openrouter: {
            enabled_models: ['openrouter/anthropic/claude-opus-4.6'],
            api_key_keychain_name: 'KEY',
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('KEY', 'sk-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return allModels;
        return [];
      });

      const models = await state.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('openrouter/anthropic/claude-opus-4.6');
    });

    it('should match by bare ID (without provider prefix)', async () => {
      const allModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'anthropic/claude-opus-4.6',
      ]);

      const config: ConfigFile = {
        providers: {
          openrouter: {
            // bare ID without "openrouter/" prefix
            enabled_models: ['anthropic/claude-opus-4.5'],
            api_key_keychain_name: 'KEY',
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('KEY', 'sk-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return allModels;
        return [];
      });

      const models = await state.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('openrouter/anthropic/claude-opus-4.5');
    });

    it('should filter to 2 models (user actual scenario)', async () => {
      // Simulate the user's exact scenario: 342 OpenRouter models, 2 enabled
      const manyModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'anthropic/claude-opus-4.6',
        'anthropic/claude-3-haiku',
        'anthropic/claude-3-sonnet',
        'google/gemini-pro',
        'google/gemini-flash',
        'meta/llama-3-70b',
        'meta/llama-3-8b',
        'mistralai/mistral-large',
        'mistralai/mixtral-8x7b',
      ]);

      const config: ConfigFile = {
        providers: {
          openrouter: {
            enabled_models: [
              'openrouter/anthropic/claude-opus-4.5',
              'openrouter/anthropic/claude-opus-4.6',
            ],
            api_key_keychain_name: 'OPENROUTER_API_KEY',
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('OPENROUTER_API_KEY', 'sk-test-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return manyModels;
        return [];
      });

      const models = await state.listModels();

      expect(models).toHaveLength(2);
      const ids = models.map(m => m.id);
      expect(ids).toContain('openrouter/anthropic/claude-opus-4.5');
      expect(ids).toContain('openrouter/anthropic/claude-opus-4.6');
    });
  });

  describe('workspace paths forwarding', () => {
    it('should call mergeMultipleWorkspaceConfigs when workspace paths provided', async () => {
      const config: ConfigFile = {
        providers: {
          openrouter: {
            enabled_models: ['openrouter/model-a'],
            api_key_keychain_name: 'KEY',
          },
        },
      };

      mockMergeMultipleWorkspaceConfigs.mockReturnValue(config);
      mockSecretStoreData.set('KEY', 'sk-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return makeModels('openrouter', ['model-a']);
        return [];
      });

      await state.listModels(['/tmp/workspace1']);

      expect(mockMergeMultipleWorkspaceConfigs).toHaveBeenCalledWith(['/tmp/workspace1']);
    });

    it('should NOT call mergeMultipleWorkspaceConfigs when no workspace paths', async () => {
      const config: ConfigFile = { providers: {} };
      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);

      await state.listModels();

      expect(mockMergeMultipleWorkspaceConfigs).not.toHaveBeenCalled();
    });

    it('should use merged config for filtering when workspace paths provided', async () => {
      const allModels = makeModels('openrouter', [
        'anthropic/claude-opus-4.5',
        'anthropic/claude-opus-4.6',
        'anthropic/claude-3-haiku',
      ]);

      // mergeMultipleWorkspaceConfigs returns config with enabled_models
      const mergedConfig: ConfigFile = {
        providers: {
          openrouter: {
            enabled_models: [
              'openrouter/anthropic/claude-opus-4.5',
              'openrouter/anthropic/claude-opus-4.6',
            ],
            api_key_keychain_name: 'OPENROUTER_API_KEY',
          },
        },
      };

      mockMergeMultipleWorkspaceConfigs.mockReturnValue(mergedConfig);
      mockSecretStoreData.set('OPENROUTER_API_KEY', 'sk-key');
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') return allModels;
        return [];
      });

      const models = await state.listModels(['/home/user/project']);

      expect(models).toHaveLength(2);
      expect(models.map(m => m.id)).toEqual([
        'openrouter/anthropic/claude-opus-4.5',
        'openrouter/anthropic/claude-opus-4.6',
      ]);
    });
  });

  describe('provider key requirements', () => {
    it('should skip providers requiring keys when no key is available', async () => {
      const config: ConfigFile = {
        providers: {
          openrouter: {
            api_key_keychain_name: 'OPENROUTER_API_KEY',
            // key exists in config but NOT in secret store
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      // Don't add key to mockSecretStoreData

      const models = await state.listModels();

      // openrouter requires a key but none available → skipped
      // mock doesn't require a key but has no config → fetched
      expect(mockFetchModels).not.toHaveBeenCalledWith('openrouter', expect.anything(), expect.anything());
    });

    it('should include no-key providers even without config', async () => {
      const mockModels = makeModels('mock', ['echo', 'fixed']);

      mockLoadConfig.mockReturnValue({ providers: {} });
      mockMergeConfigs.mockReturnValue({ providers: {} });
      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'mock') return mockModels;
        return [];
      });

      const models = await state.listModels();

      // mock provider doesn't require key, should be included
      expect(models).toHaveLength(2);
      expect(models[0].provider).toBe('mock');
    });

    it('should include provider when key is available in secret store', async () => {
      const config: ConfigFile = {
        providers: {
          openrouter: {
            api_key_keychain_name: 'OPENROUTER_API_KEY',
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('OPENROUTER_API_KEY', 'sk-real-key');
      mockFetchModels.mockImplementation(async (id: string, key?: string) => {
        if (id === 'openrouter') {
          expect(key).toBe('sk-real-key');
          return makeModels('openrouter', ['model-a']);
        }
        return [];
      });

      const models = await state.listModels();

      const orModels = models.filter(m => m.provider === 'openrouter');
      expect(orModels).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('should continue with other providers if one throws', async () => {
      const config: ConfigFile = {
        providers: {
          openrouter: {
            api_key_keychain_name: 'KEY',
          },
        },
      };

      mockLoadConfig.mockReturnValue(config);
      mockMergeConfigs.mockReturnValue(config);
      mockSecretStoreData.set('KEY', 'sk-key');

      mockFetchModels.mockImplementation(async (id: string) => {
        if (id === 'openrouter') throw new Error('API timeout');
        if (id === 'mock') return makeModels('mock', ['echo']);
        return [];
      });

      const models = await state.listModels();

      // openrouter failed but mock should still return models
      expect(models.some(m => m.provider === 'mock')).toBe(true);
      expect(models.some(m => m.provider === 'openrouter')).toBe(false);
    });
  });
});
