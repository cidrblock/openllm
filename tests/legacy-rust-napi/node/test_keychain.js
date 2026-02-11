#!/usr/bin/env node
/**
 * Test keychain operations via NAPI binding
 * 
 * Run with: node test_keychain.js
 */

const path = require('path');

// Load the NAPI binding
const napiPath = path.join(__dirname, '../../packages/vscode/openllm-napi.linux-x64-gnu.node');
console.log('Loading NAPI from:', napiPath);

let napi;
try {
  napi = require(napiPath);
  console.log('NAPI loaded successfully');
  console.log('Available exports:', Object.keys(napi));
} catch (e) {
  console.error('Failed to load NAPI:', e);
  process.exit(1);
}

async function testKeychain() {
  console.log('\n=== Keychain CRUD Test via NAPI ===\n');
  
  const testKey = 'test_napi_key';
  const testValue = 'test_value_' + Date.now();
  
  // Create resolver
  console.log('1. Creating UnifiedSecretResolver...');
  const resolver = new napi.UnifiedSecretResolver();
  console.log('   Created');
  
  // Configure for keychain
  console.log('2. Configuring for keychain (not VS Code RPC)...');
  resolver.setSecretsStore('keychain');
  resolver.setCheckEnvironment(false);
  resolver.setCheckDotenv(false);
  console.log('   Configured: store=' + resolver.getSecretsStore());
  
  // Test store
  console.log('\n3. Storing secret...');
  console.log('   Key:', testKey);
  console.log('   Value:', testValue);
  try {
    const dest = resolver.store(testKey, testValue, 'keychain');
    console.log('   Store result:', dest);
  } catch (e) {
    console.error('   Store FAILED:', e.message);
    return false;
  }
  
  // Test resolve (read) - NOTE: resolve is async!
  console.log('\n4. Reading secret back (resolve)...');
  try {
    const result = await resolver.resolve(testKey);
    if (result) {
      console.log('   Found:', result.value);
      console.log('   Source:', result.source);
      console.log('   Match:', result.value === testValue);
    } else {
      console.log('   NOT FOUND!');
      return false;
    }
  } catch (e) {
    console.error('   Resolve FAILED:', e.message);
    return false;
  }
  
  // Test reading the key we stored via command line
  console.log('\n5. Testing read of "openrouter" key (from earlier test)...');
  try {
    const result = await resolver.resolve('openrouter');
    if (result) {
      console.log('   Found:', result.value);
      console.log('   Source:', result.source);
    } else {
      console.log('   NOT FOUND - this is the bug!');
    }
  } catch (e) {
    console.error('   Resolve FAILED:', e.message);
  }
  
  // Test delete
  console.log('\n6. Deleting test secret...');
  try {
    const dest = resolver.delete(testKey, 'keychain');
    console.log('   Delete result:', dest);
  } catch (e) {
    console.error('   Delete FAILED:', e.message);
  }
  
  // Verify deleted
  console.log('\n7. Verifying deletion...');
  try {
    const result = await resolver.resolve(testKey);
    if (result) {
      console.log('   Still exists! Delete failed.');
    } else {
      console.log('   Confirmed deleted');
    }
  } catch (e) {
    console.log('   Confirmed deleted (threw error)');
  }
  
  console.log('\n=== Test Complete ===\n');
  return true;
}

testKeychain().then(success => {
  process.exit(success ? 0 : 1);
}).catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
