#!/usr/bin/env node
/**
 * OpenLLM Daemon - TypeScript Implementation
 *
 * Usage:
 *   openllm daemon       # Start daemon (foreground)
 *   openllm status       # Check daemon status
 *   openllm stop         # Stop running daemon
 *   openllm web          # Start web dashboard
 */
import { Command } from 'commander';
import { startDaemon, stopDaemon, getDaemonStatus } from './daemon.js';
import { isDaemonRunningSync } from './transport.js';
import { startEmbeddedWebServer } from './web/server.js';
const VERSION = '0.1.0';
const program = new Command();
program
    .name('openllm')
    .description('OpenLLM - Unified AI Daemon')
    .version(VERSION);
program
    .command('daemon')
    .description('Start the daemon (foreground)')
    .action(async () => {
    try {
        await startDaemon();
    }
    catch (error) {
        console.error('Failed to start daemon:', error);
        process.exit(1);
    }
});
program
    .command('status')
    .description('Check if daemon is running')
    .action(() => {
    const status = getDaemonStatus();
    if (status.running) {
        console.log('OpenLLM daemon is running');
        if (status.pid) {
            console.log(`  PID: ${status.pid}`);
        }
        console.log(`  Socket: ${status.socketPath}`);
    }
    else {
        console.log('OpenLLM daemon is not running');
        process.exit(1);
    }
});
program
    .command('stop')
    .description('Stop the running daemon')
    .action(async () => {
    try {
        await stopDaemon();
        console.log('Daemon stopped');
    }
    catch (error) {
        console.error('Failed to stop daemon:', error);
        process.exit(1);
    }
});
program
    .command('web')
    .description('Start web dashboard')
    .option('-p, --port <port>', 'Port to listen on', '8787')
    .action(async (options) => {
    const port = parseInt(options.port, 10);
    let daemonStartedHere = false;
    try {
        if (isDaemonRunningSync()) {
            // ─── Case A: Daemon already running ───────────────────────────
            // Send gRPC StartWebServer to the existing daemon process.
            console.log('Daemon is running, requesting web server start via gRPC...');
            const { sendStartWebServer, sendStopWebServer } = await import('./web/grpc-web-control.js');
            const result = await sendStartWebServer(port);
            console.log(`OpenLLM Web Dashboard: ${result.url}`);
            if (result.already_running) {
                console.log('(web server was already running)');
            }
            // Wait for Ctrl+C, then send StopWebServer
            await new Promise((resolve) => {
                const shutdown = async () => {
                    console.log('\nStopping web server...');
                    try {
                        await sendStopWebServer();
                    }
                    catch { }
                    resolve();
                };
                process.on('SIGINT', shutdown);
                process.on('SIGTERM', shutdown);
            });
        }
        else {
            // ─── Case B: No daemon running ────────────────────────────────
            // Start daemon in-process, then start web server alongside it.
            console.log('No daemon running, starting daemon + web server...');
            daemonStartedHere = true;
            const daemonState = await startDaemon({ keepAlive: false });
            const { url } = await startEmbeddedWebServer(daemonState, port);
            console.log(`OpenLLM Web Dashboard: ${url}`);
            console.log('Press Ctrl+C to stop');
            // Keep alive until Ctrl+C (shutdown handler is already registered by startDaemon)
            await new Promise(() => { });
        }
    }
    catch (error) {
        console.error('Failed to start web server:', error.message || error);
        process.exit(1);
    }
});
// Default: show help
if (process.argv.length <= 2) {
    program.help();
}
program.parse();
//# sourceMappingURL=index.js.map