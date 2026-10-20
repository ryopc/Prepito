/**
 * Curve25519 / Edwards 群演算
 *
 * - X25519 (DH) は @noble/curves の audited 実装を利用する
 * - Edwards 群演算 (XEdDSA 用) は自前実装 (拡張座標系 X:Y:Z:T)
 * - スカラー演算 ( mod l ) は自前実装
 *
 * libsignal-client v0.40 の Rust 実装
 * (rust/protocol/src/curve/curve25519.rs, curve25519-dalek) と同じ結果を返す。
 *
 * Node core ( crypto / buffer 等 ) は import しない。
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from './bytes';
import { randomBytes } from './random';

/** ed25519 曲線の素数 p = 2^255 - 19 */
export const ED25519_P = (1n << 255n) - 19n;

/** ed25519 群の位数 l = 2^252 + 27742317777372353535851937790883648493 */
export const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** 非負剰余 */
function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

/** 逆元 (拡張ユークリッド互除法) */
export function modInverse(value: bigint, modulus: bigint): bigint {
  if (value === 0n) throw new Error('modInverse(0) is undefined');
  let [oldR, r] = [mod(value, modulus), modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return mod(oldS, modulus);
}

/** べき乗 (square-and-multiply) */
export function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** edwards 曲線係数 d = -121665 / 121666 (mod p) */
export const ED25519_D = mod(-121665n * modInverse(121666n, ED25519_P), ED25519_P);

/** sqrt(-1) (mod p) : p ≡ 5 (mod 8) のため 2^((p-1)/4) が平方根になる */
export const ED25519_SQRT_M1 = powMod(2n, (ED25519_P - 1n) / 4n, ED25519_P);

/** ed25519 ベース点の x 座標 (偶数側) */
const ED25519_BASE_X =
  15112221349535400772501151409588531511454012693041857206046113283949847762202n;

/** ed25519 ベース点の y 座標 (4/5) */
const ED25519_BASE_Y =
  46316835694926478169428394003475163141307993866256225615783033603165251855960n;

/** Edwards 点 (拡張座標系: x = X/Z, y = Y/Z, T = XY/Z) */
export interface EdwardsPoint {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
  readonly t: bigint;
}

/** 単位元 (0, 1) */
export function edwardsIdentity(): EdwardsPoint {
  return { x: 0n, y: 1n, z: 1n, t: 0n };
}

/** ベース点 */
export function edwardsBase(): EdwardsPoint {
  return {
    x: ED25519_BASE_X,
    y: ED25519_BASE_Y,
    z: 1n,
    t: mod(ED25519_BASE_X * ED25519_BASE_Y, ED25519_P),
  };
}

/** 点加算 (a = -1 の twisted Edwards 曲線) */
export function edwardsAdd(p: EdwardsPoint, q: EdwardsPoint): EdwardsPoint {
  const a = mod((p.y - p.x) * (q.y - q.x), ED25519_P);
  const b = mod((p.y + p.x) * (q.y + q.x), ED25519_P);
  const c = mod(p.t * 2n * ED25519_D * q.t, ED25519_P);
  const d = mod(p.z * 2n * q.z, ED25519_P);
  const e = mod(b - a, ED25519_P);
  const f = mod(d - c, ED25519_P);
  const g = mod(d + c, ED25519_P);
  const h = mod(b + a, ED25519_P);
  return {
    x: mod(e * f, ED25519_P),
    y: mod(g * h, ED25519_P),
    z: mod(f * g, ED25519_P),
    t: mod(e * h, ED25519_P),
  };
}

/** 点倍 (a = -1) */
export function edwardsDouble(p: EdwardsPoint): EdwardsPoint {
  const a = mod(p.x * p.x, ED25519_P);
  const b = mod(p.y * p.y, ED25519_P);
  const c = mod(2n * p.z * p.z, ED25519_P);
  const d = mod(-a, ED25519_P);
  const e = mod((p.x + p.y) * (p.x + p.y) - a - b, ED25519_P);
  const g = mod(d + b, ED25519_P);
  const f = mod(g - c, ED25519_P);
  const h = mod(d - b, ED25519_P);
  return {
    x: mod(e * f, ED25519_P),
    y: mod(g * h, ED25519_P),
    z: mod(f * g, ED25519_P),
    t: mod(e * h, ED25519_P),
  };
}

/** 点の反転 (-x, y) */
export function edwardsNegate(p: EdwardsPoint): EdwardsPoint {
  return {
    x: mod(-p.x, ED25519_P),
    y: p.y,
    z: p.z,
    t: mod(-p.t, ED25519_P),
  };
}

/** スカラー倍算 (double-and-add) */
export function edwardsMultiply(p: EdwardsPoint, scalar: bigint): EdwardsPoint {
  let result = edwardsIdentity();
  let addend = p;
  let k = mod(scalar, ED25519_L);
  while (k > 0n) {
    if (k & 1n) result = edwardsAdd(result, addend);
    addend = edwardsDouble(addend);
    k >>= 1n;
  }
  return result;
}

/** Edwards 点を 32 バイトの圧縮表現に変換 (y + x の符号ビット) */
export function compressEdwardsPoint(point: EdwardsPoint): Uint8Array {
  const zInverse = modInverse(point.z, ED25519_P);
  const x = mod(point.x * zInverse, ED25519_P);
  const y = mod(point.y * zInverse, ED25519_P);
  const out = numberToBytesLE(y, 32);
  out[31] |= Number(x & 1n) << 7;
  return out;
}

/** mod p における平方根 (存在しない場合は null) */
export function sqrtModP(value: bigint): bigint | null {
  const a = mod(value, ED25519_P);
  if (a === 0n) return 0n;
  const candidate = powMod(a, (ED25519_P + 3n) / 8n, ED25519_P);
  if (mod(candidate * candidate, ED25519_P) === a) return candidate;
  const adjusted = mod(candidate * ED25519_SQRT_M1, ED25519_P);
  if (mod(adjusted * adjusted, ED25519_P) === a) return adjusted;
  return null;
}

/**
 * Montgomery u 座標から Edwards 点へ変換する (birational map)
 *
 * curve25519-dalek の `MontgomeryPoint::to_edwards(sign)` と同じ意味になり、
 * 変換後の点の x 座標の符号ビットは `sign` に一致する。
 *
 * @param u Montgomery 公開鍵 (32 バイト, 最上位ビットはマスクされる)
 * @param signBit x 座標の符号ビット (0 or 1)
 */
export function montgomeryToEdwards(u: Uint8Array, signBit: number): EdwardsPoint | null {
  const masked = new Uint8Array(u);
  masked[31] &= 0x7f;
  const uValue = bytesToNumberLE(masked);

  const denominator = mod(uValue + 1n, ED25519_P);
  if (denominator === 0n) return null;

  // y = (u - 1) / (u + 1)
  const y = mod((uValue - 1n) * modInverse(denominator, ED25519_P), ED25519_P);

  // x^2 = (y^2 - 1) / (d * y^2 + 1)
  const ySquared = mod(y * y, ED25519_P);
  const numerator = mod(ySquared - 1n, ED25519_P);
  const xDenominator = mod(mod(ED25519_D * ySquared, ED25519_P) + 1n, ED25519_P);
  if (xDenominator === 0n) return null;
  const xSquared = mod(numerator * modInverse(xDenominator, ED25519_P), ED25519_P);

  const root = sqrtModP(xSquared);
  if (root === null) return null;

  // 要求された符号ビットに一致する方を選び、符号ビットを反転させる
  const wanted = BigInt(signBit & 1);
  const x = (root & 1n) === wanted ? root : mod(-root, ED25519_P);

  return { x, y, z: 1n, t: mod(x * y, ED25519_P) };
}

/** 32 バイト秘密鍵を X25519 の clamp 済み形式に正規化する */
export function clampPrivateKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) {
    throw new Error(`Invalid private key length: ${privateKey.length}`);
  }
  const out = new Uint8Array(privateKey);
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

/** 256 ビット整数を l で剰余.reduce (dalek Scalar::from_bytes_mod_order 相当) */
export function scalarFromBytes(bytes: Uint8Array): bigint {
  return mod(bytesToNumberLE(bytes), ED25519_L);
}

/** 512 ビット整数を l で剰余.reduce (dalek Scalar::from_hash 相当) */
export function scalarFromBytesWide(bytes: Uint8Array): bigint {
  return mod(bytesToNumberLE(bytes), ED25519_L);
}

/** X25519 秘密鍵の生成 (32 バイト, clamp 済み) */
export function generateX25519PrivateKey(): Uint8Array {
  return clampPrivateKey(randomBytes(32));
}

/** X25519 秘密鍵 → 公開鍵 (32 バイト) */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return new Uint8Array(x25519.getPublicKey(clampPrivateKey(privateKey)));
}

/** X25519 共有秘密 (32 バイト) */
export function x25519SharedSecret(
  privateKey: Uint8Array,
  remotePublicKey: Uint8Array
): Uint8Array {
  return new Uint8Array(
    x25519.getSharedSecret(clampPrivateKey(privateKey), new Uint8Array(remotePublicKey))
  );
}
