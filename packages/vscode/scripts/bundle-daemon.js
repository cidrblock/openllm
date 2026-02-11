#!/usr/bin/env node
/**
 * Bundle the OpenLLM daemon binary for the VS Code extension.
 * 
 * This script copies the compiled daemon binary from the Cargo build output
 * to the extension's bin/ directory with the appropriate platform-specific name.
 * 
 * Usage:
 *   node bundle-daemon.js           # Bundle for current platform only
 *   node bundle-daemon.js --all     # Bundle for all platforms (requires cross-compilation)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const CARGO_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');
const BIN_DIR = path.join(EXTENSION_ROOT, 'bin');

// Platform mapping: { nodeOs-nodeArch: { target: rust-target, ext: extension } }
const PLATFORMS = {
    'linux-x64': { target: 'x86_64-unknown-linux-gnu', ext: '' },
    'linux-arm64': { target: 'aarch64-unknown-linux-gnu', ext: '' },
    'darwin-x64': { target: 'x86_64-apple-darwin', ext: '' },
    'darwin-arm64': { target: 'aarch64-apple-darwin', ext: '' },
    'win32-x64': { target: 'x86_64-pc-windows-msvc', ext: '.exe' },
    'win32-arm64': { target: 'aarch64-pc-windows-msvc', ext: '.exe' },
};

function getCurrentPlatform() {
    return `${process.platform}-${process.arch}`;
}

function ensureBinDir() {
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }
}

function findCargoOutput(rustTarget) {
    // Check if cross-compiled binary exists
    const crossPath = path.join(CARGO_ROOT, 'target', rustTarget, 'release', 'openllm');
    if (fs.existsSync(crossPath) || fs.existsSync(crossPath + '.exe')) {
        return fs.existsSync(crossPath) ? crossPath : crossPath + '.exe';
    }
    
    // Fall back to default target (current platform)
    const defaultPath = path.join(CARGO_ROOT, 'target', 'release', 'openllm');
    if (fs.existsSync(defaultPath) || fs.existsSync(defaultPath + '.exe')) {
        return fs.existsSync(defaultPath) ? defaultPath : defaultPath + '.exe';
    }
    
    return null;
}

function bundlePlatform(platformKey) {
    const platform = PLATFORMS[platformKey];
    if (!platform) {
        console.error(`Unknown platform: ${platformKey}`);
        return false;
    }
    
    const sourcePath = findCargoOutput(platform.target);
    if (!sourcePath) {
        console.warn(`Warning: No binary found for ${platformKey} (${platform.target})`);
        console.warn(`  Build it with: cargo build --release --target ${platform.target}`);
        return false;
    }
    
    const destName = `openllm-${platformKey}${platform.ext}`;
    const destPath = path.join(BIN_DIR, destName);
    
    console.log(`Bundling ${platformKey}:`);
    console.log(`  Source: ${sourcePath}`);
    console.log(`  Dest:   ${destPath}`);
    
    fs.copyFileSync(sourcePath, destPath);
    
    // Make executable on Unix
    if (!platform.ext) {
        fs.chmodSync(destPath, 0o755);
    }
    
    return true;
}

function bundleCurrentPlatform() {
    const platform = getCurrentPlatform();
    console.log(`Bundling daemon for current platform: ${platform}`);
    ensureBinDir();
    
    // First, try to build if binary doesn't exist
    const platformInfo = PLATFORMS[platform];
    if (platformInfo) {
        const sourcePath = findCargoOutput(platformInfo.target);
        if (!sourcePath) {
            console.log('Binary not found, attempting to build...');
            try {
                execSync('cargo build --release -p openllm', {
                    cwd: CARGO_ROOT,
                    stdio: 'inherit'
                });
            } catch (e) {
                console.error('Failed to build daemon:', e.message);
                console.error('Please build manually with: cargo build --release -p openllm');
                process.exit(1);
            }
        }
    }
    
    if (bundlePlatform(platform)) {
        console.log('Done!');
    } else {
        console.error('Failed to bundle daemon binary');
        process.exit(1);
    }
}

function bundleAllPlatforms() {
    console.log('Bundling daemon for all platforms');
    console.log('Note: Cross-compilation must be set up separately');
    ensureBinDir();
    
    let success = 0;
    let failed = 0;
    
    for (const platform of Object.keys(PLATFORMS)) {
        if (bundlePlatform(platform)) {
            success++;
        } else {
            failed++;
        }
    }
    
    console.log(`\nBundled ${success} platforms, ${failed} failed/skipped`);
    
    if (success === 0) {
        console.error('No binaries were bundled!');
        process.exit(1);
    }
}

// Main
const args = process.argv.slice(2);
if (args.includes('--all')) {
    bundleAllPlatforms();
} else {
    bundleCurrentPlatform();
}
