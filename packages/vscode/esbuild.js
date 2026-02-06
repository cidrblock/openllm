const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const nativeNodeModulesPlugin = {
  name: 'native-node-modules',
  setup(build) {
    // Mark .node files as external - they'll be copied separately
    build.onResolve({ filter: /\.node$/ }, args => {
      return { path: args.path, external: true };
    });
  },
};

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    plugins: [
      nativeNodeModulesPlugin,
      ...(watch ? [esbuildProblemMatcherPlugin] : []),
    ],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  // Copy native module to out directory
  // Primary: use the npm package location (crates/openllm-napi/npm/)
  // Fallback: check node_modules/@openllm/native
  const npmNativeDir = path.resolve(__dirname, '../../crates/openllm-napi/npm');
  const nodeModulesNativeDir = path.resolve(__dirname, '../../node_modules/@openllm/native');
  const nativeDir = fs.existsSync(npmNativeDir) ? npmNativeDir : nodeModulesNativeDir;
  const outNativeDir = path.resolve(__dirname, 'out/native');

  console.log(`Using native bindings from: ${nativeDir}`);

  if (!fs.existsSync(outNativeDir)) {
    fs.mkdirSync(outNativeDir, { recursive: true });
  }

  // Copy all .node files and index.js
  if (fs.existsSync(nativeDir)) {
    const files = fs.readdirSync(nativeDir);
    for (const file of files) {
      if (file.endsWith('.node') || file === 'index.js' || file === 'package.json') {
        fs.copyFileSync(
          path.join(nativeDir, file),
          path.join(outNativeDir, file)
        );
        console.log(`Copied ${file} to out/native/`);
      }
    }
  } else {
    console.warn('WARNING: Native bindings directory not found!');
  }

  // Copy codicons to out directory
  const codiconsDir = path.resolve(__dirname, '../../node_modules/@vscode/codicons/dist');
  const outCodiconsDir = path.resolve(__dirname, 'out/codicons');

  if (!fs.existsSync(outCodiconsDir)) {
    fs.mkdirSync(outCodiconsDir, { recursive: true });
  }

  // Copy CSS and font files
  const codiconFiles = ['codicon.css', 'codicon.ttf'];
  for (const file of codiconFiles) {
    const srcPath = path.join(codiconsDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(outCodiconsDir, file));
      console.log(`Copied ${file} to out/codicons/`);
    }
  }

  // Copy marked library
  const markedSrc = path.resolve(__dirname, '../../node_modules/marked/lib/marked.umd.js');
  const outLibDir = path.resolve(__dirname, 'out/lib');
  if (!fs.existsSync(outLibDir)) {
    fs.mkdirSync(outLibDir, { recursive: true });
  }
  if (fs.existsSync(markedSrc)) {
    fs.copyFileSync(markedSrc, path.join(outLibDir, 'marked.umd.js'));
    console.log('Copied marked.umd.js to out/lib/');
  }

  // Copy highlight.js
  const hljsDir = path.resolve(__dirname, '../../node_modules/@highlightjs/cdn-assets');
  if (fs.existsSync(hljsDir)) {
    fs.copyFileSync(
      path.join(hljsDir, 'highlight.min.js'),
      path.join(outLibDir, 'highlight.min.js')
    );
    console.log('Copied highlight.min.js to out/lib/');
    
    const hljsStylesDir = path.join(hljsDir, 'styles');
    if (fs.existsSync(path.join(hljsStylesDir, 'vs2015.min.css'))) {
      fs.copyFileSync(
        path.join(hljsStylesDir, 'vs2015.min.css'),
        path.join(outLibDir, 'vs2015.min.css')
      );
      console.log('Copied vs2015.min.css to out/lib/');
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
