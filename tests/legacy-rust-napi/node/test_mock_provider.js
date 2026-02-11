/**
 * Test MockProvider NAPI bindings
 * 
 * Tests that the streaming callback mechanism works correctly
 * through the NAPI bindings.
 */

const path = require('path');

// Load the native module
const nativeModule = require(path.join(__dirname, '../../crates/openllm-napi/npm/openllm.linux-x64-gnu.node'));

async function testEchoMode() {
    console.log('\n=== Test: Echo Mode ===');
    
    const provider = new nativeModule.MockProvider();
    console.log('Provider name:', provider.name);
    console.log('Metadata:', provider.metadata());
    
    // Note: NAPI ChatMessage uses capitalized role enum and simple string content
    // Use undefined (not null) for optional fields
    const messages = [{
        role: 'User',
        content: 'Hello, MockProvider!'
    }];
    
    const config = {
        model: 'mock-echo'
        // apiKey and apiBase are optional - just omit them
    };
    
    let chunks = [];
    let errorOccurred = null;
    
    await new Promise((resolve, reject) => {
        provider.streamChat(messages, config, undefined, (err, chunk) => {
            if (err) {
                console.error('Callback error:', err.message);
                errorOccurred = err;
                return;
            }
            if (chunk) {
                console.log('Received chunk:', JSON.stringify(chunk));
                chunks.push(chunk);
            }
        }).then(resolve).catch(reject);
    });
    
    console.log('Total chunks received:', chunks.length);
    
    // Combine text chunks - handle both possible formats
    const fullText = chunks
        .filter(c => c.chunkType === 'text' || c.type === 'text' || c.Text)
        .map(c => c.text || c.Text?.text || '')
        .join('');
    
    console.log('Full response:', fullText);
    
    if (!fullText.includes('Hello, MockProvider!')) {
        throw new Error(`Echo mode did not echo the message! Got: "${fullText}"`);
    }
    
    if (errorOccurred) {
        throw errorOccurred;
    }
    
    console.log('✓ Echo mode test passed');
}

async function testFixedMode() {
    console.log('\n=== Test: Fixed Response Mode ===');
    
    const provider = nativeModule.MockProvider.fixed('This is a fixed response from the mock provider.');
    
    const messages = [{
        role: 'User',
        content: 'Any message'
    }];
    
    const config = {
        model: 'mock-fixed'
    };
    
    let chunks = [];
    
    await new Promise((resolve, reject) => {
        provider.streamChat(messages, config, undefined, (err, chunk) => {
            if (err) {
                console.error('Callback error:', err.message);
                return;
            }
            if (chunk) {
                chunks.push(chunk);
            }
        }).then(resolve).catch(reject);
    });
    
    console.log('Total chunks received:', chunks.length);
    
    const fullText = chunks
        .filter(c => c.chunkType === 'text' || c.type === 'text' || c.Text)
        .map(c => c.text || c.Text?.text || '')
        .join('');
    
    console.log('Full response:', fullText);
    
    if (fullText !== 'This is a fixed response from the mock provider.') {
        throw new Error(`Fixed mode did not return expected response! Got: "${fullText}"`);
    }
    
    console.log('✓ Fixed mode test passed');
}

async function testChunkedMode() {
    console.log('\n=== Test: Chunked Mode ===');
    
    const expectedChunks = ['First ', 'second ', 'third.'];
    const provider = nativeModule.MockProvider.chunked(expectedChunks, 10);
    
    const messages = [{
        role: 'User',
        content: 'Any message'
    }];
    
    const config = {
        model: 'mock-chunked'
    };
    
    let receivedChunks = [];
    
    await new Promise((resolve, reject) => {
        provider.streamChat(messages, config, undefined, (err, chunk) => {
            if (err) {
                console.error('Callback error:', err.message);
                return;
            }
            if (chunk) {
                const text = chunk.text || chunk.Text?.text || '';
                if (text) {
                    receivedChunks.push(text);
                }
            }
        }).then(resolve).catch(reject);
    });
    
    console.log('Expected chunks:', expectedChunks);
    console.log('Received chunks:', receivedChunks);
    
    if (JSON.stringify(receivedChunks) !== JSON.stringify(expectedChunks)) {
        throw new Error('Chunked mode did not return expected chunks!');
    }
    
    console.log('✓ Chunked mode test passed');
}

async function testErrorMode() {
    console.log('\n=== Test: Error Mode ===');
    
    const provider = nativeModule.MockProvider.error('Simulated API error');
    
    const messages = [{
        role: 'User',
        content: 'Any message'
    }];
    
    const config = {
        model: 'mock-error'
    };
    
    let errorReceived = null;
    
    await new Promise((resolve, reject) => {
        provider.streamChat(messages, config, undefined, (err, chunk) => {
            if (err) {
                console.log('Received expected error:', err.message);
                errorReceived = err;
            }
        }).then(resolve).catch(reject);
    });
    
    if (!errorReceived) {
        throw new Error('Error mode did not produce an error!');
    }
    
    console.log('✓ Error mode test passed');
}

async function testStreamChatWithProvider() {
    console.log('\n=== Test: stream_chat_with_provider factory ===');
    
    const messages = [{
        role: 'User',
        content: 'Testing factory function'
    }];
    
    const config = {
        model: 'mock-echo'
    };
    
    let chunks = [];
    
    await new Promise((resolve, reject) => {
        nativeModule.streamChatWithProvider('mock', messages, config, undefined, (err, chunk) => {
            if (err) {
                console.error('Callback error:', err.message);
                return;
            }
            if (chunk) {
                chunks.push(chunk);
            }
        }).then(resolve).catch(reject);
    });
    
    console.log('Total chunks received:', chunks.length);
    
    const fullText = chunks
        .filter(c => c.chunkType === 'text' || c.type === 'text' || c.Text)
        .map(c => c.text || c.Text?.text || '')
        .join('');
    
    console.log('Full response:', fullText);
    
    if (!fullText.includes('Testing factory function')) {
        throw new Error(`Factory function did not work correctly! Got: "${fullText}"`);
    }
    
    console.log('✓ Factory function test passed');
}

async function runAllTests() {
    console.log('==============================================');
    console.log('MockProvider NAPI Tests');
    console.log('==============================================');
    
    try {
        await testEchoMode();
        await testFixedMode();
        await testChunkedMode();
        await testErrorMode();
        await testStreamChatWithProvider();
        
        console.log('\n==============================================');
        console.log('All tests passed! ✓');
        console.log('==============================================');
        process.exit(0);
    } catch (err) {
        console.error('\n==============================================');
        console.error('TEST FAILED:', err.message);
        console.error(err.stack);
        console.error('==============================================');
        process.exit(1);
    }
}

runAllTests();
