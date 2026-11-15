// FEAT-18.2: a dependency-free QR code generator (ISO/IEC 18004) for the
// «Подключить телефон» link. Scope on purpose: byte mode (UTF-8), error
// correction level M, versions 1–10 (up to 213 bytes — a sign-in link is
// ~100). Pure: text → module matrix; the client draws it as SVG.
//
//   const qr = qrEncode("https://example.com/teleharness/#/pair/…");
//   qr.size, qr.version, qr.mask, qr.modules[y][x] === true → dark
//
// The algorithm follows the standard step by step: segment bits → terminator
// and pad bytes → Reed–Solomon ECC per block (GF(256), poly 0x11D) →
// interleave → function patterns (finders, separators, timing, alignment,
// dark module, format and version info) → zig-zag placement → the mask
// with the lowest penalty (N1–N4).

export const QR_MAX_VERSION = 10;
// Level M per version (index = version): ECC codewords per block, block count.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_ECL_M = 0; // format-info bits of level M (L=1, M=0, Q=3, H=2)

// Data-area modules of a version (everything but function patterns).
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

export function dataCodewords(ver) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}

// Byte-mode capacity (bytes) of a version at level M.
export function byteCapacity(ver) {
  return Math.floor((dataCodewords(ver) * 8 - 4 - (ver <= 9 ? 8 : 16)) / 8);
}

// Alignment pattern centres (both axes) of a version.
export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// --- Reed–Solomon over GF(2^8) -------------------------------------------------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// Generator polynomial of the given degree (leading 1 omitted), roots 2^0..2^(d-1).
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

export function rsRemainder(data, divisor) {
  const out = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] ^= gfMul(divisor[i], factor);
  }
  return out;
}

// --- format / version information (BCH) ---------------------------------------

// 15 bits: level + mask, BCH(15,5) with poly 0x537, XOR mask 0x5412.
export function formatBits(mask, ecl = FORMAT_ECL_M) {
  const data = (ecl << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// 18 bits for versions ≥ 7: BCH(18,6) with poly 0x1F25.
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// --- data codewords --------------------------------------------------------------

function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

function encodeData(bytes, ver) {
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = dataCodewords(ver) * 8;
  push(0, Math.min(4, cap - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// Split into blocks, append ECC to each, interleave.
function addEccAndInterleave(data, ver) {
  const numBlocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0); // placeholder: short blocks have one data byte less
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  }
  return out;
}

// --- matrix --------------------------------------------------------------------------

function makeGrid(size, v) {
  return Array.from({ length: size }, () => new Array(size).fill(v));
}

function drawFunctionPatterns(ver, size, modules, isFn) {
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0); // timing
    set(i, 6, i % 2 === 0);
  }
  // finders + separators (the 9×9 square around each, clipped to the grid)
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver);
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue; // finder corners
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(0, size, modules, isFn); // reserve (real bits after the mask is chosen)
  if (ver >= 7) {
    const v = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(v, i));
      set(b, a, bit(v, i));
    }
  }
}

function drawFormat(mask, size, modules, isFn) {
  const f = formatBits(mask);
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    if (isFn) isFn[y][x] = true;
  };
  // copy 1: around the top-left finder
  for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
  set(8, 7, bit(f, 6));
  set(8, 8, bit(f, 7));
  set(7, 8, bit(f, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
  // copy 2: split between the top-right and bottom-left finders
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
  set(8, size - 8, true); // the dark module
}

function drawCodewords(codewords, size, modules, isFn) {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (isFn[y][x]) continue;
        if (i < total) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        } // remainder bits stay light
      }
    }
  }
}

// Mask condition (x = column, y = row): true → the module is inverted.
export function maskHit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError("mask 0..7");
  }
}

function applyMask(mask, size, modules, isFn) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (!isFn[y][x] && maskHit(mask, x, y)) modules[y][x] = !modules[y][x];
  }
}

// Penalty score (ISO/IEC 18004 §7.8.3): N1 runs ≥5, N2 2×2 blocks, N3
// finder-like 1:1:3:1:1 with 4 light modules on a side (outside = light),
// N4 dark/light balance.
export function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const line = (get) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    // N3: dark-light-dark×3-light-dark with 4 light on either side
    const at = (i) => (i < 0 || i >= size ? false : get(i));
    for (let i = -4; i < size; i++) {
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) continue;
      const before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
      const after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
      if (before) s += 40;
      if (after) s += 40;
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) score += line((y) => modules[y][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

// text → {version, size, mask, modules}. opts.mask forces a mask (tests);
// opts.minVersion forces a larger symbol. Throws RangeError when the text
// does not fit version 10.
export function qrEncode(text, { mask = null, minVersion = 1 } = {}) {
  const bytes = utf8Bytes(text);
  let ver = Math.max(1, minVersion | 0);
  while (ver <= QR_MAX_VERSION && bytes.length > byteCapacity(ver)) ver++;
  if (ver > QR_MAX_VERSION) throw new RangeError(`QR: ${bytes.length} байт не помещаются в версию ${QR_MAX_VERSION}`);
  const size = ver * 4 + 17;
  const base = makeGrid(size, false);
  const isFn = makeGrid(size, false);
  drawFunctionPatterns(ver, size, base, isFn);
  drawCodewords(addEccAndInterleave(encodeData(bytes, ver), ver), size, base, isFn);

  const build = (m) => {
    const grid = base.map((row) => row.slice());
    applyMask(m, size, grid, isFn);
    drawFormat(m, size, grid, null);
    return grid;
  };
  let best = null;
  if (mask != null) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError("mask 0..7");
    best = { mask, modules: build(mask) };
  } else {
    for (let m = 0; m < 8; m++) {
      const grid = build(m);
      const p = penalty(grid);
      if (!best || p < best.p) best = { mask: m, modules: grid, p };
    }
  }
  return { version: ver, size, mask: best.mask, modules: best.modules };
}

// SVG path data of the dark modules (1 unit per module, offset by `quiet`):
// one «M x yh1v1h-1z» per horizontal run — small and crisp at any scale.
export function qrSvgPath(modules, quiet = 4) {
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return d;
}
