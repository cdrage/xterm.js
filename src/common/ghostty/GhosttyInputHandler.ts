/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Emitter } from '../Event';
import { InputHandler } from '../InputHandler';
import { Disposable, IDisposable, combinedDisposable } from '../Lifecycle';
import { StringToUtf32, Utf8ToUtf32, utf32ToString } from '../input/TextDecoder';
import { EscapeSequenceParser } from '../parser/EscapeSequenceParser';
import { IFunctionIdentifier, IParams } from '../parser/Types';
import { OscHandler } from '../parser/OscParser';
import { DcsHandler } from '../parser/DcsParser';
import { ApcHandler } from '../parser/ApcParser';
import { ICoreService, IMouseStateService, IOptionsService } from '../services/Services';
import { GhosttyBufferService } from './GhosttyBufferService';
import { GhosttyWasm } from './GhosttyWasm';
import { GhosttyLimits, GhosttyMode } from './Types';

const enum Sequence {
  ESC = '\x1b',
  CSI = '\x1b[',
  OSC = '\x1b]',
  DCS = '\x1bP',
  APC = '\x1b_',
  ST = '\x1b\\',
  CANCEL = '\x18',
  LINEFEED = 10,
  VERTICAL_TAB = 11,
  FORM_FEED = 12,
  ALT_LEGACY = 47,
  ALT = 1047,
  SAVE_CURSOR = 1048,
  ALT_SAVE = 1049,
  COLOR_SCHEME_QUERY = 996,
  WIN32_INPUT = 9001,
  C1_MIN = 0x80,
  C1_MAX = 0x9f,
  C1_ESC_OFFSET = 0x40
}

const KITTY_KEYBOARD_COMMANDS = new Set(['=u', '?u', '>u', '<u']);

/** Keeps synchronous and asynchronous parser hooks in front of the Ghostty engine. */
export class GhosttyInputHandler extends Disposable {
  private readonly _parser = this._register(new EscapeSequenceParser());
  private readonly _stringDecoder = new StringToUtf32();
  private readonly _utf8Decoder = new Utf8ToUtf32();
  private readonly _parseBuffer = new Uint32Array(GhosttyLimits.INPUT_CHUNK);
  private _position = 0;
  private _decodedLength = 0;
  private _paused = false;
  private readonly _oscDefaults = new Map<number, { count: number, disposable: IDisposable }>();
  private readonly _dcsDefaults = new Map<string, { count: number, disposable: IDisposable }>();
  private readonly _apcDefaults = new Map<string, { count: number, disposable: IDisposable }>();
  private readonly _hostOsc = new Set<number>();
  private _events: (() => void)[] = [];

  private readonly _onCursorMove = this._register(new Emitter<void>());
  public readonly onCursorMove = this._onCursorMove.event;
  private readonly _onLineFeed = this._register(new Emitter<void>());
  public readonly onLineFeed = this._onLineFeed.event;
  private readonly _onA11yChar = this._register(new Emitter<string>());
  public readonly onA11yChar = this._onA11yChar.event;
  private readonly _onA11yTab = this._register(new Emitter<number>());
  public readonly onA11yTab = this._onA11yTab.event;
  private readonly _onRefresh = this._register(new Emitter<{ start: number, end: number } | undefined>());
  public readonly onRequestRefreshRows = this._onRefresh.event;
  private readonly _onFocus = this._register(new Emitter<void>());
  public readonly onRequestSendFocus = this._onFocus.event;

  public get onRequestBell(): InputHandler['onRequestBell'] { return this._compat.onRequestBell; }
  public get onRequestReset(): InputHandler['onRequestReset'] { return this._compat.onRequestReset; }
  public get onRequestWindowsOptionsReport(): InputHandler['onRequestWindowsOptionsReport'] { return this._compat.onRequestWindowsOptionsReport; }
  public get onRequestColorSchemeQuery(): InputHandler['onRequestColorSchemeQuery'] { return this._compat.onRequestColorSchemeQuery; }
  public get onTitleChange(): InputHandler['onTitleChange'] { return this._compat.onTitleChange; }
  public get onColor(): InputHandler['onColor'] { return this._compat.onColor; }
  public get onScroll(): GhosttyBufferService['onScroll'] { return this._buffers.onScroll; }

  constructor(
    private readonly _compat: InputHandler,
    private readonly _engine: GhosttyWasm,
    private readonly _buffers: GhosttyBufferService,
    private readonly _core: ICoreService,
    private readonly _options: IOptionsService,
    private readonly _mouse: IMouseStateService
  ) {
    super();
    this._register(_compat);
    this._register(_engine.onData(data => this._events.push(() => this._core.triggerDataEvent(data))));
    this._register(_engine.onBell(() => this._events.push(() => this._compat.bell())));
    this._register(_engine.onTitle(title => this._events.push(() => this._compat.setTitle(title))));
    this._register(_buffers.onSync(() => this._syncModes()));
    this._register(_options.onSpecificOptionChange('convertEol', value => this._engine.setMode(GhosttyMode.LINEFEED, !!value)));
    this._engine.setMode(GhosttyMode.LINEFEED, _options.rawOptions.convertEol);
    const updateCursor = (): void => this._engine.setCursor(_options.rawOptions.cursorStyle, _options.rawOptions.cursorBlink);
    updateCursor();
    this._register(_options.onMultipleOptionChange(['cursorStyle', 'cursorBlink'], updateCursor));

    // The dispatcher retains hook ordering. Ghostty executes unhandled terminal operations.
    this._parser.setPrintHandler((data, start, end) => {
      const text = utf32ToString(data, start, end);
      this._write(text);
      if (this._options.rawOptions.screenReaderMode) {
        for (const char of text) {
          this._events.push(() => this._onA11yChar.fire(char));
        }
      }
    });
    this._parser.setExecuteHandlerFallback(code => {
      this._write(code >= Sequence.C1_MIN && code <= Sequence.C1_MAX ? Sequence.ESC + String.fromCharCode(code - Sequence.C1_ESC_OFFSET) : String.fromCharCode(code));
      if (code === Sequence.LINEFEED || code === Sequence.VERTICAL_TAB || code === Sequence.FORM_FEED) {
        this._flush();
        this._onLineFeed.fire();
      }
    });
    this._parser.setEscHandlerFallback(id => this._write(Sequence.ESC + this._parser.identToString(id)));
    this._parser.setCsiHandlerFallback((id, params) => this._writeCsi(this._parser.identToString(id), params));
    this._parser.setOscHandlerFallback((id, action, data) => {
      if (action === 'START') {
        this._write(`${Sequence.OSC}${id};`);
      } else if (action === 'PUT') {
        this._write(data);
      } else {
        this._write(data ? Sequence.ST : Sequence.CANCEL);
      }
    });
    this._parser.setDcsHandlerFallback((id, action, data) => {
      if (action === 'HOOK') {
        this._write(Sequence.DCS + this._command(this._parser.identToString(id), data));
      } else if (action === 'PUT') {
        this._write(data);
      } else {
        this._write(data ? Sequence.ST : Sequence.CANCEL);
      }
    });
    this._parser.setApcHandlerFallback((id, action, data) => {
      if (action === 'START') {
        this._write(Sequence.APC + this._parser.identToString(id));
      } else if (action === 'PUT') {
        this._write(data);
      } else {
        this._write(data ? Sequence.ST : Sequence.CANCEL);
      }
    });

    // Keep host policy for colors, queries, and window operations in the existing handler.
    const csi = (id: IFunctionIdentifier, fn: (params: IParams) => boolean): void => {
      this._parser.registerCsiHandler(id, params => { this._flush(); return fn(params); });
    };
    csi({ final: 'c' }, params => this._compat.sendDeviceAttributesPrimary(params));
    csi({ prefix: '>', final: 'c' }, params => this._compat.sendDeviceAttributesSecondary(params));
    csi({ prefix: '>', final: 'q' }, params => this._compat.sendXtVersion(params));
    csi({ final: 't' }, params => this._compat.windowOptions(params));
    csi({ prefix: '?', final: 'n' }, params => {
      if (params.params[0] === Sequence.COLOR_SCHEME_QUERY) {
        return this._compat.deviceStatusPrivate(params);
      }
      this._writeCsi('?n', params);
      return true;
    });
    this._parser.registerCsiHandler({ final: 'm' }, params => {
      this._compat.charAttributes(params);
      this._writeCsi('m', params);
      return true;
    });
    csi({ intermediates: '!', final: 'p' }, params => {
      this._compat.softReset(params);
      this._writeCsi('!p', params);
      return true;
    });
    const saveCursor = (): boolean => {
      this._flush();
      this._saveAttr();
      this._write(Sequence.ESC + '7');
      return true;
    };
    const restoreCursor = (): boolean => {
      this._restoreAttr();
      this._write(Sequence.ESC + '8');
      return true;
    };
    this._parser.registerEscHandler({ final: '7' }, saveCursor);
    this._parser.registerEscHandler({ final: '8' }, restoreCursor);
    this._parser.registerCsiHandler({ final: 's' }, saveCursor);
    this._parser.registerCsiHandler({ final: 'u' }, restoreCursor);
    this._parser.registerEscHandler({ final: 'c' }, () => {
      this._parser.reset();
      return this._compat.fullReset();
    });
    const osc = (id: number, fn: (data: string) => boolean): void => {
      this._hostOsc.add(id);
      this._parser.registerOscHandler(id, new OscHandler(fn));
    };
    osc(4, data => this._compat.setOrReportIndexedColor(data));
    osc(10, data => this._compat.setOrReportFgColor(data));
    osc(11, data => this._compat.setOrReportBgColor(data));
    osc(12, data => this._compat.setOrReportCursorColor(data));
    osc(104, data => this._compat.restoreIndexedColor(data));
    osc(110, data => this._compat.restoreFgColor(data));
    osc(111, data => this._compat.restoreBgColor(data));
    osc(112, data => this._compat.restoreCursorColor(data));
  }

  private _command(id: string, params: IParams): string {
    let prefix = '';
    if (id[0] >= '<' && id[0] <= '?') {
      prefix = id[0];
      id = id.slice(1);
    }
    const values: string[] = [];
    for (let i = 0; i < params.length; i++) {
      const sub = params.getSubParams(i);
      values.push(String(params.params[i]) + (sub ? ':' + Array.from(sub, value => value < 0 ? '' : String(value)).join(':') : ''));
    }
    return prefix + values.join(';') + id;
  }

  private _writeCsi(id: string, params: IParams): void {
    if (KITTY_KEYBOARD_COMMANDS.has(id) && !this._options.rawOptions.vtExtensions.kittyKeyboard) {
      return;
    }
    if (id === '?h' || id === '?l') {
      for (let i = 0; i < params.length; i++) {
        this._writeMode(params.params[i], id === '?h');
      }
      return;
    }
    this._write(Sequence.CSI + this._command(id, params));
    if (id === 'r') {
      this._buffers.buffer.scrollTop = Math.max(0, params.params[0] - 1);
      this._buffers.buffer.scrollBottom = (params.params[1] || this._buffers.rows) - 1;
    }
  }

  private _writeMode(mode: number, enabled: boolean): void {
    const switchesScreen = mode === Sequence.ALT || mode === Sequence.ALT_LEGACY || mode === Sequence.ALT_SAVE;
    const savesCursor = mode === Sequence.SAVE_CURSOR || mode === Sequence.ALT_SAVE;
    if (switchesScreen) {
      this._flush();
    }
    if (savesCursor && enabled) {
      this._saveAttr();
    }
    this._write(`${Sequence.CSI}?${mode}${enabled ? 'h' : 'l'}`);
    if (switchesScreen) {
      this._flush();
    }
    if (savesCursor && !enabled) {
      this._restoreAttr();
    }
    if (mode === Sequence.WIN32_INPUT && this._options.rawOptions.vtExtensions.win32InputMode) {
      this._core.decPrivateModes.win32InputMode = enabled;
    }
  }

  private _saveAttr(): void {
    // Mirror only attributes for serialization. Ghostty owns cursor movement.
    this._buffers.buffer.savedCurAttrData = this._compat.getAttrData().clone();
  }

  private _restoreAttr(): void {
    const saved = this._buffers.buffer.savedCurAttrData;
    const current = this._compat.getAttrData();
    current.fg = saved.fg;
    current.bg = saved.bg;
    current.extended = saved.extended.clone();
  }

  private _write(data: string): void {
    this._engine.write(data);
    // Host effects run after the Wasm call, before the next terminal operation.
    if (this._events.length) {
      this._flush();
    }
  }

  public parse(data: string | Uint8Array, promiseResult?: boolean): void | Promise<boolean> {
    if (this._paused) {
      const result = this._parser.parse(this._parseBuffer, this._decodedLength, promiseResult);
      if (result) {
        return result;
      }
      this._paused = false;
    }
    while (this._position < data.length) {
      const end = Math.min(data.length, this._position + GhosttyLimits.INPUT_CHUNK);
      this._decodedLength = typeof data === 'string'
        ? this._stringDecoder.decode(data.substring(this._position, end), this._parseBuffer)
        : this._utf8Decoder.decode(data.subarray(this._position, end), this._parseBuffer);
      this._position = end;
      const result = this._parser.parse(this._parseBuffer, this._decodedLength);
      if (result) {
        this._paused = true;
        this._flush();
        return result;
      }
    }
    this._position = 0;
    this._flush();
  }

  private _flush(): void {
    const x = this._buffers.buffer.x;
    const y = this._buffers.buffer.y;
    const range = this._buffers.sync();
    if (x !== this._buffers.buffer.x || y !== this._buffers.buffer.y) {
      this._onCursorMove.fire();
    }
    const events = this._events;
    this._events = [];
    for (const fire of events) {
      fire();
    }
    if (range) {
      this._onRefresh.fire(range);
    }
  }

  private _syncModes(): void {
    const modes = this._core.decPrivateModes;
    const hadFocus = modes.sendFocus;
    modes.applicationCursorKeys = this._engine.mode(GhosttyMode.CURSOR_KEYS);
    modes.applicationKeypad = this._engine.mode(GhosttyMode.KEYPAD);
    modes.bracketedPasteMode = this._engine.mode(GhosttyMode.BRACKETED_PASTE);
    modes.origin = this._engine.mode(GhosttyMode.ORIGIN);
    modes.reverseWraparound = this._engine.mode(GhosttyMode.REVERSE_WRAP);
    modes.sendFocus = this._engine.mode(GhosttyMode.FOCUS);
    modes.wraparound = this._engine.mode(GhosttyMode.WRAPAROUND);
    modes.synchronizedOutput = this._engine.mode(GhosttyMode.SYNC_OUTPUT);
    modes.cursorBlink = this._engine.mode(GhosttyMode.CURSOR_BLINK);
    modes.colorSchemeUpdates = this._engine.mode(GhosttyMode.COLOR_SCHEME);
    this._core.modes.insertMode = this._engine.mode(GhosttyMode.INSERT);
    this._core.isCursorHidden = !this._engine.mode(GhosttyMode.CURSOR_VISIBLE);
    this._core.kittyKeyboard.flags = this._options.rawOptions.vtExtensions.kittyKeyboard ? this._engine.keyboardFlags : 0;
    modes.cursorStyle = this._engine.cursorStyle;
    const protocol = this._engine.mode(GhosttyMode.ANY_MOUSE) ? 'ANY'
      : this._engine.mode(GhosttyMode.BUTTON_MOUSE) ? 'DRAG'
        : this._engine.mode(GhosttyMode.NORMAL_MOUSE) ? 'VT200'
          : this._engine.mode(GhosttyMode.X10_MOUSE) ? 'X10' : 'NONE';
    if (protocol !== this._mouse.activeProtocol) {
      this._mouse.activeProtocol = protocol;
    }
    this._mouse.activeEncoding = this._engine.mode(GhosttyMode.PIXEL_MOUSE) ? 'SGR_PIXELS' : this._engine.mode(GhosttyMode.SGR_MOUSE) ? 'SGR' : 'DEFAULT';
    if (!hadFocus && modes.sendFocus) {
      this._events.push(() => this._onFocus.fire());
    }
  }

  public registerCsiHandler(id: IFunctionIdentifier, callback: (params: IParams) => boolean | Promise<boolean>): IDisposable {
    return this._parser.registerCsiHandler(id, params => { this._flush(); return callback(params); });
  }

  public registerEscHandler(id: IFunctionIdentifier, callback: () => boolean | Promise<boolean>): IDisposable {
    return this._parser.registerEscHandler(id, () => { this._flush(); return callback(); });
  }

  private _default<K>(map: Map<K, { count: number, disposable: IDisposable }>, key: K, factory: () => IDisposable): IDisposable {
    let entry = map.get(key);
    if (!entry) {
      entry = { count: 0, disposable: factory() };
      map.set(key, entry);
    }
    entry.count++;
    let disposed = false;
    return { dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (--entry.count === 0) {
        entry.disposable.dispose();
        map.delete(key);
      }
    } };
  }

  public registerOscHandler(id: number, callback: (data: string) => boolean | Promise<boolean>): IDisposable {
    const fallback = this._hostOsc.has(id) ? Disposable.None : this._default(this._oscDefaults, id, () => this._parser.registerOscHandler(id, new OscHandler(data => {
      this._write(`${Sequence.OSC}${id};${data}${Sequence.ST}`);
      return true;
    })));
    return combinedDisposable(fallback, this._parser.registerOscHandler(id, new OscHandler(data => { this._flush(); return callback(data); })));
  }

  public registerDcsHandler(id: IFunctionIdentifier, callback: (data: string, params: IParams) => boolean | Promise<boolean>): IDisposable {
    const ident = (id.prefix ?? '') + (id.intermediates ?? '') + id.final;
    const fallback = this._default(this._dcsDefaults, ident, () => this._parser.registerDcsHandler(id, new DcsHandler((data, params) => {
      this._write(Sequence.DCS + this._command(ident, params) + data + Sequence.ST);
      return true;
    })));
    return combinedDisposable(fallback, this._parser.registerDcsHandler(id, new DcsHandler((data, params) => { this._flush(); return callback(data, params); })));
  }

  public registerApcHandler(id: IFunctionIdentifier, callback: (data: string) => boolean | Promise<boolean>): IDisposable {
    const ident = (id.intermediates ?? '') + id.final;
    const fallback = this._default(this._apcDefaults, ident, () => this._parser.registerApcHandler(id, new ApcHandler(data => {
      this._write(Sequence.APC + ident + data + Sequence.ST);
      return true;
    })));
    return combinedDisposable(fallback, this._parser.registerApcHandler(id, new ApcHandler(data => { this._flush(); return callback(data); })));
  }

  public markRangeDirty(_start: number, _end: number): void { this._onRefresh.fire(undefined); }

  // Serialize addon 0.14 reads this private field in published packages.
  private get _curAttrData(): ReturnType<InputHandler['getAttrData']> { return this._compat.getAttrData(); }

  public getAttrData(): ReturnType<InputHandler['getAttrData']> { return this._curAttrData; }

  public reset(): void {
    this._compat.reset();
    this._events = [];
  }
}
