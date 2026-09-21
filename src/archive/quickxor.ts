/**
 * QuickXorHash, the only content hash personal OneDrive returns
 * (`file.hashes.quickXorHash`; no SHA-1 there, observed 2026-09-21, D-54).
 *
 * Port of Microsoft's published reference algorithm: a 160-bit register,
 * each byte XORed in at a position advancing 11 bits per byte (wrapping), and
 * the total length XORed into the last 8 bytes. Base64 of the 20 bytes.
 * Files are at most 50 MB and held in memory, so this is a one-shot function.
 */

const WIDTH = 160;
const SHIFT = 11;
const CELLS = 3; // ceil(160 / 64)
const MASK64 = (1n << 64n) - 1n;

export function quickXorHash(bytes: Uint8Array): string {
  const cells = [0n, 0n, 0n];
  let cell = 0;
  let offset = 0;
  const iterations = Math.min(bytes.length, WIDTH);

  for (let i = 0; i < iterations; i += 1) {
    const isLast = cell === CELLS - 1;
    const bitsInCell = isLast ? WIDTH % 64 : 64;
    // Every byte at positions i, i+160, i+320... lands on the same bits.
    let xored = 0;
    for (let j = i; j < bytes.length; j += WIDTH) xored ^= bytes[j]!;
    const value = BigInt(xored);

    if (offset <= bitsInCell - 8) {
      cells[cell] = (cells[cell]! ^ (value << BigInt(offset))) & MASK64;
    } else {
      const next = isLast ? 0 : cell + 1;
      cells[cell] = (cells[cell]! ^ (value << BigInt(offset))) & MASK64;
      cells[next] = (cells[next]! ^ (value >> BigInt(bitsInCell - offset))) & MASK64;
    }

    offset += SHIFT;
    while (offset >= bitsInCell) {
      cell = isLast ? 0 : cell + 1;
      offset -= bitsInCell;
    }
  }

  const out = new Uint8Array(WIDTH / 8);
  for (let c = 0; c < CELLS; c += 1) {
    const take = c === CELLS - 1 ? out.length - (CELLS - 1) * 8 : 8;
    for (let b = 0; b < take; b += 1) out[c * 8 + b] = Number((cells[c]! >> BigInt(8 * b)) & 0xffn);
  }
  let length = BigInt(bytes.length);
  for (let b = 0; b < 8; b += 1) {
    out[WIDTH / 8 - 8 + b]! ^= Number(length & 0xffn);
    length >>= 8n;
  }
  return Buffer.from(out).toString('base64');
}
