#!/usr/bin/env node
/**
 * Test client for the OpenLLM JSON-RPC server
 * 
 * Usage:
 *   node test_rpc_client.js <socket_path> <auth_token>
 * 
 * The socket path and auth token are printed to the VS Code output channel
 * when the extension starts.
 */

const net = require('net');
const readline = require('readline');

const socketPath = process.argv[2];
const authToken = process.argv[3];

if (!socketPath || !authToken) {
  console.error('Usage: node test_rpc_client.js <socket_path> <auth_token>');
  console.error('');
  console.error('Find the socket path and auth token in VS Code:');
  console.error('  1. Open VS Code Output panel');
  console.error('  2. Select "Open LLM" from the dropdown');
  console.error('  3. Look for "[RPC] Server started on ..."');
  process.exit(1);
}

let requestId = 0;
const pendingRequests = new Map();

// Connect to the socket
const socket = net.connect(socketPath, () => {
  console.log('Connected to RPC server');
  console.log('');
  runTests();
});

socket.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

// Buffer for incoming data (JSON-RPC uses Content-Length headers)
let buffer = '';
let contentLength = -1;

socket.on('data', (data) => {
  buffer += data.toString();
  
  while (true) {
    if (contentLength === -1) {
      // Look for Content-Length header
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      
      const header = buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (match) {
        contentLength = parseInt(match[1], 10);
        buffer = buffer.substring(headerEnd + 4);
      } else {
        console.error('Invalid header:', header);
        break;
      }
    }
    
    if (contentLength > 0 && buffer.length >= contentLength) {
      const message = buffer.substring(0, contentLength);
      buffer = buffer.substring(contentLength);
      contentLength = -1;
      
      try {
        const response = JSON.parse(message);
        handleResponse(response);
      } catch (e) {
        console.error('Failed to parse response:', e);
      }
    } else {
      break;
    }
  }
});

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: { auth: authToken, ...params },
    };
    
    pendingRequests.set(id, { resolve, reject });
    
    const content = JSON.stringify(request);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
    socket.write(message);
  });
}

function handleResponse(response) {
  const pending = pendingRequests.get(response.id);
  if (pending) {
    pendingRequests.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }
}

async function runTests() {
  try {
    // Test 1: Ping
    console.log('Test 1: lifecycle/ping');
    const ping = await sendRequest('lifecycle/ping', {});
    console.log('  Result:', JSON.stringify(ping));
    console.log('  ✓ Passed');
    console.log('');

    // Test 2: Capabilities
    console.log('Test 2: lifecycle/capabilities');
    const caps = await sendRequest('lifecycle/capabilities', {});
    console.log('  Result:', JSON.stringify(caps));
    console.log('  ✓ Passed');
    console.log('');

    // Test 3: Get workspace root
    console.log('Test 3: workspace/getRoot');
    const root = await sendRequest('workspace/getRoot', {});
    console.log('  Result:', JSON.stringify(root));
    console.log('  ✓ Passed');
    console.log('');

    // Test 4: Get all configs
    console.log('Test 4: config/get (all providers, user scope)');
    const config = await sendRequest('config/get', { provider: '*', scope: 'user' });
    console.log('  Result:', JSON.stringify(config, null, 2));
    console.log('  ✓ Passed');
    console.log('');

    // Test 5: List secrets
    console.log('Test 5: secrets/list');
    const secrets = await sendRequest('secrets/list', {});
    console.log('  Result:', JSON.stringify(secrets));
    console.log('  ✓ Passed');
    console.log('');

    // Test 6: Get a specific secret (if any exist)
    if (secrets.keys && secrets.keys.length > 0) {
      const key = secrets.keys[0];
      console.log(`Test 6: secrets/get (${key})`);
      const secret = await sendRequest('secrets/get', { key });
      console.log('  Result:', secret.value ? '(value exists, hidden)' : '(no value)');
      console.log('  ✓ Passed');
      console.log('');
    }

    // Test 7: Get settings
    console.log('Test 7: config/getSettings');
    const settings = await sendRequest('config/getSettings', { scope: 'user' });
    console.log('  Result:', JSON.stringify(settings));
    console.log('  ✓ Passed');
    console.log('');

    console.log('All tests passed!');
    socket.end();
    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error.message);
    socket.end();
    process.exit(1);
  }
}
