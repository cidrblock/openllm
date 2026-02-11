#!/usr/bin/env node
/**
 * Bundle the OpenLLM daemon for the VS Code extension.
 * 
 * Uses esbuild to create a single self-contained JS file from the daemon's
 * TypeScript source, then copies proto and static assets alongside it.
 * 
 * Output layout:
 *   bin/
 *     openllm-daemon.js    ← esbuild single-file bundle (ESM)
 *     proto/
 *       openllm/v1/service.proto
 *     static/
 *       index.html
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const DAEMON_ROOT = path.resolve(EXTENSION_ROOT, '..', 'daemon');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');
const BIN_DIR = path.join(EXTENSION_ROOT, 'bin');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyDirRecursive(src, dest) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function bundleDaemon() {
    console.log('Building OpenLLM daemon bundle with esbuild...');
    ensureDir(BIN_DIR);
    
    // First, build the daemon with tsc so type-checking passes
    try {
        execSync('npm run build', {
            cwd: DAEMON_ROOT,
            stdio: 'inherit',
        });
    } catch (e) {
        console.error('Failed to build daemon:', e.message);
        process.exit(1);
    }
    
    // Bundle with esbuild into a single file
    // - platform: node (Node.js APIs available)
    // - format: esm (daemon uses ESM)
    // - external: keytar (native addon, optional — daemon gracefully degrades)
    const outFile = path.join(BIN_DIR, 'openllm-daemon.js');
    
    try {
        const esbuildBin = path.join(DAEMON_ROOT, 'node_modules', '.bin', 'esbuild');
        const entryPoint = path.join(DAEMON_ROOT, 'src', 'index.ts');
        
        execSync(
            `"${esbuildBin}" "${entryPoint}" ` +
            `--bundle ` +
            `--platform=node ` +
            `--format=esm ` +
            `--target=node20 ` +
            `--outfile="${outFile}" ` +
            `--external:keytar ` +
            `--banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"`,
            {
                cwd: DAEMON_ROOT,
                stdio: 'inherit',
            }
        );
        console.log(`Bundled daemon to: ${outFile}`);
    } catch (e) {
        console.error('esbuild bundle failed:', e.message);
        process.exit(1);
    }
    
    // Copy proto files
    const protoSrc = path.join(REPO_ROOT, 'proto');
    const protoDest = path.join(BIN_DIR, 'proto');
    if (fs.existsSync(protoSrc)) {
        copyDirRecursive(protoSrc, protoDest);
        console.log('Copied proto files');
    } else {
        console.error(`Proto directory not found: ${protoSrc}`);
        process.exit(1);
    }
    
    // Copy static assets (dashboard HTML)
    const staticSrc = path.join(DAEMON_ROOT, 'static');
    const staticDest = path.join(BIN_DIR, 'static');
    if (fs.existsSync(staticSrc)) {
        ensureDir(staticDest);
        const files = fs.readdirSync(staticSrc);
        for (const file of files) {
            fs.copyFileSync(path.join(staticSrc, file), path.join(staticDest, file));
        }
        console.log(`Copied ${files.length} static file(s)`);
    }
    
    // Copy keytar native module (external in esbuild, needs node_modules structure)
    // keytar is a native C++ addon that can't be bundled by esbuild.
    // We copy the minimal files needed: package.json, lib/keytar.js, build/Release/keytar.node
    const keytarSrc = path.join(REPO_ROOT, 'node_modules', 'keytar');
    const keytarDest = path.join(BIN_DIR, 'node_modules', 'keytar');
    if (fs.existsSync(keytarSrc)) {
        ensureDir(path.join(keytarDest, 'lib'));
        ensureDir(path.join(keytarDest, 'build', 'Release'));
        
        fs.copyFileSync(
            path.join(keytarSrc, 'package.json'),
            path.join(keytarDest, 'package.json')
        );
        fs.copyFileSync(
            path.join(keytarSrc, 'lib', 'keytar.js'),
            path.join(keytarDest, 'lib', 'keytar.js')
        );
        const nativeAddon = path.join(keytarSrc, 'build', 'Release', 'keytar.node');
        if (fs.existsSync(nativeAddon)) {
            fs.copyFileSync(
                nativeAddon,
                path.join(keytarDest, 'build', 'Release', 'keytar.node')
            );
            console.log('Copied keytar native module');
        } else {
            console.warn('WARNING: keytar.node not found — keychain storage will be unavailable');
        }
    } else {
        console.warn('WARNING: keytar not found in node_modules — keychain storage will be unavailable');
    }
    
    console.log('Done!');
}

bundleDaemon();
