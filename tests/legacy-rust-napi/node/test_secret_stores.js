/**
 * Integration tests for OpenLLM Node.js bindings (Rust via napi-rs)
 * 
 * Run with: npm test
 */

const assert = require('assert');
const { 
  EnvSecretStore, MemorySecretStore, listSecretStores,
  // Message types
  createSystemMessage, createUserMessage, createAssistantMessage,
  createToolResult, createToolError,
  listProviders,
  // Provider classes (note: NAPI uses camelCase for class names)
  OpenAiProvider, AnthropicProvider, GeminiProvider,
  OllamaProvider, MistralProvider, AzureOpenAiProvider, OpenRouterProvider,
  // Dynamic streaming
  streamChatWithProvider,
} = require('@openllm/native');

// Alias for consistency
const OpenAIProvider = OpenAiProvider;
const AzureOpenAIProvider = AzureOpenAiProvider;

// Test helpers
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, msg = '') {
  if (!value) {
    throw new Error(`${msg} Expected truthy value, got ${value}`);
  }
}

function assertFalse(value, msg = '') {
  if (value) {
    throw new Error(`${msg} Expected falsy value, got ${value}`);
  }
}

// =============================================================================
// Tests
// =============================================================================

async function testRegistry() {
  console.log('\n📋 Registry Tests');
  
  await test('listSecretStores returns built-in stores', () => {
    const stores = listSecretStores();
    assertTrue(stores.length >= 2, 'Should have at least 2 stores');
    
    const names = stores.map(s => s.name);
    assertTrue(names.includes('env'), 'Should include env store');
    assertTrue(names.includes('memory'), 'Should include memory store');
  });

  await test('store info has correct shape', () => {
    const stores = listSecretStores();
    const envStore = stores.find(s => s.name === 'env');
    
    assertTrue(typeof envStore.name === 'string');
    assertTrue(typeof envStore.description === 'string');
    assertTrue(typeof envStore.isPlugin === 'boolean');
    assertFalse(envStore.isPlugin, 'Built-in stores are not plugins');
  });
}

async function testEnvSecretStore() {
  console.log('\n🌍 EnvSecretStore Tests');
  
  const store = new EnvSecretStore();
  
  await test('has correct name', () => {
    assertEqual(store.name, 'env');
  });

  await test('is available', () => {
    assertTrue(store.isAvailable());
  });

  await test('reads direct env var', async () => {
    process.env.TEST_OPENLLM_SECRET = 'test-value-123';
    const value = await store.get('TEST_OPENLLM_SECRET');
    assertEqual(value, 'test-value-123');
    delete process.env.TEST_OPENLLM_SECRET;
  });

  await test('reads mapped provider name (openai)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const value = await store.get('openai');
    assertEqual(value, 'sk-test-openai');
    delete process.env.OPENAI_API_KEY;
  });

  await test('reads mapped provider name (anthropic)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const value = await store.get('anthropic');
    assertEqual(value, 'sk-ant-test');
    delete process.env.ANTHROPIC_API_KEY;
  });

  await test('returns null for missing key', async () => {
    const value = await store.get('NONEXISTENT_KEY_12345');
    assertEqual(value, null);
  });

  await test('has() returns true for existing key', async () => {
    process.env.TEST_HAS_KEY = 'value';
    const result = await store.has('TEST_HAS_KEY');
    assertTrue(result);
    delete process.env.TEST_HAS_KEY;
  });

  await test('has() returns false for missing key', async () => {
    const result = await store.has('NONEXISTENT_KEY_12345');
    assertFalse(result);
  });

  await test('getInfo() returns correct info for existing key', async () => {
    process.env.TEST_INFO_KEY = 'value';
    const info = await store.getInfo('TEST_INFO_KEY');
    assertTrue(info.available);
    assertEqual(info.source, 'env');
    delete process.env.TEST_INFO_KEY;
  });

  await test('getInfo() returns not available for missing key', async () => {
    const info = await store.getInfo('NONEXISTENT_KEY_12345');
    assertFalse(info.available);
  });

  await test('store() throws ReadOnly error', async () => {
    try {
      await store.store('key', 'value');
      throw new Error('Should have thrown');
    } catch (err) {
      assertTrue(err.message.includes('read-only') || err.message.includes('ReadOnly'));
    }
  });

  await test('delete() throws ReadOnly error', async () => {
    try {
      await store.delete('key');
      throw new Error('Should have thrown');
    } catch (err) {
      assertTrue(err.message.includes('read-only') || err.message.includes('ReadOnly'));
    }
  });
}

async function testMemorySecretStore() {
  console.log('\n💾 MemorySecretStore Tests');
  
  const store = new MemorySecretStore();
  
  await test('has correct name', () => {
    assertEqual(store.name, 'memory');
  });

  await test('is available', () => {
    assertTrue(store.isAvailable());
  });

  await test('starts empty', () => {
    assertTrue(store.isEmpty());
    assertEqual(store.len(), 0);
  });

  await test('store and get', async () => {
    await store.store('key1', 'value1');
    const value = await store.get('key1');
    assertEqual(value, 'value1');
  });

  await test('has() returns true after store', async () => {
    await store.store('key2', 'value2');
    const result = await store.has('key2');
    assertTrue(result);
  });

  await test('len() increases after store', () => {
    assertTrue(store.len() >= 2);
  });

  await test('isEmpty() returns false after store', () => {
    assertFalse(store.isEmpty());
  });

  await test('getInfo() returns correct info', async () => {
    const info = await store.getInfo('key1');
    assertTrue(info.available);
    assertEqual(info.source, 'memory');
  });

  await test('delete removes key', async () => {
    await store.store('to_delete', 'value');
    assertTrue(await store.has('to_delete'));
    await store.delete('to_delete');
    assertFalse(await store.has('to_delete'));
  });

  await test('clear() removes all keys', () => {
    store.clear();
    assertTrue(store.isEmpty());
    assertEqual(store.len(), 0);
  });

  await test('update existing key', async () => {
    await store.store('update_key', 'original');
    assertEqual(await store.get('update_key'), 'original');
    await store.store('update_key', 'updated');
    assertEqual(await store.get('update_key'), 'updated');
  });
}

async function testMultipleStoreInstances() {
  console.log('\n🔀 Multiple Store Instances Tests');

  await test('memory stores are independent', async () => {
    const store1 = new MemorySecretStore();
    const store2 = new MemorySecretStore();
    
    await store1.store('key', 'value1');
    await store2.store('key', 'value2');
    
    assertEqual(await store1.get('key'), 'value1');
    assertEqual(await store2.get('key'), 'value2');
  });

  await test('env stores share same environment', async () => {
    const store1 = new EnvSecretStore();
    const store2 = new EnvSecretStore();
    
    process.env.SHARED_KEY = 'shared_value';
    
    assertEqual(await store1.get('SHARED_KEY'), 'shared_value');
    assertEqual(await store2.get('SHARED_KEY'), 'shared_value');
    
    delete process.env.SHARED_KEY;
  });
}

// =============================================================================
// Chat Message Tests
// =============================================================================

async function testChatMessages() {
  console.log('\n💬 ChatMessage Tests');

  await test('createSystemMessage', () => {
    const msg = createSystemMessage('You are helpful');
    assertEqual(msg.role, 'System');
    assertEqual(msg.content, 'You are helpful');
  });

  await test('createUserMessage', () => {
    const msg = createUserMessage('Hello');
    assertEqual(msg.role, 'User');
    assertEqual(msg.content, 'Hello');
  });

  await test('createAssistantMessage', () => {
    const msg = createAssistantMessage('Hi there!');
    assertEqual(msg.role, 'Assistant');
    assertEqual(msg.content, 'Hi there!');
  });
}

// =============================================================================
// Tool Tests
// =============================================================================

async function testToolTypes() {
  console.log('\n🔧 Tool Tests');

  await test('createToolResult', () => {
    const result = createToolResult('call_123', '72°F');
    assertEqual(result.callId, 'call_123');
    assertEqual(result.content, '72°F');
    assertFalse(result.isError);
  });

  await test('createToolError', () => {
    const result = createToolError('call_456', 'Not found');
    assertEqual(result.callId, 'call_456');
    assertTrue(result.isError);
  });
}

// =============================================================================
// Provider Tests
// =============================================================================

async function testProviders() {
  console.log('\n🏭 Provider Tests');

  await test('listProviders returns all providers', () => {
    const providers = listProviders();
    assertTrue(providers.length >= 7, 'Should have at least 7 providers');
    
    const ids = providers.map(p => p.id);
    assertTrue(ids.includes('openai'), 'Should include openai');
    assertTrue(ids.includes('anthropic'), 'Should include anthropic');
    assertTrue(ids.includes('gemini'), 'Should include gemini');
    assertTrue(ids.includes('ollama'), 'Should include ollama');
  });

  await test('provider metadata has correct structure', () => {
    const providers = listProviders();
    const openai = providers.find(p => p.id === 'openai');
    
    assertEqual(openai.displayName, 'OpenAI');
    assertTrue(openai.defaultApiBase.includes('openai.com'));
    assertTrue(openai.requiresApiKey);
    assertTrue(openai.defaultModels.length > 0);
  });

  await test('ollama does not require API key', () => {
    const providers = listProviders();
    const ollama = providers.find(p => p.id === 'ollama');
    
    assertFalse(ollama.requiresApiKey);
  });

  await test('provider has default models with capabilities', () => {
    const providers = listProviders();
    const openai = providers.find(p => p.id === 'openai');
    const model = openai.defaultModels[0];
    
    assertTrue(typeof model.id === 'string');
    assertTrue(typeof model.name === 'string');
    assertTrue(typeof model.contextLength === 'number');
    assertTrue(typeof model.capabilities.streaming === 'boolean');
  });
}

// =============================================================================
// Provider Class Tests
// =============================================================================

async function testProviderClasses() {
  console.log('\n🚀 Provider Class Tests');

  await test('OpenAIProvider can be instantiated', () => {
    const provider = new OpenAIProvider();
    assertEqual(provider.name, 'openai');
    const metadata = provider.metadata();
    assertEqual(metadata.id, 'openai');
    assertTrue(metadata.requiresApiKey);
  });

  await test('AnthropicProvider can be instantiated', () => {
    const provider = new AnthropicProvider();
    assertEqual(provider.name, 'anthropic');
    const metadata = provider.metadata();
    assertEqual(metadata.id, 'anthropic');
    assertTrue(metadata.requiresApiKey);
  });

  await test('GeminiProvider can be instantiated', () => {
    const provider = new GeminiProvider();
    assertEqual(provider.name, 'gemini');
    const metadata = provider.metadata();
    assertEqual(metadata.id, 'gemini');
  });

  await test('OllamaProvider can be instantiated', () => {
    const provider = new OllamaProvider();
    assertEqual(provider.name, 'ollama');
    const metadata = provider.metadata();
    assertEqual(metadata.id, 'ollama');
    assertFalse(metadata.requiresApiKey);
  });

  await test('MistralProvider can be instantiated', () => {
    const provider = new MistralProvider();
    assertEqual(provider.name, 'mistral');
  });

  await test('AzureOpenAIProvider can be instantiated', () => {
    const provider = new AzureOpenAIProvider();
    assertEqual(provider.name, 'azure');
  });

  await test('OpenRouterProvider can be instantiated', () => {
    const provider = new OpenRouterProvider();
    assertEqual(provider.name, 'openrouter');
  });

  await test('Provider has streamChat method', () => {
    const provider = new OpenAIProvider();
    assertTrue(typeof provider.streamChat === 'function');
  });

  await test('streamChatWithProvider function exists', () => {
    assertTrue(typeof streamChatWithProvider === 'function');
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' OpenLLM Node.js Bindings - Integration Tests');
  console.log('═══════════════════════════════════════════════════════════');

  await testRegistry();
  await testEnvSecretStore();
  await testMemorySecretStore();
  await testMultipleStoreInstances();
  await testChatMessages();
  await testToolTypes();
  await testProviders();
  await testProviderClasses();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
