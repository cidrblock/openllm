// Load the native module based on platform
const { platform, arch } = process;

let nativeBinding;

try {
  // Try to load the local native binding
  switch (platform) {
    case 'linux':
      if (arch === 'x64') {
        nativeBinding = require('./openllm.linux-x64-gnu.node');
      }
      break;
    case 'darwin':
      if (arch === 'x64') {
        nativeBinding = require('./openllm.darwin-x64.node');
      } else if (arch === 'arm64') {
        nativeBinding = require('./openllm.darwin-arm64.node');
      }
      break;
    case 'win32':
      if (arch === 'x64') {
        nativeBinding = require('./openllm.win32-x64-msvc.node');
      }
      break;
  }
} catch (e) {
  console.error('Failed to load native module:', e.message);
  throw e;
}

if (!nativeBinding) {
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

module.exports = nativeBinding;
