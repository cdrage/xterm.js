/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Buffer } from '../buffer/Buffer';
import { BufferLine, DEFAULT_ATTR_DATA } from '../buffer/BufferLine';
import { CellData } from '../buffer/CellData';
import { BgFlags, FgFlags } from '../buffer/Constants';
import { IAttributeData, IBuffer, IBufferLine, IBufferSet } from '../buffer/Types';
import { Marker } from '../buffer/Marker';
import { Emitter } from '../Event';
import { Disposable, MutableDisposable } from '../Lifecycle';
import { IBufferResizeEvent, IBufferService, ILogService, IOptionsService, IOscLinkService } from '../services/Services';
import { GhosttyWasm } from './GhosttyWasm';
import { IGhosttyRow, IGhosttySnapshot } from './Types';
import { IRowRange } from '../Types';

/** A rendering and API view. Ghostty owns edits, reflow, and scrollback. */
class GhosttyBuffer extends Buffer {
  private readonly _tracked = new Map<Marker, ReturnType<GhosttyWasm['trackLine']>>();

  constructor(
    scrollback: boolean,
    options: IOptionsService,
    service: IBufferService,
    log: ILogService,
    private readonly _engine: GhosttyWasm
  ) {
    super(scrollback, options, service, log);
  }

  public addMarker(y: number): Marker {
    const marker = new Marker(y);
    const anchor = Math.max(0, Math.min(y, this.lines.length - 1));
    const tracked = this._engine.trackLine(anchor);
    const ref = {
      line: (): number | undefined => {
        const line = tracked.line();
        return line === undefined ? undefined : line + y - anchor;
      },
      dispose: (): void => tracked.dispose()
    };
    this._tracked.set(marker, ref);
    this.markers.push(marker);
    marker.register(ref);
    marker.register(marker.onDispose(() => this._tracked.delete(marker)));
    return marker;
  }

  public updateMarkers(): void {
    for (const [marker, ref] of this._tracked) {
      const line = ref.line();
      if (line === undefined) {
        marker.dispose();
      } else {
        marker.line = line;
      }
    }
    this.markers = this.markers.filter(marker => !marker.isDisposed);
  }
}

class GhosttyBufferSet extends Disposable implements IBufferSet {
  public readonly normal: GhosttyBuffer;
  public readonly alt: GhosttyBuffer;
  public active: GhosttyBuffer;
  private readonly _onBufferActivate = this._register(new Emitter<{ activeBuffer: IBuffer, inactiveBuffer: IBuffer }>());
  public readonly onBufferActivate = this._onBufferActivate.event;

  constructor(options: IOptionsService, service: IBufferService, log: ILogService, engine: GhosttyWasm) {
    super();
    this.normal = this._register(new GhosttyBuffer(true, options, service, log, engine));
    this.alt = this._register(new GhosttyBuffer(false, options, service, log, engine));
    this.active = this.normal;
    this.normal.fillViewportRows();
  }

  public activateNormalBuffer(): void {
    if (this.active !== this.normal) {
      this.alt.clear();
    }
    this._activate(this.normal);
  }
  public activateAltBuffer(): void { this._activate(this.alt); }

  private _activate(buffer: GhosttyBuffer): void {
    if (this.active === buffer) {
      return;
    }
    const inactiveBuffer = this.active;
    this.active = buffer;
    this._onBufferActivate.fire({ activeBuffer: buffer, inactiveBuffer });
  }

  public reset(): void {
    this.normal.clear();
    this.alt.clear();
    this.normal.fillViewportRows();
    this.activateNormalBuffer();
  }

  public resize(cols: number, rows: number): void {
    this.normal.resize(cols, rows);
    this.alt.resize(cols, rows);
    this.setupTabStops(cols);
  }

  public setupTabStops(index?: number): void {
    this.normal.setupTabStops(index);
    this.alt.setupTabStops(index);
  }
}

export class GhosttyBufferService extends Disposable implements IBufferService {
  public serviceBrand: undefined;
  public readonly buffers: GhosttyBufferSet;
  public isUserScrolling = false;
  public get buffer(): GhosttyBuffer { return this.buffers.active; }
  private _lines = new WeakMap<IGhosttyRow, IBufferLine>();
  private readonly _onResize = this._register(new Emitter<IBufferResizeEvent>());
  public readonly onResize = this._onResize.event;
  private readonly _onScroll = this._register(new Emitter<number>());
  public readonly onScroll = this._onScroll.event;
  private readonly _onSync = this._register(new Emitter<void>());
  public readonly onSync = this._onSync.event;
  private _linkService: IOscLinkService | undefined;
  private readonly _viewport = this._register(new MutableDisposable<ReturnType<GhosttyWasm['trackLine']>>());

  constructor(
    public cols: number,
    public rows: number,
    private readonly _engine: GhosttyWasm,
    private readonly _options: IOptionsService,
    log: ILogService
  ) {
    super();
    this.buffers = this._register(new GhosttyBufferSet(_options, this, log, _engine));
    this._register(_options.onSpecificOptionChange('scrollback', value => {
      this._engine.setScrollback(value!);
      this.sync();
    }));
    this.sync();
  }

  public clear(): void {
    this._viewport.clear();
    this.buffer.clearAllMarkers();
    this.isUserScrolling = false;
    this._engine.clear(this.buffer.x, this.buffer.y, this.buffer.scrollTop, this.buffer.scrollBottom);
    this.sync();
    this._onScroll.fire(this.buffer.ydisp);
  }

  public setLinkService(service: IOscLinkService): void {
    this._linkService = service;
  }

  public sync(): IRowRange | undefined {
    const range = this._apply(this._engine.snapshot());
    this.buffers.normal.updateMarkers();
    this.buffers.alt.updateMarkers();
    this._onSync.fire();
    return range;
  }

  private _apply(snapshot: IGhosttySnapshot): IRowRange | undefined {
    const buffer = snapshot.alternate ? this.buffers.alt : this.buffers.normal;
    const changedBuffer = buffer !== this.buffer;
    const oldYbase = buffer.ybase;
    const oldYdisp = buffer.ydisp;
    const oldX = buffer.x;
    const oldY = buffer.y;
    const oldRows = Array.from({ length: this.rows }, (_, y) => buffer.lines.get(oldYdisp + y));
    // Track the visible row so a full scrollback keeps its position as rows expire.
    if (changedBuffer) {
      this._viewport.clear();
      this.isUserScrolling = false;
    }
    if (snapshot.trimmed) {
      buffer.lines.trimStart(snapshot.trimmed);
    }
    buffer.lines.maxLength = Math.max(snapshot.rows.length, this.rows + this._options.rawOptions.scrollback);
    buffer.lines.length = snapshot.rows.length;
    buffer.x = snapshot.x;
    buffer.y = snapshot.y;
    buffer.ybase = snapshot.history;
    buffer.ydisp = this.isUserScrolling && !changedBuffer ? Math.min(oldYdisp, buffer.ybase) : buffer.ybase;
    if (this._viewport.value) {
      buffer.ydisp = Math.min(this._viewport.value.line() ?? 0, buffer.ybase);
    }

    const links: { row: IGhosttyRow, line: IBufferLine, y: number }[] = [];
    for (let y = 0; y < snapshot.rows.length; y++) {
      const row = snapshot.rows[y];
      let line = this._lines.get(row);
      if (!line) {
        line = this._makeLine(row, buffer);
        this._lines.set(row, line);
        if (row.cells.some(cell => cell.uri)) {
          links.push({ row, line, y });
        }
      }
      buffer.lines.set(y, line);
    }

    if (snapshot.alternate) {
      this.buffers.activateAltBuffer();
    } else {
      this.buffers.activateNormalBuffer();
    }
    // Register links after the complete buffer view becomes active.
    for (const { row, line, y } of links) {
      this._attachLinks(row, line, y);
    }
    if (changedBuffer || snapshot.trimmed || oldYbase !== buffer.ybase || oldYdisp !== buffer.ydisp) {
      this._onScroll.fire(buffer.ydisp);
    }

    let start = this.rows;
    let end = -1;
    for (let y = 0; y < this.rows; y++) {
      const cursorChanged = (oldX !== buffer.x || oldY !== buffer.y)
        && (y === oldYbase + oldY - oldYdisp || y === buffer.ybase + buffer.y - buffer.ydisp);
      if (changedBuffer || oldRows[y] !== buffer.lines.get(buffer.ydisp + y) || cursorChanged) {
        start = Math.min(start, y);
        end = y;
      }
    }
    return end < 0 ? undefined : { start, end };
  }

  private _makeLine(row: IGhosttyRow, buffer: IBuffer): IBufferLine {
    const line = new BufferLine(this.cols, buffer.getNullCell(), row.wrapped);
    const cell = new CellData();
    for (let x = 0; x < row.cells.length; x++) {
      const data = row.cells[x];
      const style = data.style;
      cell.setFromCharData([0, data.text, data.width, data.text.codePointAt(0) ?? 0]);
      cell.fg = style.fg
        | (style.bold ? FgFlags.BOLD : 0) | (style.blink ? FgFlags.BLINK : 0)
        | (style.inverse ? FgFlags.INVERSE : 0) | (style.invisible ? FgFlags.INVISIBLE : 0)
        | (style.strikethrough ? FgFlags.STRIKETHROUGH : 0) | (style.underline ? FgFlags.UNDERLINE : 0);
      cell.bg = style.bg | (style.italic ? BgFlags.ITALIC : 0) | (style.faint ? BgFlags.DIM : 0)
        | (style.overline ? BgFlags.OVERLINE : 0) | (data.protected ? BgFlags.PROTECTED : 0);
      cell.extended = DEFAULT_ATTR_DATA.extended.clone();
      cell.extended.underlineStyle = style.underline;
      cell.extended.underlineColor = style.underlineColor;
      cell.updateExtended();
      line.setCell(x, cell);
    }
    return line;
  }

  private _attachLinks(row: IGhosttyRow, line: IBufferLine, y: number): void {
    if (!this._linkService) {
      return;
    }
    const cell = new CellData();
    for (let x = 0; x < row.cells.length; x++) {
      const uri = row.cells[x].uri;
      if (!uri) {
        continue;
      }
      line.loadCell(x, cell);
      cell.extended = cell.extended.clone();
      cell.extended.urlId = this._linkService.registerLink({ id: uri, uri });
      this._linkService.addLineToLink(cell.extended.urlId, y);
      cell.updateExtended();
      line.setCell(x, cell);
    }
  }

  public resize(cols: number, rows: number): void {
    this._engine.resize(cols, rows);
    const colsChanged = cols !== this.cols;
    const rowsChanged = rows !== this.rows;
    this.cols = cols;
    this.rows = rows;
    this.buffers.resize(cols, rows);
    this.sync();
    this._onResize.fire({ cols, rows, colsChanged, rowsChanged });
  }

  public reset(): void {
    this._viewport.clear();
    this._engine.reset(this._options.rawOptions.convertEol);
    this.buffers.reset();
    this._lines = new WeakMap();
    this.isUserScrolling = false;
    this.sync();
  }

  public scroll(_eraseAttr: IAttributeData, _isWrapped?: boolean): void {
    this._engine.write('\x1bD');
    this.sync();
  }

  public scrollLines(disp: number, suppressScrollEvent?: boolean): void {
    const buffer = this.buffer;
    const position = Math.max(0, Math.min(buffer.ybase, buffer.ydisp + disp));
    this.isUserScrolling = position < buffer.ybase;
    if (position === buffer.ydisp) {
      return;
    }
    buffer.ydisp = position;
    this._viewport.value = this.isUserScrolling ? this._engine.trackLine(position) : undefined;
    if (!suppressScrollEvent) {
      this._onScroll.fire(position);
    }
  }
}
