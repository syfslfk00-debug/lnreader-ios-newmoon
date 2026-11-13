// Run after pnpm install. Set PLAYWRIGHT_MODULE to a Playwright installation
// and CHROMIUM_PATH when using the system browser. No app source is mocked.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const babel = require('@babel/core');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (!path.extname(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '.js';
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    filename: file,
    configFile: false,
    babelrc: false,
    presets: file.endsWith('.ts') ? ['@babel/preset-typescript'] : [],
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  }).code;
  new Function('require', 'module', 'exports', code)(
    name => load(path.resolve(path.dirname(file), name)),
    module,
    module.exports,
  );
  return module.exports;
}
async function main() {
  const { default: buildShell } = load('src/reader/newmoon/worShell.js');
  const { buildWorSectionHTML, DEFAULT_SETTINGS } = load(
    'src/reader/newmoon/sections.ts',
  );
  const settings = {
    ...DEFAULT_SETTINGS,
    dockOpen: false,
    enableBracket: true,
  };
  const chapter = number => ({
    kind: 'chapter',
    number,
    title: 'Chapter ' + number,
    total: 3,
    hasNext: true,
    hasPrev: number > 1,
    scrollOffset: 0,
    html: buildWorSectionHTML(
      {
        number,
        title: 'Chapter ' + number,
        content: Array.from(
          { length: 360 },
          (_, i) => `Paragraph ${i}. [The moon rose over the quiet hills.]`,
        ).join('\n'),
      },
      0,
      settings,
    ),
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('captureMoonMessage', message => message);
    await page.setContent('<html></html>');
    await page.evaluate(() => {
      window.moonMessages = [];
      window.ReactNativeWebView = {
        postMessage: value => window.moonMessages.push(JSON.parse(value)),
      };
    });
    await page.setContent(
      buildShell({ novelTitle: 'Test', initialSettings: settings }),
    );
    await page.waitForFunction(() => window.__wor);
    const receive = message =>
      page.evaluate(message => window.__wor.receive(message), message);
    await receive(chapter(1));
    await receive({
      kind: 'trConfig',
      enabled: true,
      target: 'ar',
      rtl: true,
      caps: { maxCharacters: 120000, maxSegments: 4096 },
    });
    await receive({
      kind: 'trStart',
      target: 'ar',
      caps: { maxCharacters: 120000, maxSegments: 4096 },
    });
    await page.waitForFunction(() =>
      window.moonMessages.some(
        message => message.t === 'trCollect' && message.segments?.length,
      ),
    );
    const collected = await page.evaluate(() =>
      window.moonMessages.find(
        message => message.t === 'trCollect' && message.segments?.length,
      ),
    );
    assert.equal(
      collected.segments.length,
      360,
      'AI must collect offscreen paragraphs in the same chapter',
    );
    assert(collected.segments[359].text.startsWith('Paragraph 359.'));
    const id = collected.segments[0].id;
    await receive({
      kind: 'trApply',
      expected: 1,
      items: [{ id, text: '[مرحبا بالعالم] <img src=x onerror=alert(1)>' }],
    });
    await page.waitForFunction(() =>
      document.querySelector('[data-wor-tr-text]'),
    );
    assert.equal(
      await page.locator('[data-wor-tr-text] .bracket-formatted').count(),
      1,
    );
    assert.equal(
      await page.locator('[data-wor-tr-text] img').count(),
      0,
      'provider markup must remain escaped',
    );
    assert.equal(
      await page.locator('[data-wor-tr-text]').getAttribute('dir'),
      'rtl',
    );
    await receive({
      kind: 'settings',
      settings: { selectedBracketStyle: 'guillemets' },
    });
    assert(
      (await page.locator('[data-wor-tr-text]').textContent()).includes(
        '«مرحبا بالعالم»',
      ),
    );
    assert.equal(
      await page
        .locator('#worTextSurface')
        .evaluate(el => getComputedStyle(el).userSelect),
      'text',
    );
    assert.equal(
      await page.locator('[data-wor-tr-text]').evaluate(el => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return String(selection).includes('مرحبا');
      }),
      true,
    );
    await page.evaluate(() => {
      window.getSelection().removeAllRanges();
      window.scrollTo(0, 1500);
    });
    await receive({ ...chapter(1), scrollOffset: 1400 });
    await receive(chapter(2));
    await page.waitForTimeout(1050);
    assert.equal(
      await page.evaluate(() => Math.round(window.scrollY)),
      0,
      'new chapter must start at zero and cancel old restore timers',
    );
    await receive({ ...chapter(2), scrollOffset: 1400 });
    await page.waitForTimeout(400);
    assert(
      (await page.evaluate(() => window.scrollY)) >= 1400,
      'saved chapter position must still restore',
    );
    await page.screenshot({ path: '/tmp/moon-reader-regression.png' });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          engine: 'Chromium',
          paragraphsCollected: 360,
          translatedFormatting: 'passed',
          safeMarkup: 'passed',
          nativeSelectionCSS: 'passed',
          newChapterReset: 'passed',
          savedPosition: 'passed',
          iosMomentum: 'requires simulator/device',
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
