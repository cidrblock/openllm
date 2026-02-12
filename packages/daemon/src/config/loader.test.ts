/**
 * Config loader unit tests
 *
 * Tests loadConfigFromPath, mergeConfigs, and mergeMultipleWorkspaceConfigs
 * using real temp YAML files on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';

// Mock the paths module so loadConfig/loadWorkspaceConfig read from our temp dirs
let mockUserConfigPath = '/tmp/nonexistent-user-config.yaml';
vi.mock('../paths.js', () => ({
  getUserConfigPath: () => mockUserConfigPath,
  getWorkspaceConfigPath: (wsPath: string) => path.join(wsPath, '.config', 'openllm', 'config.yaml'),
}));

import {
  loadConfigFromPath,
  mergeConfigs,
  mergeMultipleWorkspaceConfigs,
  type ConfigFile,
} from './loader.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create a temp directory for each test */
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openllm-test-'));
});

/** Clean up temp directory after each test */
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a YAML config file and return its path */
function writeYaml(filePath: string, data: any): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, yaml.dump(data));
  return filePath;
}

/** Write a user config and point the mock to it */
function setUserConfig(data: ConfigFile): void {
  mockUserConfigPath = path.join(tmpDir, 'user-config.yaml');
  writeYaml(mockUserConfigPath, data);
}

/** Write a workspace config at <wsDir>/.config/openllm/config.yaml and return wsDir */
function createWorkspace(name: string, data: ConfigFile): string {
  const wsDir = path.join(tmpDir, name);
  writeYaml(path.join(wsDir, '.config', 'openllm', 'config.yaml'), data);
  return wsDir;
}

// ── loadConfigFromPath ───────────────────────────────────────────────────────

describe('loadConfigFromPath', () => {
  it('should parse valid YAML with enabled_models', () => {
    const filePath = writeYaml(path.join(tmpDir, 'config.yaml'), {
      providers: {
        openrouter: {
          enabled_models: [
            'openrouter/anthropic/claude-opus-4.5',
            'openrouter/anthropic/claude-opus-4.6',
          ],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const config = loadConfigFromPath(filePath);

    expect(config).not.toBeNull();
    expect(config!.providers).toBeDefined();
    expect(config!.providers!.openrouter).toBeDefined();
    expect(config!.providers!.openrouter.enabled_models).toEqual([
      'openrouter/anthropic/claude-opus-4.5',
      'openrouter/anthropic/claude-opus-4.6',
    ]);
    expect(config!.providers!.openrouter.api_key_keychain_name).toBe('OPENROUTER_API_KEY');
  });

  it('should return { providers: {} } for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.yaml');
    fs.writeFileSync(filePath, '');

    const config = loadConfigFromPath(filePath);

    expect(config).toEqual({ providers: {} });
  });

  it('should return null for missing file', () => {
    const config = loadConfigFromPath(path.join(tmpDir, 'nonexistent.yaml'));

    expect(config).toBeNull();
  });

  it('should reject old array-based providers format', () => {
    const filePath = writeYaml(path.join(tmpDir, 'old.yaml'), {
      providers: [
        { name: 'openai', api_key: 'sk-123' },
      ],
    });

    const config = loadConfigFromPath(filePath);

    expect(config).toEqual({ providers: {} });
  });

  it('should parse config with multiple providers', () => {
    const filePath = writeYaml(path.join(tmpDir, 'multi.yaml'), {
      providers: {
        openrouter: {
          api_key_keychain_name: 'OPENROUTER_API_KEY',
          enabled_models: ['openrouter/model-a'],
        },
        openai: {
          api_key_env_var_name: 'OPENAI_API_KEY',
          api_base: 'https://custom.openai.com',
        },
      },
    });

    const config = loadConfigFromPath(filePath);

    expect(config).not.toBeNull();
    expect(Object.keys(config!.providers!)).toHaveLength(2);
    expect(config!.providers!.openrouter.enabled_models).toEqual(['openrouter/model-a']);
    expect(config!.providers!.openai.api_key_env_var_name).toBe('OPENAI_API_KEY');
    expect(config!.providers!.openai.api_base).toBe('https://custom.openai.com');
  });
});

// ── mergeConfigs ─────────────────────────────────────────────────────────────

describe('mergeConfigs', () => {
  it('should return user config when workspace is null', () => {
    const userConfig: ConfigFile = {
      providers: {
        openrouter: { api_key_keychain_name: 'KEY' },
      },
    };

    const result = mergeConfigs(userConfig, null);

    expect(result).toBe(userConfig); // Same reference
  });

  it('should overlay workspace provider fields on user provider', () => {
    const userConfig: ConfigFile = {
      providers: {
        openrouter: {
          api_key_keychain_name: 'USER_KEY',
          api_base: 'https://user.api.com',
        },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        openrouter: {
          api_base: 'https://workspace.api.com',
        },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    expect(result.providers!.openrouter.api_key_keychain_name).toBe('USER_KEY');
    expect(result.providers!.openrouter.api_base).toBe('https://workspace.api.com');
  });

  it('should let workspace enabled_models override user enabled_models via spread', () => {
    const userConfig: ConfigFile = {
      providers: {
        openrouter: {
          enabled_models: ['model-a', 'model-b', 'model-c'],
        },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        openrouter: {
          enabled_models: ['model-a'],
        },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    // With spread (...user, ...ws), the ws enabled_models replaces user's
    expect(result.providers!.openrouter.enabled_models).toEqual(['model-a']);
  });

  it('should preserve providers only in user config', () => {
    const userConfig: ConfigFile = {
      providers: {
        openai: { api_key_keychain_name: 'OPENAI_KEY' },
        anthropic: { api_key_keychain_name: 'ANTHROPIC_KEY' },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        openai: { api_base: 'https://ws.openai.com' },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    expect(result.providers!.anthropic).toBeDefined();
    expect(result.providers!.anthropic.api_key_keychain_name).toBe('ANTHROPIC_KEY');
  });

  it('should add providers only in workspace config', () => {
    const userConfig: ConfigFile = {
      providers: {
        openai: { api_key_keychain_name: 'OPENAI_KEY' },
      },
    };
    const wsConfig: ConfigFile = {
      providers: {
        ollama: { api_base: 'http://localhost:11434' },
      },
    };

    const result = mergeConfigs(userConfig, wsConfig);

    expect(result.providers!.openai).toBeDefined();
    expect(result.providers!.ollama).toBeDefined();
    expect(result.providers!.ollama.api_base).toBe('http://localhost:11434');
  });
});

// ── mergeMultipleWorkspaceConfigs ────────────────────────────────────────────

describe('mergeMultipleWorkspaceConfigs', () => {
  it('should return user config unchanged when no workspace paths', () => {
    setUserConfig({
      providers: {
        openrouter: {
          enabled_models: ['model-a', 'model-b'],
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([]);

    expect(result.providers!.openrouter.enabled_models).toEqual(['model-a', 'model-b']);
  });

  it('should include workspace enabled_models in result', () => {
    setUserConfig({
      providers: {
        openrouter: {
          enabled_models: ['model-a'],
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const wsDir = createWorkspace('ws1', {
      providers: {
        openrouter: {
          enabled_models: ['model-a', 'model-b'],
          api_key_keychain_name: 'KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(result.providers!.openrouter.enabled_models).toBeDefined();
    const models = result.providers!.openrouter.enabled_models!;
    expect(models).toContain('model-a');
    expect(models).toContain('model-b');
  });

  /**
   * BUG-EXPOSING TEST: User's actual scenario
   *
   * User config:
   *   openrouter:
   *     enabled_models: [claude-opus-4.5, claude-opus-4.6]
   *     api_key_keychain_name: OPENROUTER_API_KEY
   *
   * Workspace config (identical):
   *   openrouter:
   *     enabled_models: [claude-opus-4.5, claude-opus-4.6]
   *     api_key_keychain_name: OPENROUTER_API_KEY
   *
   * Expected: merged config should have enabled_models = [claude-opus-4.5, claude-opus-4.6]
   */
  it('should preserve enabled_models when user and workspace configs are identical', () => {
    const sharedConfig: ConfigFile = {
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

    setUserConfig(sharedConfig);
    const wsDir = createWorkspace('ws', sharedConfig);

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(result.providers!.openrouter).toBeDefined();
    expect(result.providers!.openrouter.enabled_models).toEqual([
      'openrouter/anthropic/claude-opus-4.5',
      'openrouter/anthropic/claude-opus-4.6',
    ]);
  });

  /**
   * BUG-EXPOSING TEST: User config has NO enabled_models, workspace has 2.
   *
   * If the user config has a provider with no enabled_models, and the workspace
   * adds enabled_models, the merged result should contain enabled_models.
   */
  it('should use workspace enabled_models when user config has none', () => {
    setUserConfig({
      providers: {
        openrouter: {
          api_key_keychain_name: 'OPENROUTER_API_KEY',
          // NO enabled_models
        },
      },
    });

    const wsDir = createWorkspace('ws', {
      providers: {
        openrouter: {
          enabled_models: ['model-a', 'model-b'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    expect(result.providers!.openrouter.enabled_models).toBeDefined();
    expect(result.providers!.openrouter.enabled_models).toEqual(['model-a', 'model-b']);
  });

  /**
   * BUG-EXPOSING TEST: Provider-level replacement semantics.
   *
   * User config: openrouter has enabled_models [A, B, C]
   * Workspace:   openrouter has enabled_models [A]
   *
   * With provider-level replacement, workspace should win: [A]
   * With union semantics (current), result would be [A, B, C]
   *
   * The user's desired behavior is provider-level replacement.
   * This test documents the DESIRED behavior (workspace wins).
   */
  it('should use workspace enabled_models (provider-level replacement, not union)', () => {
    setUserConfig({
      providers: {
        openrouter: {
          enabled_models: ['model-a', 'model-b', 'model-c'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const wsDir = createWorkspace('ws', {
      providers: {
        openrouter: {
          enabled_models: ['model-a'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    // DESIRED: workspace replaces user at the provider level
    // If this test FAILS, it means the union semantics are still in place (bug)
    expect(result.providers!.openrouter.enabled_models).toEqual(['model-a']);
  });

  it('should preserve user-only providers untouched', () => {
    setUserConfig({
      providers: {
        openrouter: {
          enabled_models: ['model-a'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
        openai: {
          api_key_keychain_name: 'OPENAI_API_KEY',
        },
      },
    });

    const wsDir = createWorkspace('ws', {
      providers: {
        openrouter: {
          enabled_models: ['model-b'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
        // openai not in workspace
      },
    });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    // openai should remain from user config
    expect(result.providers!.openai).toBeDefined();
    expect(result.providers!.openai.api_key_keychain_name).toBe('OPENAI_API_KEY');
  });

  it('should union enabled_models across multiple workspaces', () => {
    setUserConfig({
      providers: {
        openrouter: {
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const ws1Dir = createWorkspace('ws1', {
      providers: {
        openrouter: {
          enabled_models: ['model-a'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const ws2Dir = createWorkspace('ws2', {
      providers: {
        openrouter: {
          enabled_models: ['model-b'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    const result = mergeMultipleWorkspaceConfigs([ws1Dir, ws2Dir]);

    // With multiple workspaces, enabled_models across workspaces should be unioned
    const models = result.providers!.openrouter.enabled_models!;
    expect(models).toContain('model-a');
    expect(models).toContain('model-b');
    expect(models).toHaveLength(2);
  });

  it('should handle workspace with no config file gracefully', () => {
    setUserConfig({
      providers: {
        openrouter: {
          enabled_models: ['model-a'],
          api_key_keychain_name: 'OPENROUTER_API_KEY',
        },
      },
    });

    // wsDir exists but has no .config/openllm/config.yaml
    const wsDir = path.join(tmpDir, 'empty-ws');
    fs.mkdirSync(wsDir, { recursive: true });

    const result = mergeMultipleWorkspaceConfigs([wsDir]);

    // Should fall back to user config
    expect(result.providers!.openrouter.enabled_models).toEqual(['model-a']);
  });
});
