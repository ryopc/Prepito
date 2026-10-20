/**
 * xeddsa.ts のユニットテスト
 *
 * テストベクタは libsignal v0.40.1 の
 *   rust/protocol/src/curve/curve25519.rs :: tests::test_signature
 * から取得。libsignal は Ed25519 ではなく XEdDSA (Schnorr over Curve25519) を使う。
 */

import { bytesToHex, hexToBytes } from '../bytes';
import { XEDDSA_SIGNATURE_LENGTH, xeddsaSign, xeddsaVerify } from '../xeddsa';

const ALICE_IDENTITY_PRIVATE = 'c097248412e58bf05df487968205132794178e367637f5818f81e0e6ce73e865';
const ALICE_IDENTITY_PUBLIC = 'ab7e717d4a163b7d9a1d8071dfe9dcf8cdcd1cea3339b6356be84d887e322c64';
/** 署名対象のメッセージ (33 バイト: 0x05 + 公開鍵) */
const ALICE_EPHEMERAL_PUBLIC = '05edce9d9c415ca78cb7252e72c2c4a554d3eb29485a0e1d503118d1a82d99fb4a';
const ALICE_SIGNATURE =
  '5de88ca9a89b4a115da79109c67c9c7464a3e4180274f1cb8c63c2984e286dfbede82deb9dcd9fae0bfbb821569b3d9001bd8130cd11d486cef047bd60b86e88';

describe('XEdDSA (libsignal 公式テストベクタ)', () => {
  it('正規の署名を検証できる', () => {
    const valid = xeddsaVerify(
      hexToBytes(ALICE_IDENTITY_PUBLIC),
      hexToBytes(ALICE_EPHEMERAL_PUBLIC),
      hexToBytes(ALICE_SIGNATURE)
    );
    expect(valid).toBe(true);
  });

  it('署名を 1 ビット改変すると検証に失敗する', () => {
    const signature = hexToBytes(ALICE_SIGNATURE);
    for (let i = 0; i < signature.length; i++) {
      const tampered = new Uint8Array(signature);
      tampered[i] ^= 0x01;

      const valid = xeddsaVerify(
        hexToBytes(ALICE_IDENTITY_PUBLIC),
        hexToBytes(ALICE_EPHEMERAL_PUBLIC),
        tampered
      );
      expect(valid).toBe(false);
    }
  });

  it('メッセージを改変すると検証に失敗する', () => {
    const message = hexToBytes(ALICE_EPHEMERAL_PUBLIC);
    const tampered = new Uint8Array(message);
    tampered[0] ^= 0x01;

    expect(
      xeddsaVerify(hexToBytes(ALICE_IDENTITY_PUBLIC), tampered, hexToBytes(ALICE_SIGNATURE))
    ).toBe(false);
  });

  it('署名の長さが不正なら失敗する', () => {
    expect(
      xeddsaVerify(
        hexToBytes(ALICE_IDENTITY_PUBLIC),
        hexToBytes(ALICE_EPHEMERAL_PUBLIC),
        new Uint8Array(63)
      )
    ).toBe(false);
  });
});

describe('XEdDSA 署名生成', () => {
  it('生成した署名が検証を通る', () => {
    const privateKey = hexToBytes(ALICE_IDENTITY_PRIVATE);
    const message = hexToBytes(ALICE_EPHEMERAL_PUBLIC);

    const signature = xeddsaSign(privateKey, message);
    expect(signature.length).toBe(XEDDSA_SIGNATURE_LENGTH);
    expect(xeddsaVerify(hexToBytes(ALICE_IDENTITY_PUBLIC), message, signature)).toBe(true);
  });

  it('乱数を注入すると決定的な署名になる', () => {
    const privateKey = hexToBytes(ALICE_IDENTITY_PRIVATE);
    const message = hexToBytes(ALICE_EPHEMERAL_PUBLIC);
    const randomness = new Uint8Array(64).fill(0x42);

    const a = xeddsaSign(privateKey, message, randomness);
    const b = xeddsaSign(privateKey, message, randomness);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(xeddsaVerify(hexToBytes(ALICE_IDENTITY_PUBLIC), message, a)).toBe(true);
  });

  it('乱数の長さが不正なら例外を投げる', () => {
    expect(() =>
      xeddsaSign(hexToBytes(ALICE_IDENTITY_PRIVATE), new Uint8Array([1]), new Uint8Array(63))
    ).toThrow();
  });
});
