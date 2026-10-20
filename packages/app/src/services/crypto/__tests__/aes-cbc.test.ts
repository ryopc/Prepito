/**
 * AES-256-CBC (PKCS#7) のユニットテスト
 *
 * テストベクタは libsignal v0.40.1 の
 *   rust/crypto/src/aes_cbc.rs :: tests::aes_cbc_test
 * から取得。NIST SP 800-38A F.2.5 (CBC-AES256.Encrypt) も併記する。
 */

import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from '../bytes';
import { aes256CbcDecrypt, aes256CbcEncrypt } from '../signal-session';

/** libsignal rust/crypto/src/aes_cbc.rs :: aes_cbc_test */
const LIBSIGNAL_KEY = '4e22eb16d964779994222e82192ce9f747da72dc4abe49dfdeeb71d0ffe3796e';
const LIBSIGNAL_IV = '6f8a557ddc0a140c878063a6d5f31d3d';
const LIBSIGNAL_PLAINTEXT = '30736294a124482a4159';
const LIBSIGNAL_CIPHERTEXT = 'dd3f573ab4508b9ed0e45e0baf5608f3';

/** NIST SP 800-38A F.2.5 (CBC-AES256.Encrypt) */
const NIST_KEY = '603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4';
const NIST_IV = '000102030405060708090a0b0c0d0e0f';
const NIST_PLAINTEXT =
  '6bc1bee22e409f96e93d7e117393172a' +
  'ae2d8a571e03ac9c9eb76fac45af8e51' +
  '30c81c46a35ce411e5fbc1191a0a52ef' +
  'f69f2445df4f9b17ad2b417be66c3710';
const NIST_CIPHERTEXT =
  'f58c4c04d6e5f1ba779eabfb5f7bfbd6' +
  '9cfc4e967edb808d679f777bc6702c7d' +
  '39f23369a9d9bacfa530e26304231461' +
  'b2eb05e2c39be9fcda6c19078c6a9d1b';

describe('AES-256-CBC (libsignal 公式テストベクタ)', () => {
  it('暗号化が一致する', () => {
    const ciphertext = aes256CbcEncrypt(
      hexToBytes(LIBSIGNAL_PLAINTEXT),
      hexToBytes(LIBSIGNAL_KEY),
      hexToBytes(LIBSIGNAL_IV)
    );
    expect(bytesToHex(ciphertext)).toBe(LIBSIGNAL_CIPHERTEXT);
  });

  it('復号で元に戻る', () => {
    const recovered = aes256CbcDecrypt(
      hexToBytes(LIBSIGNAL_CIPHERTEXT),
      hexToBytes(LIBSIGNAL_KEY),
      hexToBytes(LIBSIGNAL_IV)
    );
    expect(bytesToHex(recovered)).toBe(LIBSIGNAL_PLAINTEXT);
  });

  it('パディング不正の暗号文は復号に失敗する', () => {
    // 平文をそのまま暗号文として渡すとパディングが不正になる
    expect(() =>
      aes256CbcDecrypt(
        hexToBytes(LIBSIGNAL_PLAINTEXT),
        hexToBytes(LIBSIGNAL_KEY),
        hexToBytes(LIBSIGNAL_IV)
      )
    ).toThrow();
  });

  it('IV を暗号文に置き換えると復号に失敗する', () => {
    expect(() =>
      aes256CbcDecrypt(
        hexToBytes(LIBSIGNAL_CIPHERTEXT),
        hexToBytes(LIBSIGNAL_KEY),
        hexToBytes(LIBSIGNAL_CIPHERTEXT)
      )
    ).toThrow();
  });

  it('IV を 1 ビット改変すると復号結果が変わる', () => {
    const recovered = aes256CbcDecrypt(
      hexToBytes(LIBSIGNAL_CIPHERTEXT),
      hexToBytes(LIBSIGNAL_KEY),
      hexToBytes('ef8a557ddc0a140c878063a6d5f31d3d')
    );
    expect(bytesToHex(recovered)).toBe('b0736294a124482a4159');
  });
});

describe('AES-256-CBC (NIST SP 800-38A F.2.5)', () => {
  it('F.2.5 の暗号化が一致する', () => {
    const ciphertext = aes256CbcEncrypt(
      hexToBytes(NIST_PLAINTEXT),
      hexToBytes(NIST_KEY),
      hexToBytes(NIST_IV)
    );
    // 先頭 4 ブロックが NIST の表と一致する (5 ブロック目は PKCS#7 パディング)
    expect(bytesToHex(ciphertext.slice(0, 64))).toBe(NIST_CIPHERTEXT);
  });

  it('往復で元に戻り、PKCS#7 パディングが除去される', () => {
    const plaintext = utf8Encode('こんにちは Signal');
    const ciphertext = aes256CbcEncrypt(plaintext, hexToBytes(NIST_KEY), hexToBytes(NIST_IV));
    expect(ciphertext.length % 16).toBe(0);
    const decrypted = aes256CbcDecrypt(ciphertext, hexToBytes(NIST_KEY), hexToBytes(NIST_IV));
    expect(utf8Decode(decrypted)).toBe('こんにちは Signal');
  });

  it('不正な暗号文長は例外を投げる', () => {
    expect(() =>
      aes256CbcDecrypt(new Uint8Array(5), hexToBytes(NIST_KEY), hexToBytes(NIST_IV))
    ).toThrow();
  });
});
