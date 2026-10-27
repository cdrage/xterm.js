/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { strict as assert } from 'assert';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Terminal } from './Terminal';
import type { IParser } from '@xterm/xterm';
import type { IAttributeData } from '../../common/buffer/Types';

describe('Ghostty engine', () => {
  const artifact = resolve('demo/dist/ghostty-vt.wasm');
  let module: WebAssembly.Module;
  let term: Terminal;
  const write = (data: string | Uint8Array): Promise<void> => new Promise(resolve => term.write(data, resolve));
  const text = (row: number): string => term.buffer.active.getLine(row)!.translateToString(true);

  before(function (): void {
    if (!existsSync(artifact)) {
      this.skip();
    }
    module = new WebAssembly.Module(readFileSync(artifact));
  });

  beforeEach(() => {
    term = new Terminal({ allowProposedApi: true, vtEngine: 'ghostty', ghosttyModule: module, cols: 20, rows: 4, scrollback: 10 });
  });
  afterEach(() => term?.dispose());

  it('requires explicit opt-in and a module', () => {
    assert.throws(() => new Terminal({ vtEngine: 'ghostty' }), /allowProposedApi and ghosttyModule/);
    assert.throws(() => new Terminal({ vtEngine: 'ghostty', ghosttyModule: module }), /allowProposedApi/);
    assert.throws(() => new Terminal({ vtEngine: 'ghostty', allowProposedApi: true }), /ghosttyModule/);
    assert.throws(() => { term.options = { vtEngine: 'xterm' }; }, /constructor/);
    const native = new Terminal();
    assert.equal(native.options.vtEngine, 'xterm');
    native.dispose();
  });

  it('rejects invalid modules and dimensions', () => {
    const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    assert.throws(() => new Terminal({ vtEngine: 'ghostty', allowProposedApi: true, ghosttyModule: empty }), /missing memory/);
    assert.throws(() => new Terminal({ vtEngine: 'ghostty', allowProposedApi: true, ghosttyModule: module, cols: 65536 }), /dimensions/);
  });

  it('exposes text, cursor, colors, and wide cells', async () => {
    await write('hello\r\n\x1b[1;3;4;38;2;12;34;56m你!');
    assert.equal(text(0), 'hello');
    assert.equal(text(1), '你!');
    assert.equal(term.buffer.active.cursorX, 3);
    assert.equal(term.buffer.active.cursorY, 1);
    const cell = term.buffer.active.getLine(1)!.getCell(0)!;
    assert.equal(cell.getWidth(), 2);
    assert.equal(cell.getFgColor(), 0x0c2238);
    assert.ok(cell.isBold());
    assert.ok(cell.isItalic());
    assert.ok(cell.isUnderline());
    assert.equal(term.buffer.active.getLine(1)!.getCell(1)!.getWidth(), 0);
  });

  it('uses Ghostty grapheme widths across writes without a Unicode addon', async () => {
    await write('e');
    await write('\u0301👩');
    await write('\u200d💻');
    assert.equal(text(0), 'e\u0301👩\u200d💻');
    assert.equal(term.buffer.active.cursorX, 3);
    assert.equal(term.buffer.active.getLine(0)!.getCell(1)!.getChars(), '👩\u200d💻');
  });

  it('decodes partial UTF-8 and UTF-16 input', async () => {
    const bytes = new TextEncoder().encode('你🙂');
    for (const byte of bytes) {
      await write(new Uint8Array([byte]));
    }
    await write('\ud83d');
    await write('\ude00');
    assert.equal(text(0), '你🙂😀');
  });

  it('dispatches bell, title, and terminal replies', async () => {
    const events: string[] = [];
    term.onBell(() => events.push('bell'));
    term.onTitleChange(title => events.push(title));
    term.onData(data => events.push(data));
    await write('abc\x07\x1b]2;title\x07');
    await write('\x1b[6n\x1b[c');
    assert.deepEqual(events, ['bell', 'title', '\x1b[1;4R', '\x1b[?1;2c']);
  });

  it('synchronizes input modes', async () => {
    await write('\x1b[?1;6;2004;1004;1003;1006h\x1b[4h\x1b[?25l');
    assert.equal(term.modes.applicationCursorKeysMode, true);
    assert.equal(term.modes.originMode, true);
    assert.equal(term.modes.bracketedPasteMode, true);
    assert.equal(term.modes.sendFocusMode, true);
    assert.equal(term.modes.mouseTrackingMode, 'any');
    assert.equal(term.modes.insertMode, true);
    assert.equal(term.modes.showCursor, false);
  });

  it('preserves both screens across alternate-buffer switches', async () => {
    await write('normal\x1b[?1049halternate');
    assert.equal(term.buffer.active.type, 'alternate');
    assert.equal(term.buffer.normal.getLine(0)!.translateToString(true), 'normal');
    assert.ok(text(0).includes('alternate'));
    await write('\x1b[?1049l!');
    assert.equal(term.buffer.active.type, 'normal');
    assert.equal(text(0), 'normal!');
  });

  it('caps exposed scrollback and scrolls the viewport', async () => {
    for (let i = 0; i < 30; i++) {
      await write(`${i}\r\n`);
    }
    assert.equal(term.buffer.active.length, 14);
    assert.equal(term.buffer.active.baseY, 10);
    term.scrollToTop();
    assert.equal(term.buffer.active.viewportY, 0);
    term.scrollToBottom();
    assert.equal(term.buffer.active.viewportY, 10);
  });

  it('reflows the Ghostty buffer on resize', async () => {
    await write('abcdefghijklmnopqrstuv');
    term.resize(10, 4);
    assert.equal(text(0), 'abcdefghij');
    assert.equal(text(1), 'klmnopqrst');
    assert.equal(text(2), 'uv');
    assert.equal(term.buffer.active.getLine(1)!.isWrapped, true);
    await write('!');
    assert.equal(text(2), 'uv!');
  });

  it('tracks markers through scrollback and reflow', async () => {
    await write('marker');
    const marker = term.registerMarker(0)!;
    await write('\r\nnext\r\nthird\r\nfourth\r\nfifth');
    assert.equal(marker.line, 0);
    term.resize(4, 4);
    assert.equal(marker.line, 0);
    await write('\r\n'.repeat(30));
    assert.equal(marker.isDisposed, true);
  });

  it('runs handlers before Ghostty and preserves false fallthrough', async () => {
    let cursor = -1;
    const first = term.parser.registerCsiHandler({ final: 'C' }, () => { cursor = term.buffer.active.cursorX; return false; });
    await write('abc\x1b[2CX');
    assert.equal(cursor, 3);
    assert.equal(text(0), 'abc  X');
    const second = term.parser.registerCsiHandler({ final: 'C' }, () => true);
    await write('\x1b[2CY');
    assert.equal(text(0), 'abc  XY');
    second.dispose();
    first.dispose();
  });

  it('resumes asynchronous handlers before subsequent writes', async () => {
    const seen: string[] = [];
    (term.parser as IParser).registerOscHandler(2, async data => {
      seen.push(text(0));
      await Promise.resolve();
      seen.push(data);
      return false as const;
    });
    term.onTitleChange(title => seen.push(title));
    await write('before\x1b]2;title\x07after');
    assert.deepEqual(seen, ['before', 'title', 'title']);
    assert.equal(text(0), 'beforeafter');
  });

  it('supports DCS and APC handlers across chunks', async () => {
    const seen: unknown[] = [];
    term.parser.registerDcsHandler({ final: 'q' }, (data, params) => { seen.push([data, params]); return true; });
    term.parser.registerApcHandler({ final: 'G' }, data => { seen.push(data); return true; });
    await write('\x1bP1;2qpay');
    await write('load\x1b\\\x1b_Gkitty\x1b\\end');
    assert.deepEqual(seen, [['payload', [1, 2]], 'kitty']);
    assert.equal(text(0), 'end');
  });

  it('preserves the current line on clear', async () => {
    await write('old\r\nprompt> ');
    term.clear();
    assert.equal(text(0), 'prompt> ');
    assert.equal(term.buffer.active.cursorY, 0);
    await write('x');
    assert.equal(text(0), 'prompt> x');
    assert.equal(text(1), '');
  });

  it('resets state and keeps registered hooks', async () => {
    let calls = 0;
    term.parser.registerOscHandler(777, () => { calls++; return true; });
    await write('before\x1b[?2004h\x1b[?1049h');
    term.reset();
    await write('after\x1b]777;test\x07');
    assert.equal(text(0), 'after');
    assert.equal(term.buffer.active.type, 'normal');
    assert.equal(term.modes.bracketedPasteMode, false);
    assert.equal(calls, 1);
  });

  it('isolates terminals that share a compiled module', async () => {
    const other = new Terminal({ allowProposedApi: true, vtEngine: 'ghostty', ghosttyModule: module });
    try {
      await write('first');
      await new Promise<void>(resolve => other.write('second', resolve));
      assert.equal(text(0), 'first');
      assert.equal(other.buffer.active.getLine(0)!.translateToString(true), 'second');
      other.dispose();
      await write('!');
      assert.equal(text(0), 'first!');
    } finally {
      other.dispose();
    }
  });

  it('clears alternate-buffer views after exit', async () => {
    await write('normal\x1b[?1049halt\x1b[?1049l');
    assert.equal(term.buffer.alternate.length, 0);
    assert.equal(term.buffer.alternate.getLine(0), undefined);
  });

  it('disposes markers beyond the current buffer on clear', async () => {
    await write('\r\n'.repeat(5));
    const marker = term.registerMarker(2)!;
    let disposed = false;
    marker.onDispose(() => disposed = true);
    term.clear();
    assert.equal(disposed, true);
    assert.equal(term.markers.length, 0);
  });

  it('reports only changed viewport rows', async () => {
    const ranges: { start: number, end: number }[] = [];
    term.onRender(range => ranges.push(range));
    await write('hello');
    assert.deepEqual(ranges, [{ start: 0, end: 0 }]);
  });

  it('resumes a handler in a large chunk exactly once', async () => {
    let calls = 0;
    (term.parser as IParser).registerCsiHandler({ final: 'C' }, async () => {
      calls++;
      await Promise.resolve();
      return false;
    });
    await write('x'.repeat(131071) + '\x1b[2C!');
    assert.equal(calls, 1);
    assert.ok(text(term.buffer.active.baseY + term.buffer.active.cursorY).endsWith('!'));
  });

  it('keeps the scrolled viewport anchored as history grows', async () => {
    for (let i = 0; i < 20; i++) {
      await write(`${i}\r\n`);
    }
    term.scrollLines(-3);
    const visible = text(term.buffer.active.viewportY);
    await write('20\r\n');
    assert.equal(text(term.buffer.active.viewportY), visible);
  });

  it('delivers effects in input order with current buffer state', async () => {
    const events: string[] = [];
    term.onBell(() => events.push(`bell:${text(0)}`));
    term.onTitleChange(() => events.push(`title:${text(0)}`));
    term.onData(() => events.push(`data:${text(0)}`));
    await write('x\x07\x1b]2;title\x07\x1b[6nZ');
    assert.deepEqual(events, ['bell:x', 'title:x', 'data:x']);
    assert.equal(text(0), 'xZ');
  });

  it('exposes the cursor position at each line feed', async () => {
    const rows: number[] = [];
    term.onLineFeed(() => rows.push(term.buffer.active.cursorY));
    await write('a\r\nb\r\nc');
    assert.deepEqual(rows, [1, 2]);
  });

  it('honors the Kitty keyboard extension option', async () => {
    const replies: string[] = [];
    term.onData(data => replies.push(data));
    await write('\x1b[>1u\x1b[?u');
    assert.deepEqual(replies, []);
    term.options.vtExtensions = { kittyKeyboard: true };
    await write('\x1b[>1u\x1b[?u');
    assert.deepEqual(replies, ['\x1b[?1u']);
  });

  it('preserves convertEol after reset', async () => {
    term.options.convertEol = true;
    term.reset();
    await write('a\nb');
    assert.equal(text(1), 'b');
  });

  it('emits cursor movement after cursor restore', async () => {
    await write('abc\x1b7def');
    const positions: number[] = [];
    term.onCursorMove(() => positions.push(term.buffer.active.cursorX));
    await write('\x1b8');
    assert.deepEqual(positions, [3]);
  });

  it('emits scroll events after history reaches its limit', async () => {
    term.options.scrollback = 2;
    await write('0\r\n1\r\n2\r\n3\r\n4\r\n5');
    const positions: number[] = [];
    term.onScroll(position => positions.push(position));
    await write('\r\n6');
    assert.deepEqual(positions, [2]);
  });

  it('supports attribute access from serialize addon 0.14', async () => {
    await write('\x1b[31mred\x1b[?1049h\x1b[32mgreen\x1b[?1049l');
    const handler = Reflect.get(Reflect.get(term, '_core'), '_inputHandler');
    const attributes = Reflect.get(handler, '_curAttrData') as IAttributeData;
    assert.ok(attributes);
    assert.equal(attributes.getFgColor(), 1);
  });
});
