/**
 * signal-message.ts (wire format) のユニットテスト
 *
 * libsignal-client v0.40 の Protobuf ベース wire format:
 *   SignalMessage       = version(1) || protobuf || mac(8)
 *   PreKeySignalMessage = version(1) || protobuf
 *   version byte = ((message_version & 0xF) << 4) | 4
 */

import { bytesToHex } from '../bytes';
import { PrivateKey, PublicKey } from '../signal-keys';
import {
  CIPHERTEXT_MESSAGE_CURRENT_VERSION,
  CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION,
  PreKeySignalMessage,
  SIGNAL_MESSAGE_MAC_LENGTH,
  SignalMessage,
  messageVersionByte,
} from '../signal-message';

describe('messageVersionByte', () => {
  it('Kyber 無しのセッション (version 3) は 0x34 になる', () => {
    expect(messageVersionByte(CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION)).toBe(0x34);
  });

  it('Kyber 対応のセッション (version 4) は 0x44 になる', () => {
    expect(messageVersionByte(CIPHERTEXT_MESSAGE_CURRENT_VERSION)).toBe(0x44);
  });
});

describe('SignalMessage', () => {
  const senderIdentity = PrivateKey.generate().getPublicKey();
  const receiverIdentity = PrivateKey.generate().getPublicKey();
  const ratchetKey = PrivateKey.generate().getPublicKey();
  const macKey = new Uint8Array(32).fill(0x5a);
  const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  function build(): SignalMessage {
    return SignalMessage.new(
      CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION,
      macKey,
      ratchetKey,
      7,
      3,
      ciphertext,
      senderIdentity,
      receiverIdentity
    );
  }

  it('先頭バイトがバージョンバイトになる', () => {
    expect(build().serialize()[0]).toBe(0x34);
  });

  it('末尾に 8 バイトの MAC が付く', () => {
    const serialized = build().serialize();
    expect(serialized.length).toBeGreaterThan(SIGNAL_MESSAGE_MAC_LENGTH);
  });

  it('シリアライズ/デシリアライズが往復する', () => {
    const message = build();
    const restored = SignalMessage.deserialize(message.serialize());
    expect(restored.messageVersion).toBe(CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION);
    expect(restored.counter).toBe(7);
    expect(restored.previousCounter).toBe(3);
    expect(bytesToHex(restored.senderRatchetKey.serialize())).toBe(
      bytesToHex(ratchetKey.serialize())
    );
    expect(bytesToHex(restored.ciphertext)).toBe(bytesToHex(ciphertext));
  });

  it('正しい鍵で MAC 検証が通る', () => {
    const message = build();
    expect(message.verifyMac(senderIdentity, receiverIdentity, macKey)).toBe(true);
  });

  it('送信者/受信者を入れ替えると MAC 検証が失敗する', () => {
    const message = build();
    expect(message.verifyMac(receiverIdentity, senderIdentity, macKey)).toBe(false);
  });

  it('MAC 鍵が違えば検証が失敗する', () => {
    const message = build();
    expect(message.verifyMac(senderIdentity, receiverIdentity, new Uint8Array(32).fill(0x11))).toBe(
      false
    );
  });

  it('短すぎるバイト列はデシリアライズできない', () => {
    expect(() => SignalMessage.deserialize(new Uint8Array(4))).toThrow();
  });
});

describe('PreKeySignalMessage', () => {
  const identityKey = PrivateKey.generate().getPublicKey();
  const baseKey = PrivateKey.generate().getPublicKey();
  const ratchetKey = PrivateKey.generate().getPublicKey();
  const macKey = new Uint8Array(32).fill(0x33);
  const ciphertext = new Uint8Array(16).fill(0x99);

  function build(): PreKeySignalMessage {
    const inner = SignalMessage.new(
      CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION,
      macKey,
      ratchetKey,
      0,
      0,
      ciphertext,
      identityKey,
      identityKey
    );
    return PreKeySignalMessage.new(
      CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION,
      12345,
      42,
      1,
      baseKey,
      identityKey,
      inner
    );
  }

  it('先頭バイトが 0x34 になる', () => {
    expect(build().serialize()[0]).toBe(0x34);
  });

  it('シリアライズ/デシリアライズが往復する', () => {
    const message = build();
    const restored = PreKeySignalMessage.deserialize(message.serialize());
    expect(restored.registrationId).toBe(12345);
    expect(restored.preKeyId).toBe(42);
    expect(restored.signedPreKeyId).toBe(1);
    expect(bytesToHex(restored.baseKey.serialize())).toBe(bytesToHex(baseKey.serialize()));
    expect(bytesToHex(restored.identityKey.serialize())).toBe(bytesToHex(identityKey.serialize()));
    expect(restored.message.counter).toBe(0);
  });

  it('preKeyId 無しでも構成できる', () => {
    const inner = SignalMessage.new(
      CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION,
      macKey,
      ratchetKey,
      0,
      0,
      ciphertext,
      identityKey,
      identityKey
    );
    const message = PreKeySignalMessage.new(
      CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION,
      1,
      null,
      1,
      baseKey,
      identityKey,
      inner
    );
    const restored = PreKeySignalMessage.deserialize(message.serialize());
    expect(restored.preKeyId).toBeNull();
  });
});

describe('公開鍵の wire 表現', () => {
  it('serialize は 0x05 + 32 バイトの 33 バイトになる', () => {
    const key = PrivateKey.generate().getPublicKey();
    const serialized = key.serialize();
    expect(serialized.length).toBe(33);
    expect(serialized[0]).toBe(0x05);
    expect(PublicKey.deserialize(serialized).equals(key)).toBe(true);
  });

  it('秘密鍵は clamp 済みの 32 バイトになる', () => {
    const key = PrivateKey.generate();
    expect(key.serialize().length).toBe(32);
  });
});
