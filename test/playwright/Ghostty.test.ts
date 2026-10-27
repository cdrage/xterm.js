/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ITerminalInitOnlyOptions, Terminal } from '@xterm/xterm';
import type { WebglAddon } from '../../addons/addon-webgl/typings/addon-webgl';
import type { SearchAddon } from '../../addons/addon-search/typings/addon-search';
import type { SerializeAddon } from '../../addons/addon-serialize/typings/addon-serialize';
import type { ImageAddon } from '../../addons/addon-image/typings/addon-image';
import type { UnicodeGraphemesAddon } from '../../addons/addon-unicode-graphemes/typings/addon-unicode-graphemes';

declare const window: Window & {
  term: Terminal;
  Terminal: typeof Terminal;
  WebglAddon: typeof WebglAddon;
  SearchAddon: typeof SearchAddon;
  SerializeAddon: typeof SerializeAddon;
  ImageAddon: typeof ImageAddon;
  UnicodeGraphemesAddon: typeof UnicodeGraphemesAddon;
};

test.describe('Ghostty engine', () => {
  test.skip(!existsSync(resolve('demo/dist/ghostty-vt.wasm')), 'Run npm run setup-ghostty');

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3000/test');
    await page.evaluate(async () => {
      const response = await fetch('/dist/ghostty-vt.wasm');
      const module = await WebAssembly.compile(await response.arrayBuffer());
      window.term = new window.Terminal({
        allowProposedApi: true,
        vtEngine: 'ghostty',
        ghosttyModule: module,
        cols: 20,
        rows: 5,
        theme: { foreground: '#ffffff', background: '#000000' }
      });
      window.term.open(document.getElementById('terminal-container')!);
    });
  });

  test('renders through the DOM renderer and supports selection', async ({ page }) => {
    await page.evaluate(() => new Promise<void>(resolve => window.term.write('hello\r\n\x1b[31mGhostty\x1b[0m 👩\u200d💻', resolve)));
    await expect(page.locator('.xterm-rows')).toContainText('Ghostty');
    expect(await page.evaluate(() => {
      window.term.select(0, 1, 7);
      return window.term.getSelection();
    })).toBe('Ghostty');
    expect(await page.evaluate(() => window.term.buffer.active.getLine(1)!.getCell(8)!.getChars())).toBe('👩\u200d💻');
  });

  test('renders with WebGL and keeps decorations, search, and serialization', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const renderer = new window.WebglAddon();
      window.term.loadAddon(renderer);
      const search = new window.SearchAddon();
      window.term.loadAddon(search);
      const serialize = new window.SerializeAddon();
      window.term.loadAddon(serialize);
      await new Promise<void>(resolve => window.term.write('hello Ghostty\r\nnext', resolve));
      const marker = window.term.registerMarker(-1)!;
      const decoration = window.term.registerDecoration({ marker, backgroundColor: '#ff0000' });
      return {
        found: search.findNext('Ghostty'),
        selection: window.term.getSelection(),
        serialized: serialize.serialize(),
        decoration: !!decoration
      };
    });
    expect(result.found).toBe(true);
    expect(result.selection).toBe('Ghostty');
    expect(result.serialized).toContain('hello Ghostty');
    expect(result.decoration).toBe(true);
    await expect(page.locator('.xterm-screen canvas')).not.toHaveCount(0);
  });

  test('preserves host color policy after a custom handler declines', async ({ page }) => {
    const replies = await page.evaluate(async () => {
      const replies: string[] = [];
      window.term.onData(data => replies.push(data));
      window.term.parser.registerOscHandler(10, () => false);
      await new Promise<void>(resolve => window.term.write('\x1b]10;?\x07', resolve));
      return replies;
    });
    expect(replies).toEqual(['\x1b]10;rgb:ffff/ffff/ffff\x1b\\']);
  });

  test('uses Ghostty modes for keyboard input and paste', async ({ page }) => {
    await page.evaluate(async () => {
      const input: string[] = [];
      window.term.onData(data => input.push(data));
      Object.assign(window, { ghosttyInput: input });
      await new Promise<void>(resolve => window.term.write('\x1b[?1;2004h', resolve));
      window.term.focus();
    });
    await page.keyboard.press('ArrowUp');
    await page.evaluate(() => window.term.paste('hello\nworld'));
    expect(await page.evaluate('window.ghosttyInput')).toEqual(['\x1bOA', '\x1b[200~hello\rworld\x1b[201~']);
  });

  test('serializes the current attributes after alternate screen exit', async ({ page }) => {
    const colors = await page.evaluate(async () => {
      const serialize = new window.SerializeAddon();
      window.term.loadAddon(serialize);
      await new Promise<void>(resolve => window.term.write('\x1b[31mred\x1b[?1049h\x1b[32mgreen\x1b[?1049l', resolve));
      const restored = new window.Terminal({ allowProposedApi: true, cols: 20, rows: 5 });
      const data = serialize.serialize();
      await new Promise<void>(resolve => restored.write(data + '!', resolve));
      await new Promise<void>(resolve => window.term.write('!', resolve));
      const colors = [window.term, restored].map(term => term.buffer.active.getLine(0)!.getCell(3)!.getFgColor());
      restored.dispose();
      return colors;
    });
    expect(colors[1]).toBe(colors[0]);
  });

  test('switches engines through the demo selector', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:3000/');
    await page.waitForFunction(() => !!window.term);
    expect(await page.evaluate(() => (window.term.options as ITerminalInitOnlyOptions).vtEngine)).toBe('xterm');
    await page.locator('#opt-vtEngine').selectOption('ghostty', { force: true });
    await page.waitForURL('**/?vtEngine=ghostty');
    await page.waitForFunction(() => (window.term?.options as ITerminalInitOnlyOptions)?.vtEngine === 'ghostty');
    await page.locator('#opt-vtEngine').selectOption('xterm', { force: true });
    await page.waitForURL('**/?vtEngine=xterm');
    await page.waitForFunction(() => (window.term?.options as ITerminalInitOnlyOptions)?.vtEngine === 'xterm');
    expect(errors).toEqual([]);
  });

  test('keeps selection on its text when history reaches its limit', async ({ page }) => {
    const selection = await page.evaluate(async () => {
      window.term.options.scrollback = 2;
      await new Promise<void>(resolve => window.term.write('0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6', resolve));
      window.term.select(0, 2, 1);
      await new Promise<void>(resolve => window.term.write('\r\n7', resolve));
      return window.term.getSelection();
    });
    expect(selection).toBe('2');
  });

  test('rejects incompatible image and Unicode addons', async ({ page }) => {
    const errors = await page.evaluate(() => {
      const errors: string[] = [];
      for (const addon of [new window.ImageAddon(), new window.UnicodeGraphemesAddon()]) {
        try {
          window.term.loadAddon(addon);
        } catch (error) {
          errors.push(String(error));
        }
      }
      return errors;
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('image addon');
    expect(errors[1]).toContain('Unicode');
  });
});
