/**
 * signal-session.ts (X3DH + Double Ratchet) のユニットテスト
 *
 * DB に依存しない暗号コアのみを検証する。
 * libsignal-client との実相互運用は packages/app/scripts/libsignal-interop.cjs で行う。
 */

import { bytesToHex, utf8Decode, utf8Encode } from '../bytes';
import { IdentityKeyPair, PreKeyBundle, PrivateKey, PublicKey } from '../signal-keys';
import { PreKeySignalMessage, SignalMessage } from '../signal-message';
import {
  SessionState,
  decryptMessage,
  encryptMessage,
  processPreKeyBundle,
  processPreKeyMessage,
} from '../signal-session';

interface Party {
  identity: IdentityKeyPair;
  signedPreKey: PrivateKey;
  oneTimePreKey: PrivateKey;
}

function makeParty(): Party {
  return {
    identity: IdentityKeyPair.generate(),
    signedPreKey: PrivateKey.generate(),
    oneTimePreKey: PrivateKey.generate(),
  };
}

function buildBundle(bob: Party): PreKeyBundle {
  const signature = bob.identity.privateKey.sign(bob.signedPreKey.getPublicKey().serialize());
  return PreKeyBundle.new(
    1000,
    1,
    42,
    bob.oneTimePreKey.getPublicKey(),
    1,
    bob.signedPreKey.getPublicKey(),
    signature,
    bob.identity.publicKey
  );
}

describe('X3DH セッション確立', () => {
  it('PreKeyBundle から Alice セッションを生成し Bob 側で復号できる', () => {
    const alice = makeParty();
    const bob = makeParty();

    const aliceSession = processPreKeyBundle(
      buildBundle(bob),
      alice.identity.privateKey,
      alice.identity.publicKey,
      2000,
      1700000000
    );

    expect(aliceSession.pendingPreKey).not.toBeNull();
    expect(aliceSession.pendingPreKey?.preKeyId).toBe(42);
    expect(aliceSession.remoteRegistrationId).toBe(1000);
    expect(aliceSession.localRegistrationId).toBe(2000);

    const plaintext = utf8Encode('こんにちは、Signal Protocol!');
    const message = encryptMessage(aliceSession, plaintext);
    expect(message).toBeInstanceOf(PreKeySignalMessage);
    // PreKeySignalMessage の先頭バイトはバージョンバイト 0x34
    expect(message.serialize()[0]).toBe(0x34);

    const bobSession = processPreKeyMessage(
      message as PreKeySignalMessage,
      bob.identity.privateKey,
      bob.identity.publicKey,
      bob.signedPreKey,
      bob.signedPreKey.getPublicKey(),
      bob.oneTimePreKey,
      1000
    );

    const decrypted = decryptMessage(bobSession, (message as PreKeySignalMessage).message);
    expect(utf8Decode(decrypted)).toBe('こんにちは、Signal Protocol!');
  });

  it('署名が不正ならセッションを確立しない', () => {
    const alice = makeParty();
    const bob = makeParty();

    const bundle = PreKeyBundle.new(
      1000,
      1,
      42,
      bob.oneTimePreKey.getPublicKey(),
      1,
      bob.signedPreKey.getPublicKey(),
      new Uint8Array(64),
      bob.identity.publicKey
    );

    expect(() =>
      processPreKeyBundle(
        bundle,
        alice.identity.privateKey,
        alice.identity.publicKey,
        2000,
        1700000000
      )
    ).toThrow(/Signature validation failed/);
  });

  it('one-time prekey 無しでもセッションを確立できる', () => {
    const alice = makeParty();
    const bob = makeParty();

    const signature = bob.identity.privateKey.sign(bob.signedPreKey.getPublicKey().serialize());
    const bundle = PreKeyBundle.new(
      1000,
      1,
      null,
      null,
      1,
      bob.signedPreKey.getPublicKey(),
      signature,
      bob.identity.publicKey
    );

    const aliceSession = processPreKeyBundle(
      bundle,
      alice.identity.privateKey,
      alice.identity.publicKey,
      2000,
      1700000000
    );

    const message = encryptMessage(aliceSession, utf8Encode('hi'));
    const bobSession = processPreKeyMessage(
      message as PreKeySignalMessage,
      bob.identity.privateKey,
      bob.identity.publicKey,
      bob.signedPreKey,
      bob.signedPreKey.getPublicKey(),
      null,
      1000
    );
    const decrypted = decryptMessage(bobSession, (message as PreKeySignalMessage).message);
    expect(utf8Decode(decrypted)).toBe('hi');
  });
});

describe('Double Ratchet', () => {
  /**
   * Alice -> Bob の最初のメッセージ (PreKeySignalMessage) を建立済みのセッションを返す。
   * Alice 側はまだ応答を受信していないため pendingPreKey が残る。
   */
  function establish(): { alice: SessionState; bob: SessionState } {
    const alice = makeParty();
    const bob = makeParty();

    const aliceSession = processPreKeyBundle(
      buildBundle(bob),
      alice.identity.privateKey,
      alice.identity.publicKey,
      2000,
      1700000000
    );

    const first = encryptMessage(aliceSession, utf8Encode('ping')) as PreKeySignalMessage;

    const bobSession = processPreKeyMessage(
      first,
      bob.identity.privateKey,
      bob.identity.publicKey,
      bob.signedPreKey,
      bob.signedPreKey.getPublicKey(),
      bob.oneTimePreKey,
      1000
    );
    decryptMessage(bobSession, first.message);

    return { alice: aliceSession, bob: bobSession };
  }

  it('双方向で往復できる', () => {
    const { alice, bob } = establish();

    // 応答を受けていないので Alice の最初のメッセージは PreKeySignalMessage
    const a1 = encryptMessage(alice, utf8Encode('Alice->Bob 1'));
    expect(a1).toBeInstanceOf(PreKeySignalMessage);
    const b1 = decryptMessage(bob, (a1 as PreKeySignalMessage).message);
    expect(utf8Decode(b1)).toBe('Alice->Bob 1');

    // Bob は応答済みなので SignalMessage になる
    const b2 = encryptMessage(bob, utf8Encode('Bob->Alice 1'));
    expect(b2).toBeInstanceOf(SignalMessage);
    const a2 = decryptMessage(alice, b2 as SignalMessage);
    expect(utf8Decode(a2)).toBe('Bob->Alice 1');

    // Alice も応答を受けたので以降は SignalMessage になる
    const a3 = encryptMessage(alice, utf8Encode('Alice->Bob 2'));
    expect(a3).toBeInstanceOf(SignalMessage);
    const b3 = decryptMessage(bob, a3 as SignalMessage);
    expect(utf8Decode(b3)).toBe('Alice->Bob 2');
  });

  it('暗号化により counter が昇順になる', () => {
    const { alice } = establish();
    const first = encryptMessage(alice, utf8Encode('1')) as PreKeySignalMessage;
    const second = encryptMessage(alice, utf8Encode('2')) as PreKeySignalMessage;
    expect(first.message.counter).toBeLessThan(second.message.counter);
  });

  it('改変されたメッセージは復号に失敗する', () => {
    const { alice, bob } = establish();
    const message = encryptMessage(alice, utf8Encode('secret')) as PreKeySignalMessage;
    const tampered = new Uint8Array(message.message.serialize());
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptMessage(bob, SignalMessage.deserialize(tampered))).toThrow();
  });

  it('セッションの JSON 化で状態が保存・復元できる', () => {
    const { alice, bob } = establish();

    const restored = SessionState.fromJSON(alice.toJSON());
    expect(bytesToHex(restored.rootKeyBytes)).toBe(bytesToHex(alice.rootKeyBytes));
    expect(restored.pendingPreKey?.preKeyId).toBe(42);
    expect(restored.localIdentityPublic).toEqual(alice.localIdentityPublic);
    expect(restored.remoteIdentityPublic).toEqual(alice.remoteIdentityPublic);
    expect(restored.senderChainKey().index).toBe(alice.senderChainKey().index);

    // 復元したセッションで送ったメッセージは-counter が連続しており Bob が復号できる
    const message = encryptMessage(restored, utf8Encode('persist')) as PreKeySignalMessage;

    const decrypted = decryptMessage(bob, message.message);
    expect(utf8Decode(decrypted)).toBe('persist');
  });
});

describe('鍵の wire 表現', () => {
  it('IdentityKeyPair が protobuf 形式で往復する', () => {
    const pair = IdentityKeyPair.generate();
    const restored = IdentityKeyPair.deserialize(pair.serialize());
    expect(restored.publicKey.equals(pair.publicKey)).toBe(true);
    expect(bytesToHex(restored.privateKey.serialize())).toBe(
      bytesToHex(pair.privateKey.serialize())
    );
  });

  it('公開鍵に 0x05 が付く', () => {
    const key = PublicKey.fromBytes(new Uint8Array(32).fill(0x01));
    expect(key.serialize()[0]).toBe(0x05);
    expect(key.serialize().length).toBe(33);
  });
});
