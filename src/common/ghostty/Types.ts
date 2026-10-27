/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

export interface IGhosttyStyle {
  fg: number;
  bg: number;
  underlineColor: number;
  underline: number;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

export interface IGhosttyCell {
  text: string;
  width: number;
  style: IGhosttyStyle;
  protected: boolean;
  uri?: string;
}

export interface IGhosttyRow {
  id: string;
  wrapped: boolean;
  cells: IGhosttyCell[];
}

export interface IGhosttySnapshot {
  alternate: boolean;
  x: number;
  y: number;
  history: number;
  trimmed: number;
  rows: IGhosttyRow[];
}

// Values from include/ghostty/vt/modes.h in Ghostty 1.4.0.
export const enum GhosttyMode {
  ANSI = 0x8000,
  INSERT = ANSI | 4,
  LINEFEED = ANSI | 20,
  CURSOR_KEYS = 1,
  ORIGIN = 6,
  WRAPAROUND = 7,
  X10_MOUSE = 9,
  CURSOR_BLINK = 12,
  CURSOR_VISIBLE = 25,
  REVERSE_WRAP = 45,
  KEYPAD = 66,
  NORMAL_MOUSE = 1000,
  BUTTON_MOUSE = 1002,
  ANY_MOUSE = 1003,
  FOCUS = 1004,
  SGR_MOUSE = 1006,
  PIXEL_MOUSE = 1016,
  BRACKETED_PASTE = 2004,
  SYNC_OUTPUT = 2026,
  GRAPHEMES = 2027,
  COLOR_SCHEME = 2031
}

export const enum GhosttyLimits {
  // Ghostty dimensions and render overscan use uint16_t.
  MAX_DIMENSION = 65535,
  MAX_SCROLLBACK = 65535,
  INPUT_CHUNK = 131072
}
