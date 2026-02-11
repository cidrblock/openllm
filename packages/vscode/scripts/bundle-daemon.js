#!/usr/bin/env node
/**
 * Bundle the OpenLLM daemon for the VS Code extension.
 * 
 * The daemon is a TypeScript/Node.js application. This script builds
 * the daemon using esbuild and copies the bundle to the extension's bin/ directory.
 * 
 * Usage:
 *   node bundle-daemon.js           # Bundle the daemon
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const DAEMON_ROOT = path.resolve(EXTENSION_ROOT, '..', 'daemon');
const BIN_DIR = path.join(EXTENSION_ROOT, 'bin');

function ensureBinDir() {
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }
}

function bundleDaemon() {
    console.log('Building OpenLLM daemon (TypeScript)...');
    ensureBinDir();
    
    // Build the daemon using its npm script
    try {
        execSync('npm run build', {
            cwd: DAEMON_ROOT,
            stdio: 'inherit',
        });
    } catch (e) {
        console.error('Failed to build daemon:', e.message);
        console.error('Ensure packages/daemon dependencies are installed: cd packages/daemon && npm install');
        process.exit(1);
    }
    
    // Copy the built daemon bundle
    const sourcePath = path.join(DAEMON_ROOT, 'dist', 'index.js');
    if (!fs.existsSync(sourcePath)) {
        console.error(`Daemon build output not found at: ${sourcePath}`);
        process.exit(1);
    }
    
    const destPath = path.join(BIN_DIR, 'openllm-daemon.js');
    fs.copyFileSync(sourcePath, destPath);
    console.log(`Bundled daemon to: ${destPath}`);
    
    // Also copy static assets if they exist
    const staticSrc = path.join(DAEMON_ROOT, 'static');
    const staticDest = path.join(BIN_DIR, 'static');
    if (fs.existsSync(staticSrc)) {
        if (!fs.existsSync(staticDest)) {
            fs.mkdirSync(staticDest, { recursive: true });
        }
        const files = fs.readdirSync(staticSrc);
        for (const file of files) {
            fs.copyFileSync(path.join(staticSrc, file), path.join(staticDest, file));
        }
        console.log(`Copied ${files.length} static file(s)`);
    }
    
    console.log('Done!');
}

bundleDaemon();
