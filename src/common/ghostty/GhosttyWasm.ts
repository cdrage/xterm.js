/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

/// <reference lib="es2020.bigint" />

import { Emitter } from '../Event';
import { Disposable, toDisposable } from '../Lifecycle';
import { Attributes } from '../buffer/Constants';
import { CursorStyle } from '../Types';
import { GhosttyLimits, GhosttyMode, IGhosttyCell, IGhosttyRow, IGhosttySnapshot, IGhosttyStyle } from './Types';

interface IField { offset: number, size: number, type: string }
interface IType {
  size: number;
  fields: Record<string, IField>;
  values: Record<string, number>;
}
interface IManifest {
  schema: number;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  abi: { pointer_size: number, usize_size: number, endian: string };
  types: Record<string, IType>;
}

const enum Abi {
  SCHEMA = 1,
  POINTER_SIZE = 4,
  SCRATCH_SIZE = 1024,
  NULL = 0
}

// A typed Wasm import converts a JS callback into a table-compatible function.
// (module (import "e" "f" (func ...)) (export "f" (func 0)))
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const enum WasmCode {
  TYPE_SECTION = 1,
  IMPORT_SECTION = 2,
  EXPORT_SECTION = 7,
  FUNCTION = 0x60,
  I32 = 0x7f
}

/** Owns the C ABI, linear memory, handles, and borrowed render data. */
export class GhosttyWasm extends Disposable {
  private readonly _exports: WebAssembly.Exports;
  private readonly _memory: WebAssembly.Memory;
  private readonly _manifest: IManifest;
  private readonly _scratch: number;
  private readonly _terminal: number;
  private readonly _render: number;
  private readonly _iterator: number;
  private readonly _cells: number;
  private readonly _style: number;
  private readonly _point: number;
  private readonly _grid: number;
  private readonly _input: number;
  private readonly _encoder = new TextEncoder();
  private readonly _decoder = new TextDecoder();
  private _rowCache = new Map<string, IGhosttyRow>();
  private _alternate = false;
  private readonly _historyOffsets = [0, 0];

  private readonly _onData = this._register(new Emitter<string>());
  public readonly onData = this._onData.event;
  private readonly _onBell = this._register(new Emitter<void>());
  public readonly onBell = this._onBell.event;
  private readonly _onTitle = this._register(new Emitter<string>());
  public readonly onTitle = this._onTitle.event;

  constructor(module: WebAssembly.Module, cols: number, rows: number, scrollback: number) {
    super();
    this._exports = new WebAssembly.Instance(module, {}).exports;
    if (!(this._exports.memory instanceof WebAssembly.Memory)) {
      throw new Error('Invalid libghostty-vt module: missing memory');
    }
    this._memory = this._exports.memory;
    const ptr = this._call('ghostty_type_json');
    const bytes = this._bytes();
    const end = bytes.indexOf(0, ptr);
    if (end < ptr) {
      throw new Error('Invalid libghostty-vt ABI manifest');
    }
    this._manifest = JSON.parse(this._decoder.decode(bytes.subarray(ptr, end)));
    const abi = this._manifest.abi;
    if (this._manifest.schema !== Abi.SCHEMA || abi.pointer_size !== Abi.POINTER_SIZE || abi.usize_size !== Abi.POINTER_SIZE || abi.endian !== 'little') {
      throw new Error('Unsupported libghostty-vt ABI');
    }

    // Release partial allocations if module initialization fails.
    try {
      this._scratch = this._alloc(Abi.SCRATCH_SIZE);
      this._terminal = this._handle('ghostty_terminal', cols, rows);
      this._render = this._handle('ghostty_render_state');
      this._iterator = this._handle('ghostty_render_state_row_iterator');
      this._cells = this._handle('ghostty_render_state_row_cells');
      this._style = this._struct('GhosttyStyle');
      this._point = this._struct('GhosttyPoint');
      this._grid = this._struct('GhosttyGridRef');
      this._input = this._alloc(GhosttyLimits.INPUT_CHUNK);
      this._callback('WRITE_PTY', 4, (_term, _user, data, length) => this._onData.fire(this._text(data, length)));
      this._callback('BELL', 2, () => this._onBell.fire());
      this._callback('TITLE_CHANGED', 2, () => {
        this._get('TITLE');
        this._onTitle.fire(this._string(this._scratch));
      });
      this.setScrollback(scrollback);
      this.setMode(GhosttyMode.GRAPHEMES, true);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private _call(name: string, ...args: (number | bigint)[]): number {
    const fn = this._exports[name];
    if (typeof fn !== 'function') {
      throw new Error(`Invalid libghostty-vt module: missing ${name}`);
    }
    return fn(...args);
  }

  private _check(result: number): void {
    if (result !== this._enum('GhosttyResult', 'SUCCESS')) {
      throw new Error(`libghostty-vt error: ${result}`);
    }
  }

  private _enum(type: string, name: string): number {
    const value = this._manifest.types[type]?.values?.[name];
    if (value === undefined) {
      throw new Error(`Unsupported libghostty-vt ABI: ${type}.${name}`);
    }
    return value;
  }

  private _bytes(): Uint8Array { return new Uint8Array(this._memory.buffer); }
  private _view(): DataView { return new DataView(this._memory.buffer); }
  private _text(ptr: number, length: number): string { return this._decoder.decode(this._bytes().subarray(ptr, ptr + length)); }

  private _field(type: string, field: string): IField {
    const value = this._manifest.types[type]?.fields?.[field];
    if (!value) {
      throw new Error(`Unsupported libghostty-vt ABI: ${type}.${field}`);
    }
    return value;
  }

  private _read(ptr: number, type: string, field: string): number {
    const f = this._field(type, field);
    const view = this._view();
    ptr += f.offset;
    switch (f.size) {
      case 1: return view.getUint8(ptr);
      case 2: return view.getUint16(ptr, true);
      case 4: return f.type === 'i32' ? view.getInt32(ptr, true) : view.getUint32(ptr, true);
      case 8: return Number(view.getBigUint64(ptr, true));
      default: throw new Error(`Unsupported scalar: ${type}.${field}`);
    }
  }

  private _put(ptr: number, type: string, field: string, value: number): void {
    const f = this._field(type, field);
    const view = this._view();
    ptr += f.offset;
    switch (f.size) {
      case 1: view.setUint8(ptr, value); return;
      case 2: view.setUint16(ptr, value, true); return;
      case 4: view.setUint32(ptr, value, true); return;
      case 8: view.setBigUint64(ptr, BigInt(value), true); return;
      default: throw new Error(`Unsupported scalar: ${type}.${field}`);
    }
  }

  private _string(ptr: number): string {
    return this._text(this._read(ptr, 'GhosttyString', 'ptr'), this._read(ptr, 'GhosttyString', 'len'));
  }

  private _alloc(length: number): number {
    const ptr = this._call('ghostty_wasm_alloc', length);
    if (!ptr) {
      throw new Error('libghostty-vt allocation failed');
    }
    this._register(toDisposable(() => this._call('ghostty_wasm_free', ptr, length)));
    return ptr;
  }

  private _struct(type: string): number {
    const desc = this._manifest.types[type];
    if (!desc?.fields || !desc.size) {
      throw new Error(`Unsupported libghostty-vt ABI: ${type}`);
    }
    const ptr = this._alloc(desc.size);
    this._bytes().fill(0, ptr, ptr + desc.size);
    if (desc.fields.size) {
      this._put(ptr, type, 'size', desc.size);
    }
    return ptr;
  }

  private _handle(prefix: string, ...args: number[]): number {
    this._check(this._call(`${prefix}_new`, Abi.NULL, this._scratch, ...args));
    const handle = this._call('ghostty_wasm_take_opaque', this._scratch);
    this._register(toDisposable(() => this._call(`${prefix}_free`, handle)));
    return handle;
  }

  private _callback(option: string, count: number, fn: (...args: number[]) => void): void {
    const type = [1, WasmCode.FUNCTION, count, ...Array<number>(count).fill(WasmCode.I32), 0];
    const module = new WebAssembly.Module(new Uint8Array([
      ...WASM_HEADER, WasmCode.TYPE_SECTION, type.length, ...type,
      WasmCode.IMPORT_SECTION, 7, 1, 1, 101, 1, 102, 0, 0,
      WasmCode.EXPORT_SECTION, 5, 1, 1, 102, 0, 0
    ]));
    const callback = new WebAssembly.Instance(module, { e: { f: fn } }).exports.f;
    const table = this._exports.__indirect_function_table as WebAssembly.Table;
    const index = table.grow(1);
    table.set(index, callback);
    this._check(this._call('ghostty_terminal_set', this._terminal, this._enum('GhosttyTerminalOption', option), index));
  }

  private _get(name: string): void {
    this._bytes().fill(0, this._scratch, this._scratch + Abi.SCRATCH_SIZE);
    this._check(this._call('ghostty_terminal_get', this._terminal, this._enum('GhosttyTerminalData', name), this._scratch));
  }

  private _number(name: string): number {
    this._get(name);
    return this._view().getUint32(this._scratch, true);
  }

  public mode(mode: GhosttyMode): boolean {
    this._put(this._scratch, 'GhosttyTerminalModeConfig', 'mode', mode);
    this._check(this._call('ghostty_terminal_get', this._terminal, this._enum('GhosttyTerminalData', 'MODE'), this._scratch));
    return !!this._read(this._scratch, 'GhosttyTerminalModeConfig', 'value');
  }

  public get keyboardFlags(): number { return this._number('KITTY_KEYBOARD_FLAGS'); }

  public get cursorStyle(): CursorStyle {
    const style = this._number('CURSOR_STYLE');
    if (style === this._enum('GhosttyTerminalCursorStyle', 'BAR')) {
      return 'bar';
    }
    return style === this._enum('GhosttyTerminalCursorStyle', 'UNDERLINE') ? 'underline' : 'block';
  }

  public setCursor(style: CursorStyle, blink: boolean): void {
    this._view().setUint32(this._scratch, this._enum('GhosttyTerminalCursorStyle', style.toUpperCase()), true);
    this._check(this._call('ghostty_terminal_set', this._terminal, this._enum('GhosttyTerminalOption', 'DEFAULT_CURSOR_STYLE'), this._scratch));
    this._view().setUint8(this._scratch, +blink);
    this._check(this._call('ghostty_terminal_set', this._terminal, this._enum('GhosttyTerminalOption', 'DEFAULT_CURSOR_BLINK'), this._scratch));
  }

  public setMode(mode: GhosttyMode, value: boolean): void {
    this._put(this._scratch, 'GhosttyTerminalModeConfig', 'mode', mode);
    this._put(this._scratch, 'GhosttyTerminalModeConfig', 'value', +value);
    this._check(this._call('ghostty_terminal_set', this._terminal, this._enum('GhosttyTerminalOption', 'MODE'), this._scratch));
  }

  public setScrollback(lines: number): void {
    if (!Number.isInteger(lines) || lines < 0 || lines > GhosttyLimits.MAX_SCROLLBACK) {
      throw new Error(`Ghostty scrollback must be between 0 and ${GhosttyLimits.MAX_SCROLLBACK}`);
    }
    // Remove the byte limit. Expose only the requested history despite page-based pruning.
    this._check(this._call('ghostty_terminal_set', this._terminal, this._enum('GhosttyTerminalOption', 'SCROLLBACK_MAX_BYTES'), Abi.NULL));
    this._view().setUint32(this._scratch, lines, true);
    this._check(this._call('ghostty_terminal_set', this._terminal, this._enum('GhosttyTerminalOption', 'SCROLLBACK_MAX_LINES'), this._scratch));
    this._put(this._scratch, 'GhosttyRenderStateOverscan', 'above', lines);
    this._put(this._scratch, 'GhosttyRenderStateOverscan', 'below', 0);
    this._check(this._call('ghostty_render_state_set', this._render, this._enum('GhosttyRenderStateOption', 'OVERSCAN'), this._scratch));
  }

  public write(data: string): void {
    const bytes = this._encoder.encode(data);
    for (let offset = 0; offset < bytes.length; offset += GhosttyLimits.INPUT_CHUNK) {
      const chunk = bytes.subarray(offset, offset + GhosttyLimits.INPUT_CHUNK);
      this._bytes().set(chunk, this._input);
      this._call('ghostty_terminal_vt_write', this._terminal, this._input, chunk.length);
    }
  }

  public resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > GhosttyLimits.MAX_DIMENSION || rows > GhosttyLimits.MAX_DIMENSION) {
      throw new Error(`Ghostty dimensions must not exceed ${GhosttyLimits.MAX_DIMENSION}`);
    }
    this._check(this._call('ghostty_terminal_resize', this._terminal, cols, rows, 0, 0));
    this._rowCache.clear();
  }

  public reset(convertEol: boolean): void {
    this._call('ghostty_terminal_reset', this._terminal);
    this.setMode(GhosttyMode.GRAPHEMES, true);
    this.setMode(GhosttyMode.LINEFEED, convertEol);
    this._rowCache.clear();
  }

  public clear(x: number, y: number, top: number, bottom: number): void {
    const origin = this.mode(GhosttyMode.ORIGIN);
    this.setMode(GhosttyMode.ORIGIN, false);
    // Delete rows above the cursor, then erase below it and discard history.
    this.write('\x1b[r\x1b[H');
    if (y) {
      this.write(`\x1b[${y}M`);
    }
    if (this._number('ROWS') > 1) {
      this.write('\x1b[2;1H\x1b[J');
    }
    this.write(`\x1b[3J\x1b[${top + 1};${bottom + 1}r\x1b[1;${x + 1}H`);
    this.setMode(GhosttyMode.ORIGIN, origin);
    this._rowCache.clear();
  }

  private _renderGet(name: string): void {
    this._check(this._call('ghostty_render_state_get', this._render, this._enum('GhosttyRenderStateData', name), this._scratch));
  }

  private _rowGet(name: string): void {
    this._check(this._call('ghostty_render_state_row_get', this._iterator, this._enum('GhosttyRenderStateRowData', name), this._scratch));
  }

  private _cellGet(name: string, ptr: number = this._scratch): void {
    this._check(this._call('ghostty_render_state_row_cells_get', this._cells, this._enum('GhosttyRenderStateRowCellsData', name), ptr));
  }

  public snapshot(): IGhosttySnapshot {
    const alternate = !!this._number('ACTIVE_SCREEN');
    if (alternate !== this._alternate) {
      this._rowCache.clear();
      this._alternate = alternate;
    }
    const retainedHistory = this._number('SCROLLBACK_ROWS');
    const x = this._number('CURSOR_X') + +!!this._number('CURSOR_PENDING_WRAP');
    const y = this._number('CURSOR_Y');
    this._check(this._call('ghostty_render_state_update', this._render, this._terminal));
    this._renderGet('OVERSCAN');
    const history = this._read(this._scratch, 'GhosttyRenderStateOverscan', 'above');
    this._historyOffsets[+alternate] = retainedHistory - history;
    this._view().setUint32(this._scratch, this._iterator, true);
    this._renderGet('ROW_ITERATOR');
    const rows: IGhosttyRow[] = [];
    const cache = new Map<string, IGhosttyRow>();
    while (this._call('ghostty_render_state_row_iterator_next', this._iterator)) {
      this._rowGet('ID');
      const idSize = this._manifest.types.GhosttyRenderStateRowId.size;
      const id = Array.from(this._bytes().subarray(this._scratch, this._scratch + idSize)).join(',');
      this._rowGet('DIRTY');
      let row = this._rowCache.get(id);
      if (!row || this._view().getUint8(this._scratch)) {
        this._rowGet('RAW');
        const raw = this._view().getBigUint64(this._scratch, true);
        this._check(this._call('ghostty_row_get', raw, this._enum('GhosttyRowData', 'WRAP_CONTINUATION'), this._scratch));
        const wrapped = !!this._view().getUint8(this._scratch);
        this._view().setUint32(this._scratch, this._cells, true);
        this._rowGet('CELLS');
        const cells: IGhosttyCell[] = [];
        while (this._call('ghostty_render_state_row_cells_next', this._cells)) {
          cells.push(this._readCell(cells.length, rows.length));
        }
        row = { id, wrapped, cells };
      }
      cache.set(id, row);
      rows.push(row);
    }
    const trimmed = this._trimmed(rows);
    this._rowCache = cache;
    this._check(this._call('ghostty_render_state_clean', this._render));
    return { alternate, x, y, history, trimmed, rows };
  }

  private _trimmed(rows: IGhosttyRow[]): number {
    const previous = new Map(Array.from(this._rowCache.keys(), (id, index) => [id, index]));
    // A surviving row measures history loss even if the first row changed in place.
    for (let index = 0; index < rows.length; index++) {
      const oldIndex = previous.get(rows[index].id);
      if (oldIndex !== undefined) {
        return Math.max(0, oldIndex - index);
      }
    }
    return previous.size;
  }

  private _readCell(x: number, y: number): IGhosttyCell {
    this._cellGet('RAW');
    const raw = this._view().getBigUint64(this._scratch, true);
    this._check(this._call('ghostty_cell_get', raw, this._enum('GhosttyCellData', 'WIDE'), this._scratch));
    const wide = this._view().getUint32(this._scratch, true);
    const width = wide === this._enum('GhosttyCellWide', 'WIDE') ? 2 : wide === this._enum('GhosttyCellWide', 'SPACER_TAIL') ? 0 : 1;
    this._put(this._scratch, 'GhosttyBuffer', 'ptr', this._input);
    this._put(this._scratch, 'GhosttyBuffer', 'cap', GhosttyLimits.INPUT_CHUNK);
    this._cellGet('GRAPHEMES_UTF8');
    const text = this._text(this._input, this._read(this._scratch, 'GhosttyBuffer', 'len'));
    this._cellGet('STYLE', this._style);
    const style = this._readStyle();
    this._check(this._call('ghostty_cell_get', raw, this._enum('GhosttyCellData', 'PROTECTED'), this._scratch));
    const protectedCell = !!this._view().getUint8(this._scratch);
    this._check(this._call('ghostty_cell_get', raw, this._enum('GhosttyCellData', 'CONTENT_TAG'), this._scratch));
    const tag = this._view().getUint32(this._scratch, true);
    if (tag === this._enum('GhosttyCellContentTag', 'BG_COLOR_PALETTE')) {
      this._check(this._call('ghostty_cell_get', raw, this._enum('GhosttyCellData', 'COLOR_PALETTE'), this._scratch));
      style.bg = Attributes.CM_P256 | this._view().getUint8(this._scratch);
    } else if (tag === this._enum('GhosttyCellContentTag', 'BG_COLOR_RGB')) {
      this._check(this._call('ghostty_cell_get', raw, this._enum('GhosttyCellData', 'COLOR_RGB'), this._scratch));
      style.bg = Attributes.CM_RGB | this._rgb(this._scratch);
    }
    this._check(this._call('ghostty_cell_get', raw, this._enum('GhosttyCellData', 'HAS_HYPERLINK'), this._scratch));
    const uri = this._view().getUint8(this._scratch) ? this._hyperlink(x, y) : undefined;
    return { text, width, style, protected: protectedCell, uri };
  }

  private _rgb(ptr: number): number {
    return (this._read(ptr, 'GhosttyColorRgb', 'r') << Attributes.RED_SHIFT)
      | (this._read(ptr, 'GhosttyColorRgb', 'g') << Attributes.GREEN_SHIFT)
      | this._read(ptr, 'GhosttyColorRgb', 'b');
  }

  private _color(ptr: number): number {
    const tag = this._read(ptr, 'GhosttyStyleColor', 'tag');
    const value = ptr + this._field('GhosttyStyleColor', 'value').offset;
    if (tag === this._enum('GhosttyStyleColorTag', 'PALETTE')) {
      return Attributes.CM_P256 | this._view().getUint8(value);
    }
    if (tag === this._enum('GhosttyStyleColorTag', 'RGB')) {
      return Attributes.CM_RGB | this._rgb(value);
    }
    return Attributes.CM_DEFAULT;
  }

  private _readStyle(): IGhosttyStyle {
    const flag = (name: string): boolean => !!this._read(this._style, 'GhosttyStyle', name);
    const color = (name: string): number => this._color(this._style + this._field('GhosttyStyle', name).offset);
    return {
      fg: color('fg_color'), bg: color('bg_color'), underlineColor: color('underline_color'),
      underline: this._read(this._style, 'GhosttyStyle', 'underline'),
      bold: flag('bold'), italic: flag('italic'), faint: flag('faint'), blink: flag('blink'),
      inverse: flag('inverse'), invisible: flag('invisible'), strikethrough: flag('strikethrough'), overline: flag('overline')
    };
  }

  private _setPoint(x: number, y: number): void {
    this._put(this._point, 'GhosttyPoint', 'tag', this._enum('GhosttyPointTag', 'SCREEN'));
    const coord = this._point + this._field('GhosttyPoint', 'value').offset;
    this._put(coord, 'GhosttyPointCoordinate', 'x', x);
    this._put(coord, 'GhosttyPointCoordinate', 'y', y);
  }

  private _hyperlink(x: number, y: number): string {
    this._setPoint(x, y + this._historyOffsets[+this._alternate]);
    this._check(this._call('ghostty_terminal_grid_ref', this._terminal, this._point, this._grid));
    const result = this._call('ghostty_grid_ref_hyperlink_uri', this._grid, 0, 0, this._scratch);
    if (result !== this._enum('GhosttyResult', 'OUT_OF_SPACE')) {
      this._check(result);
      return '';
    }
    const length = this._view().getUint32(this._scratch, true);
    const ptr = this._call('ghostty_wasm_alloc', length);
    if (!ptr) {
      throw new Error('libghostty-vt allocation failed');
    }
    try {
      this._check(this._call('ghostty_grid_ref_hyperlink_uri', this._grid, ptr, length, this._scratch));
      return this._text(ptr, length);
    } finally {
      this._call('ghostty_wasm_free', ptr, length);
    }
  }

  public trackLine(y: number): { line: () => number | undefined, dispose: () => void } {
    const screen = +this._alternate;
    this._setPoint(0, y + this._historyOffsets[screen]);
    this._check(this._call('ghostty_terminal_grid_ref_track', this._terminal, this._point, this._scratch));
    const ref = this._call('ghostty_wasm_take_opaque', this._scratch);
    return {
      line: () => {
        const result = this._call('ghostty_tracked_grid_ref_point', ref, this._enum('GhosttyPointTag', 'SCREEN'), this._scratch);
        if (result === this._enum('GhosttyResult', 'NO_VALUE')) {
          return undefined;
        }
        this._check(result);
        const line = this._read(this._scratch, 'GhosttyPointCoordinate', 'y') - this._historyOffsets[screen];
        return line < 0 ? undefined : line;
      },
      dispose: () => this._call('ghostty_tracked_grid_ref_free', ref)
    };
  }
}
