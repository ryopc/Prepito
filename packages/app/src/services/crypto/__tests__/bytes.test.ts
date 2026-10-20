/**
 * bytes.ts のユニットテスト
 *
 * Buffer を使わず Uint8Array のみで base64 / hex / リトルエンディアン変換を行う。
 */

import {
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  bytesToHex,
  bytesToNumberLE,
  concatBytes,
  hexToBytes,
  numberToBytesLE,
  utf8Decode,
  utf8Encode,
} from '../bytes';

describe('bytes', () => {
  it('base64 のエンコード/デコードが往復する', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe('AAEC/f7/');
    expect(bytesEqual(base64ToBytes(b64), bytes)).toBe(true);
  });

  it('base64 のパディングを正しく扱う', () => {
    expect(bytesToBase64(new Uint8Array([0x61]))).toBe('YQ==');
    expect(bytesToBase64(new Uint8Array([0x61, 0x62]))).toBe('YWI=');
    expect(bytesToBase64(new Uint8Array([0x61, 0x62, 0x63]))).toBe('YWJj');
    expect(bytesEqual(base64ToBytes('YQ=='), new Uint8Array([0x61]))).toBe(true);
    expect(bytesEqual(base64ToBytes('YWI='), new Uint8Array([0x61, 0x62]))).toBe(true);
  });

  it('base64 のデコードは URL セーフ文字と改行を許容する', () => {
    expect(bytesEqual(base64ToBytes('YWJj'), new Uint8Array([0x61, 0x62, 0x63]))).toBe(true);
    expect(bytesEqual(base64ToBytes('YWJj\n'), new Uint8Array([0x61, 0x62, 0x63]))).toBe(true);
  });

  it('hex のエンコード/デコードが往復する', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(bytes)).toBe('deadbeef');
    expect(bytesEqual(hexToBytes('deadbeef'), bytes)).toBe(true);
    expect(bytesEqual(hexToBytes('DEADBEEF'), bytes)).toBe(true);
  });

  it('リトルエンディアンの相互変換が正しい', () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(bytesToNumberLE(bytes)).toBe(0x04030201n);

    const encoded = numberToBytesLE(0x04030201n, 4);
    expect(bytesEqual(encoded, bytes)).toBe(true);

    const wide = numberToBytesLE(1n, 32);
    expect(wide.length).toBe(32);
    expect(wide[0]).toBe(1);
    expect(wide[31]).toBe(0);
  });

  it('concatBytes が順番どおりに連結する', () => {
    const result = concatBytes(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]));
    expect(bytesEqual(result, new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('UTF-8 のエンコード/デコードが往復する', () => {
    const text = 'こんにちは, Signal! 🔐';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('UTF-8 のエンコードバイト列が仕様どおりになる', () => {
    expect(bytesToHex(utf8Encode('ABC'))).toBe('414243');
    expect(bytesToHex(utf8Encode('こんにちは'))).toBe('e38193e38293e381abe381a1e381af');
    // サロゲートペア (U+1F510) は 4 バイト
    expect(bytesToHex(utf8Encode('🔐'))).toBe('f09f9490');
  });

  it('UTF-8 のデコードが仕様どおりになる', () => {
    expect(utf8Decode(hexToBytes('414243'))).toBe('ABC');
    expect(utf8Decode(hexToBytes('e38193e38293e381abe381a1e381af'))).toBe('こんにちは');
    expect(utf8Decode(hexToBytes('f09f9490'))).toBe('🔐');
  });
});
