/**
 * curve.ts (X25519 / Edwards 群演算) のユニットテスト
 *
 * テストベクタは libsignal v0.40.1 の
 *   rust/protocol/src/curve/curve25519.rs :: tests::test_agreement
 * から取得。
 */

import { bytesToHex, hexToBytes } from '../bytes';
import {
  clampPrivateKey,
  compressEdwardsPoint,
  edwardsAdd,
  edwardsBase,
  edwardsDouble,
  edwardsMultiply,
  modInverse,
  montgomeryToEdwards,
  scalarFromBytes,
  x25519PublicKey,
  x25519SharedSecret,
} from '../curve';

/** libsignal v0.40.1 rust/protocol/src/curve/curve25519.rs :: test_agreement */
const ALICE_PUBLIC = '1bb75966f2e93a3691dfff942bb2a466a1c08b8d78ca3f4d6df8b8bfa2e4ee28';
const ALICE_PRIVATE = 'c806439dc9d2c476ffed8f2580c0888d58ab406bf7ae3698879021b96bb4bf59';
const BOB_PUBLIC = '653614993d2b15ee9e5fd3d86ce719ef4ec1daae1886a87b3f5fa9565a27a22f';
const BOB_PRIVATE = 'b03b34c33a1c44f225b662d2bf4859b8135411fa7b0386d45fb75dc5b91b4466';
const SHARED_SECRET = '325f239328941ced6e673b86ba41017448e99b649a9c3806c1dd7ca4c477e629';

describe('X25519 (libsignal 公式テストベクタ)', () => {
  it('秘密鍵から公開鍵を導出できる', () => {
    expect(bytesToHex(x25519PublicKey(hexToBytes(ALICE_PRIVATE)))).toBe(ALICE_PUBLIC);
    expect(bytesToHex(x25519PublicKey(hexToBytes(BOB_PRIVATE)))).toBe(BOB_PUBLIC);
  });

  it('共有秘密が一致する', () => {
    const aliceSecret = x25519SharedSecret(hexToBytes(ALICE_PRIVATE), hexToBytes(BOB_PUBLIC));
    const bobSecret = x25519SharedSecret(hexToBytes(BOB_PRIVATE), hexToBytes(ALICE_PUBLIC));

    expect(bytesToHex(aliceSecret)).toBe(SHARED_SECRET);
    expect(bytesToHex(bobSecret)).toBe(SHARED_SECRET);
  });
});

describe('clampPrivateKey', () => {
  it('X25519 の clamp 規則を適用する', () => {
    const clamped = clampPrivateKey(new Uint8Array(32).fill(0xff));
    expect(clamped[0]).toBe(0xf8);
    expect(clamped[31]).toBe(0x7f);
  });

  it('32 バイト以外を拒否する', () => {
    expect(() => clampPrivateKey(new Uint8Array(31))).toThrow();
  });
});

describe('Edwards 群演算 (XEdDSA 用)', () => {
  it('ベースポイントの倍加が 2 倍算と一致する', () => {
    const base = edwardsBase();
    const doubled = compressEdwardsPoint(edwardsDouble(base));
    const multiplied = compressEdwardsPoint(edwardsMultiply(base, 2n));
    expect(bytesToHex(doubled)).toBe(bytesToHex(multiplied));
    expect(bytesToHex(doubled)).not.toBe(bytesToHex(compressEdwardsPoint(base)));
  });

  it('加法と倍算が一致する', () => {
    const base = edwardsBase();
    const added = compressEdwardsPoint(edwardsAdd(base, base));
    const multiplied = compressEdwardsPoint(edwardsMultiply(base, 2n));
    expect(bytesToHex(added)).toBe(bytesToHex(multiplied));
  });

  it('圧縮 (compress) が 32 バイトを返す', () => {
    expect(compressEdwardsPoint(edwardsBase()).length).toBe(32);
  });

  it('montgomeryToEdwards が x 座標の符号ビットを反映する', () => {
    // libsignal の test_signature にある Alice の Montgomery 公開鍵
    const montgomery = 'ab7e717d4a163b7d9a1d8071dfe9dcf8cdcd1cea3339b6356be84d887e322c64';
    const point = montgomeryToEdwards(hexToBytes(montgomery), 0);
    expect(point).not.toBeNull();
    if (!point) return;
    // Edwards 形式に圧縮すると最上位ビットが符号ビットになる
    const compressed = compressEdwardsPoint(point);
    expect(compressed[31] & 0x80).toBe(0);
  });

  it('スカラー剰余計算が正しい', () => {
    expect(modInverse(2n, 7n)).toBe(4n);
    expect(scalarFromBytes(new Uint8Array(32))).toBe(0n);
  });
});
