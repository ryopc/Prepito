/**
 * Double Ratchet の鍵導出 (ChainKey / RootKey) のユニットテスト
 *
 * テストベクタは libsignal v0.40.1 の
 *   rust/protocol/src/ratchet/keys.rs :: tests::test_chain_key_derivation
 * から取得。
 */

import { bytesToHex, hexToBytes } from '../bytes';
import { PrivateKey } from '../signal-keys';
import { ChainKey, RootKey, deriveX3DHKeys } from '../signal-session';

const SEED = '8ab72d6f4cc5ac0d387eaf463378ddb28edd07385b1cb01250c715982e7ad48f';
const MESSAGE_KEY = 'bf51e9d75e0e31031051f82a2491ffc084fa298b7793bd9db620056febf45217';
const MAC_KEY = 'c6c77d6a73a354337a56435e34607dfe48e3ace14e77314dc6abc172e7a7030b';
const NEXT_CHAIN_KEY = '28e8f8fee54b801eef7c5cfb2f17f32c7b334485bbb70fac6ec10342a246d15d';

describe('ChainKey (libsignal 公式テストベクタ)', () => {
  const chainKey = new ChainKey(hexToBytes(SEED), 0);

  it('chain key 自体を保持する', () => {
    expect(bytesToHex(chainKey.key)).toBe(SEED);
    expect(chainKey.index).toBe(0);
  });

  it('cipher key を導出できる', () => {
    expect(bytesToHex(chainKey.messageKeys().cipherKey)).toBe(MESSAGE_KEY);
  });

  it('mac key を導出できる', () => {
    expect(bytesToHex(chainKey.messageKeys().macKey)).toBe(MAC_KEY);
  });

  it('next chain key を導出できる', () => {
    const next = chainKey.nextChainKey();
    expect(bytesToHex(next.key)).toBe(NEXT_CHAIN_KEY);
    expect(next.index).toBe(1);
    expect(next.messageKeys().counter).toBe(1);
  });

  it('message key の counter は chain key の index と一致する', () => {
    expect(chainKey.messageKeys().counter).toBe(0);
  });
});

describe('RootKey', () => {
  it('createChain が root key と chain key を返す', () => {
    const root = new RootKey(hexToBytes(SEED));
    const theirs = PrivateKey.generate().getPublicKey();
    const ours = PrivateKey.generate();

    const { rootKey, chainKey } = root.createChain(theirs, ours);
    expect(rootKey.key.length).toBe(32);
    expect(chainKey.key.length).toBe(32);
    expect(chainKey.index).toBe(0);

    // 同じ入力なら同じ結果になる
    const again = root.createChain(theirs, ours);
    expect(bytesToHex(again.rootKey.key)).toBe(bytesToHex(rootKey.key));
    expect(bytesToHex(again.chainKey.key)).toBe(bytesToHex(chainKey.key));
  });
});

describe('deriveX3DHKeys (HKDF-SHA256 / WhisperText)', () => {
  it('64 バイトを root key と chain key に分割する', () => {
    const secrets = new Uint8Array(96).fill(0xaa);
    const { rootKey, chainKey } = deriveX3DHKeys(secrets);
    expect(rootKey.key.length).toBe(32);
    expect(chainKey.key.length).toBe(32);
  });

  it('入力が異なれば導出結果も異なる', () => {
    const a = deriveX3DHKeys(new Uint8Array(96).fill(0xaa));
    const b = deriveX3DHKeys(new Uint8Array(96).fill(0xbb));
    expect(bytesToHex(a.rootKey.key)).not.toBe(bytesToHex(b.rootKey.key));
  });
});
