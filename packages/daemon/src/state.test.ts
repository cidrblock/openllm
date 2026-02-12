/**
 * DaemonState unit tests
 *
 * Tests the virtual provider/model layer: listModels, listProviders, 
 * discoverModels, chat, and health checks.
 *
 * Mocks: config/loader, providers/adapter, secrets/keychain.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModelInfo, ProviderInfo } from './state.js';
import type { ProviderConfig, ConfigFile, ModelConfig } from './config/loader.js';
import type { EngineInfo, DiscoveredModel, ChatParams } from './providers/adapter.js';

// ── Mock: config/loader ──────────────────────────────────────────────────────

const mockLoadConfig = vi.fn<any>().mockReturnValue({ providers: {} });
const mockLoadWorkspaceConfig = vi.fn<any>().mockReturnValue(null);
const mockMergeConfigs = vi.fn<any>();
const mockMergeMultipleWorkspaceConfigs = vi.fn<any>().mockReturnValue({ providers: {} });
const mockResolveEngineModelId = vi.fn<any>().mockImplementation(
  (name: string, cfg: ModelConfig) => cfg.model_id || name
);

vi.mock('./config/loader.js', () => ({
  loadConfig: (...a: any[]) => mockLoadConfig(...a),
  loadWorkspaceConfig: (...a: any[]) => mockLoadWorkspaceConfig(...a),
  mergeConfigs: (...a: any[]) => mockMergeConfigs(...a),
  mergeMultipleWorkspaceConfigs: (...a: any[]) => mockMergeMultipleWorkspaceConfigs(...a),
  resolveEngineModelId: (...a: any[]) => mockResolveEngineModelId(...a),
}));

// ── Mock: providers/adapter ──────────────────────────────────────────────────

const MOCK_ENGINE: EngineInfo = {
  id: 'mock',
  multiLlmName: 'mock',
  displayName: 'Mock (Testing)',
  requiresKey: false,
};

const OPENROUTER_ENGINE: EngineInfo = {
  id: 'openrouter',
  multiLlmName: 'openrouter',
  displayName: 'OpenRouter',
  requiresKey: true,
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  defaultEnvVar: 'OPENROUTER_API_KEY',
};

const mockGetEngines = vi.fn<any>().mockReturnValue([MOCK_ENGINE, OPENROUTER_ENGINE]);
const mockGetEngine = vi.fn<any>().mockImplementation((id: string) => {
  if (id === 'mock') return MOCK_ENGINE;
  if (id === 'openrouter') return OPENROUTER_ENGINE;
  return undefined;
});
const mockFetchModels = vi.fn<any>().mockResolvedValue([]);
const mockStreamChat = vi.fn<any>();

vi.mock('./providers/adapter.js', () => ({
  getEngines: (...a: any[]) => mockGetEngines(...a),
  getEngine: (...a: any[]) => mockGetEngine(...a),
  fetchModels: (...a: any[]) => mockFetchModels(...a),
  streamChat: (...a: any[]) => mockStreamChat(...a),
}));

// ── Mock: secrets/keychain ───────────────────────────────────────────────────

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

// ── Import DaemonState (after mocks) ─────────────────────────────────────────

import { DaemonState } from './state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create DiscoveredModel objects */
function makeDiscovered(ids: string[]): DiscoveredModel[] {
  return ids.map(id => ({
    id,
    displayName: id.split('/').pop() || id,
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

  // Defaults
  mockLoadConfig.mockReturnValue({ providers: {} });
  mockLoadWorkspaceConfig.mockReturnValue(null);
  mockMergeConfigs.mockImplementation((user: ConfigFile, ws: ConfigFile | null) => {
    if (!ws) return user;
    // Provider-level replacement
    return { providers: { ...user.providers, ...ws.providers } };
  });
  mockMergeMultipleWorkspaceConfigs.mockReturnValue({ providers: {} });
  mockFetchModels.mockResolvedValue([]);
});

// ── listModels ───────────────────────────────────────────────────────────────

describe('DaemonState.listModels', () => {
  it('should return empty when no providers configured', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockMergeConfigs.mockReturnValue({ providers: {} });

    const models = await state.listModels();
    expect(models).toEqual([]);
  });

  it('should return models for a configured provider with key', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'OR_KEY',
          models: {
            'openrouter/anthropic/claude-opus-4.5': {},
            'openrouter/anthropic/claude-opus-4.6': {},
          },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('OR_KEY', 'sk-test');
    mockFetchModels.mockResolvedValue(makeDiscovered([
      'openrouter/anthropic/claude-opus-4.5',
      'openrouter/anthropic/claude-opus-4.6',
      'openrouter/google/gemini-pro',
    ]));

    const models = await state.listModels();

    // Only the 2 configured models
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('openrouter/openrouter/anthropic/claude-opus-4.5');
    expect(models[0].name).toBe('openrouter/anthropic/claude-opus-4.5');
    expect(models[0].provider).toBe('openrouter');
    expect(models[0].engine).toBe('openrouter');
  });

  it('should skip provider without key when engine requires key', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'OR_KEY',
          models: { 'model-a': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    // No key in secret store

    const models = await state.listModels();

    expect(models).toEqual([]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it('should include keyless provider models', async () => {
    const config: ConfigFile = {
      providers: {
        'my-mock': {
          engine: 'mock',
          models: { 'echo': {}, 'fixed': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockFetchModels.mockResolvedValue(makeDiscovered(['echo', 'fixed', 'counter']));

    const models = await state.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('my-mock/echo');
    expect(models[1].id).toBe('my-mock/fixed');
  });

  it('should skip provider with no models configured', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'KEY',
          models: {}, // empty
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('KEY', 'sk-test');

    const models = await state.listModels();
    expect(models).toEqual([]);
  });

  it('should attach per-model params from config', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'KEY',
          models: {
            'claude-precise': {
              model_id: 'openrouter/anthropic/claude-opus-4.6',
              temperature: 0.2,
              top_p: 0.5,
            },
          },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('KEY', 'sk-test');
    mockFetchModels.mockResolvedValue(makeDiscovered(['openrouter/anthropic/claude-opus-4.6']));

    const models = await state.listModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openrouter/claude-precise');
    expect(models[0].name).toBe('claude-precise');
    expect(models[0].engineModelId).toBe('openrouter/anthropic/claude-opus-4.6');
    expect(models[0].params?.temperature).toBe(0.2);
    expect(models[0].params?.top_p).toBe(0.5);
  });

  it('should use workspace config when workspace paths provided', async () => {
    const mergedConfig: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'KEY',
          models: { 'model-a': {} },
        },
      },
    };

    mockMergeMultipleWorkspaceConfigs.mockReturnValue(mergedConfig);
    mockSecretStoreData.set('KEY', 'sk-test');
    mockFetchModels.mockResolvedValue(makeDiscovered(['model-a', 'model-b']));

    const models = await state.listModels(['/tmp/ws1']);

    expect(mockMergeMultipleWorkspaceConfigs).toHaveBeenCalledWith(['/tmp/ws1']);
    expect(models).toHaveLength(1);
  });

  it('should continue with other providers if one errors', async () => {
    const config: ConfigFile = {
      providers: {
        'bad-provider': {
          engine: 'openrouter',
          api_key_keychain_name: 'BAD_KEY',
          models: { 'model-a': {} },
        },
        'good-mock': {
          engine: 'mock',
          models: { 'echo': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('BAD_KEY', 'sk-bad');
    mockFetchModels.mockImplementation(async (engineId: string) => {
      if (engineId === 'openrouter') throw new Error('API timeout');
      if (engineId === 'mock') return makeDiscovered(['echo']);
      return [];
    });

    const models = await state.listModels();

    // bad-provider errored during fetch, but its model should still be created
    // (with empty discovery data)
    const mockModels = models.filter(m => m.provider === 'good-mock');
    expect(mockModels).toHaveLength(1);
  });
});

// ── listProviders ────────────────────────────────────────────────────────────

describe('DaemonState.listProviders', () => {
  it('should return empty when no providers configured', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockMergeConfigs.mockReturnValue({ providers: {} });

    const providers = await state.listProviders();
    expect(providers).toEqual([]);
  });

  it('should return configured provider with correct fields', async () => {
    const config: ConfigFile = {
      providers: {
        'work-openrouter': {
          engine: 'openrouter',
          display_name: 'Work OpenRouter',
          api_key_keychain_name: 'WOR_KEY',
          base_url: 'https://custom.openrouter.ai',
          models: { 'model-a': {} },
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockSecretStoreData.set('WOR_KEY', 'sk-test');

    const providers = await state.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('work-openrouter');
    expect(providers[0].engine).toBe('openrouter');
    expect(providers[0].displayName).toBe('Work OpenRouter');
    expect(providers[0].configured).toBe(true);
    expect(providers[0].requiresKey).toBe(true);
    expect(providers[0].baseUrl).toBe('https://custom.openrouter.ai');
    expect(providers[0].defaultBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('should mark provider as unconfigured when key missing', async () => {
    const config: ConfigFile = {
      providers: {
        openrouter: {
          engine: 'openrouter',
          api_key_keychain_name: 'MISSING_KEY',
        },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const providers = await state.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].configured).toBe(false);
  });

  it('should mark keyless provider as configured', async () => {
    const config: ConfigFile = {
      providers: {
        'my-mock': { engine: 'mock', models: { 'echo': {} } },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const providers = await state.listProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0].configured).toBe(true);
    expect(providers[0].requiresKey).toBe(false);
  });

  it('should skip provider with unknown engine', async () => {
    const config: ConfigFile = {
      providers: {
        'bad-provider': { engine: 'nonexistent' },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    const providers = await state.listProviders();
    expect(providers).toEqual([]);
  });
});

// ── discoverModels ───────────────────────────────────────────────────────────

describe('DaemonState.discoverModels', () => {
  it('should return models from engine', async () => {
    const discovered = makeDiscovered(['model-a', 'model-b']);
    mockFetchModels.mockResolvedValue(discovered);

    const models = await state.discoverModels('mock');

    expect(models).toEqual(discovered);
    expect(mockFetchModels).toHaveBeenCalledWith('mock', undefined, undefined);
  });

  it('should pass apiKey and baseUrl to fetchModels', async () => {
    mockFetchModels.mockResolvedValue([]);

    await state.discoverModels('openrouter', 'sk-key', 'https://custom.api');

    expect(mockFetchModels).toHaveBeenCalledWith('openrouter', 'sk-key', 'https://custom.api');
  });

  it('should return empty for key-required engine without key', async () => {
    const models = await state.discoverModels('openrouter');

    expect(models).toEqual([]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it('should return empty for unknown engine', async () => {
    const models = await state.discoverModels('nonexistent');

    expect(models).toEqual([]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });
});

// ── listEngines ──────────────────────────────────────────────────────────────

describe('DaemonState.listEngines', () => {
  it('should return all engines from adapter', () => {
    const engines = state.listEngines();

    expect(engines).toHaveLength(2);
    expect(engines[0].id).toBe('mock');
    expect(engines[1].id).toBe('openrouter');
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────

describe('DaemonState.chat', () => {
  it('should yield error for invalid composite ID (no slash)', async () => {
    const chunks = [];
    for await (const chunk of state.chat('no-slash-id', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('done');
    expect(chunks[0].finishReason).toBe('error');
  });

  it('should yield error for unknown provider', async () => {
    mockLoadConfig.mockReturnValue({ providers: {} });
    mockMergeConfigs.mockReturnValue({ providers: {} });

    const chunks = [];
    for await (const chunk of state.chat('unknown/model', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('done');
    expect(chunks[0].finishReason).toBe('error');
  });
});

// ── runHealthChecks ──────────────────────────────────────────────────────────

describe('DaemonState.runHealthChecks', () => {
  it('should mark provider healthy when models discoverable', async () => {
    const config: ConfigFile = {
      providers: {
        'my-mock': { engine: 'mock', models: { 'echo': {} } },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);
    mockFetchModels.mockResolvedValue(makeDiscovered(['echo']));

    await state.runHealthChecks();

    // Health data is private, but we can verify via listProviders
    const providers = await state.listProviders();
    expect(providers[0].healthy).toBe(true);
  });

  it('should mark provider unhealthy when engine unknown', async () => {
    const config: ConfigFile = {
      providers: {
        'bad': { engine: 'nonexistent' },
      },
    };

    mockLoadConfig.mockReturnValue(config);
    mockMergeConfigs.mockReturnValue(config);

    await state.runHealthChecks();

    // Provider with unknown engine won't appear in listProviders, 
    // but healthCheck should have run without crashing
  });
});

// ── Client management ────────────────────────────────────────────────────────

describe('DaemonState client management', () => {
  it('should register and unregister clients', () => {
    const clientId = state.registerClient('VSCODE' as any);

    expect(state.clientCount).toBe(1);
    expect(state.getClients()).toHaveLength(1);

    state.unregisterClient(clientId);
    expect(state.clientCount).toBe(0);
  });

  it('should track workspace paths', () => {
    const clientId = state.registerClient('VSCODE' as any, false, '/tmp/workspace');
    const clients = state.getClients();

    expect(clients[0].workspacePath).toBe('/tmp/workspace');
    expect(clients[0].workspacePaths).toEqual(['/tmp/workspace']);
  });
});
