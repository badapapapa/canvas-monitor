import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { quickXorHash } from '../../src/archive/quickxor.ts';

/** Decode a hash back to its 20 bytes, to state expectations bit by bit. */
const bytesOf = (b64: string): number[] => [...Buffer.from(b64, 'base64')];
const zeros = (): number[] => new Array<number>(20).fill(0);

describe('QuickXorHash (D-54: the only hash personal OneDrive returns)', () => {
  // Hand-derived from Microsoft's published algorithm, not from this code.
  it('is 20 zero bytes for empty input', () => {
    assert.deepEqual(bytesOf(quickXorHash(new Uint8Array())), zeros());
  });

  it('puts the first byte at bit 0 and the length into bytes 12..19', () => {
    const want = zeros();
    want[0] = 0x01; // the byte
    want[12] = 0x01; // length 1, little-endian, XORed into the last 8 bytes
    assert.deepEqual(bytesOf(quickXorHash(Uint8Array.of(0x01))), want);
  });

  it('shifts each following byte 11 bits along', () => {
    // Byte 2 (0xff) at bit offset 11: bits 11..18 -> byte 1 gets 0xf8, byte 2 gets 0x07.
    const want = zeros();
    want[1] = 0xf8;
    want[2] = 0x07;
    want[12] = 0x02;
    assert.deepEqual(bytesOf(quickXorHash(Uint8Array.of(0x00, 0xff))), want);
  });

  it('wraps every 160 bytes: byte 160 lands on byte 0\'s bits', () => {
    const a = new Uint8Array(161);
    a[0] = 0x0f;
    a[160] = 0xf0;
    const want = zeros();
    want[0] = 0xff;
    want[12] = 161;
    assert.deepEqual(bytesOf(quickXorHash(a)), want);
  });

  // Pinned values. The implementation matched OneDrive's own quickXorHash for
  // a real 377-byte file on 2026-09-21; these synthetic inputs pin it there.
  it('matches pinned values across the wrap and a fragment boundary', () => {
    const syn = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);
    assert.equal(quickXorHash(syn(160)), '7gi7SoTZMRx5gfdODLshn/kHw6o=');
    assert.equal(quickXorHash(syn(161)), 'jQi7SoTZMRx5gfdODbshn/kHw6o=');
    assert.equal(quickXorHash(syn(377)), 'JTg7GlYlZnO+MyAC0D8QfIxpY2c=');
    assert.equal(quickXorHash(syn(1000)), 'dgD8j0n8sM0aPE5CUJ8tqmilX/E=');
    assert.equal(quickXorHash(syn(327_685)), 'A1BABDDwAQAAAAAABQAFAAAAAAA=');
  });
});
