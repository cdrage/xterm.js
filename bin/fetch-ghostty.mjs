/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

// Official artifact for the signed Ghostty v1.4.0 tag. Never follow the moving tip URL.
const commit = '83fb95624b0439ee660c2679b43b38c8b63769cd';
const sha256 = 'e40fe5d53319c4d9ab9283802e2844ded9ca86eba52894f865fc67a849620166';
const url = `https://tip.files.ghostty.org/${commit}/ghostty-vt.wasm`;
const destination = new URL('../demo/dist/ghostty-vt.wasm', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

let bytes = await readFile(destination).catch(() => undefined);
if (!bytes || digest(bytes) !== sha256) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ghostty download failed: HTTP ${response.status}`);
  }
  bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== sha256) {
    throw new Error('Ghostty artifact SHA-256 mismatch');
  }
  await mkdir(new URL('.', destination), { recursive: true });
  await writeFile(destination, bytes);
}
const library = new URL('../lib/', import.meta.url);
await mkdir(library, { recursive: true });
await writeFile(new URL('ghostty-vt.wasm', library), bytes);
await copyFile(new URL('../src/common/ghostty/LICENSE', import.meta.url), new URL('ghostty-vt.LICENSE', library));
console.log(`Ghostty 1.4.0: ${destination.pathname} (SHA-256 ${sha256})`);
