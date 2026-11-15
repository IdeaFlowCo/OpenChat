// Real RN-web input regression. Requires npm ci and a sandboxed Chrome/Chromium.
// Run from any directory: node scripts/test-context-composer-browser.cjs
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openchat-composer-browser-'));
const mocks = {
  '/contexts/ThemeContext': "export const useTheme = () => ({ scheme: 'light' });",
  '/services/contextLane': 'export const contextLaneManager = { addPost: async () => {}, updatePost: async () => {} };',
};

async function main() {
  await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ContextComposer } from './apps/mobile/src/components/ContextComposer';
        createRoot(document.getElementById('root')).render(<ContextComposer conversationId="synthetic" />);
        const settle = () => new Promise(resolve => setTimeout(resolve, 75));
        (async () => {
          await settle();
          const input = document.querySelector('textarea');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          const results = [];
          input.focus();
          await settle();
          for (const value of [Array(15).fill('A synthetic draft line').join('\\n'), 'short draft', Array(15).fill('Another draft line').join('\\n'), '']) {
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await settle();
            results.push({
              height: input.getBoundingClientRect().height,
              value: input.value,
              focused: document.activeElement === input,
              sameNode: document.querySelector('textarea') === input,
            });
          }
          document.getElementById('result').textContent = JSON.stringify(results);
        })().catch(error => { document.getElementById('result').textContent = JSON.stringify({ error: String(error) }); });
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    outfile: path.join(temporary, 'bundle.js'),
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { 'react-native': 'react-native-web' },
    plugins: [{
      name: 'synthetic-services',
      setup(build) {
        build.onResolve({ filter: /\/(contexts\/ThemeContext|services\/contextLane)$/ }, ({ path: imported }) => {
          const key = Object.keys(mocks).find(key => imported.endsWith(key));
          return key ? { path: key, namespace: 'synthetic' } : undefined;
        });
        build.onLoad({ filter: /.*/, namespace: 'synthetic' }, ({ path: key }) => ({ contents: mocks[key], loader: 'js' }));
      },
    }],
  });
  fs.writeFileSync(path.join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root" style="width:400px"></div><pre id="result"></pre><script src="bundle.js"></script>');
  const chrome = spawnSync(process.env.CHROME_BIN || 'google-chrome', [
    '--headless', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${path.join(temporary, 'profile')}`,
    '--dump-dom', '--virtual-time-budget=2000', `file://${temporary}/index.html`,
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(chrome.error);
  assert.equal(chrome.status, 0, chrome.stderr);
  const serialized = chrome.stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
  assert.ok(serialized, 'Chrome did not finish the composer regression');
  const results = JSON.parse(serialized);
  assert.ok(Array.isArray(results), JSON.stringify(results));
  assert.deepEqual(results.map(result => result.height), [120, 44, 120, 44], JSON.stringify(results));
  assert.equal(results[1].value, 'short draft');
  assert.equal(results[3].value, '');
  for (const result of results) {
    assert.equal(result.focused, true, 'Editing must retain input focus');
    assert.equal(result.sameNode, true, 'Editing must retain the multiline input');
  }
  console.log('PASS real RN-web composer grows, shrinks, regrows and clears without replacing the focused input');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});
