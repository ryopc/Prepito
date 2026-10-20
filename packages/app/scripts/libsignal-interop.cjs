'use strict';

/**
 * libsignal-client v0.40 との相互運用テスト
 *
 * 実行方法:
 *   node packages/app/scripts/libsignal-interop.cjs
 *
 * 前提:
 *   - ルートに node_modules が install 済み (@signalapp/libsignal-client / sucrase を利用)
 *   - packages/app/src/services/crypto/*.ts を sucrace で読み込む
 *
 * テスト内容:
 *   1. libsignal (Alice) -> 純 TS 実装 (Bob) -> libsignal (Alice)
 *   2. 純 TS 実装 (Alice) -> libsignal (Bob) -> 純 TS 実装 (Alice)
 *   3. 同一実装内の X3DH + Double Ratchet ラウンドトリップ
 */

const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------------------
// expo-crypto は React Native 専用なので Node 実行時は crypto.randomBytes に差し替える
// ---------------------------------------------------------------------------
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'expo-crypto') {
    return {
      getRandomBytes: (n) => require('crypto').randomBytes(n),
    };
  }
  return originalLoad.apply(this, arguments);
};

require('sucrase/register/ts');

const libsignal = require('@signalapp/libsignal-client');

const cryptoDir = path.join(__dirname, '..', 'src', 'services', 'crypto');
const { PrivateKey, PublicKey, PreKeyBundle } = require(path.join(cryptoDir, 'signal-keys.ts'));
const { PreKeySignalMessage, SignalMessage } = require(path.join(cryptoDir, 'signal-message.ts'));
const { processPreKeyBundle, processPreKeyMessage, encryptMessage, decryptMessage } = require(
  path.join(cryptoDir, 'signal-session.ts')
);

/** UTF-8 エンコード (Node の Buffer を利用) */
function encodeUtf8(text) {
  return Buffer.from(text, 'utf8');
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` :: ${detail}` : ''}`);
}

/* =====================================================================
   libsignal 用のインメモリ Store
   ===================================================================== */

class MemorySessionStore extends libsignal.SessionStore {
  constructor() {
    super();
    this.sessions = new Map();
  }
  async saveSession(name, record) {
    this.sessions.set(name.toString(), record);
  }
  async getSession(name) {
    return this.sessions.get(name.toString()) ?? null;
  }
  async getExistingSessions(addresses) {
    return addresses.map((a) => this.sessions.get(a.toString())).filter(Boolean);
  }
  async deleteSession(name) {
    this.sessions.delete(name.toString());
  }
  async deleteAllSessions() {
    this.sessions.clear();
  }
}

class MemoryIdentityStore extends libsignal.IdentityKeyStore {
  constructor(identityKey, registrationId) {
    super();
    this.identityKey = identityKey;
    this.registrationId = registrationId;
    this.identities = new Map();
  }
  async getIdentityKey() {
    return this.identityKey;
  }
  async getLocalRegistrationId() {
    return this.registrationId;
  }
  async saveIdentity(name, key) {
    this.identities.set(name.toString(), key);
    return true;
  }
  async isTrustedIdentity() {
    return true;
  }
  async getIdentity(name) {
    return this.identities.get(name.toString()) ?? null;
  }
}

class MemoryPreKeyStore extends libsignal.PreKeyStore {
  constructor() {
    super();
    this.keys = new Map();
  }
  async savePreKey(id, record) {
    this.keys.set(id, record);
  }
  async getPreKey(id) {
    const record = this.keys.get(id);
    if (!record) throw new Error(`PreKey ${id} not found`);
    return record;
  }
  async removePreKey(id) {
    this.keys.delete(id);
  }
}

class MemorySignedPreKeyStore extends libsignal.SignedPreKeyStore {
  constructor() {
    super();
    this.keys = new Map();
  }
  async saveSignedPreKey(id, record) {
    this.keys.set(id, record);
  }
  async getSignedPreKey(id) {
    const record = this.keys.get(id);
    if (!record) throw new Error(`SignedPreKey ${id} not found`);
    return record;
  }
}

class MemoryKyberPreKeyStore extends libsignal.KyberPreKeyStore {
  async saveKyberPreKey() {}
  async getKyberPreKey() {
    throw new Error('Kyber prekeys are not supported');
  }
  async markKyberPreKeyUsed() {}
}

/* =====================================================================
   共通ユーティリティ
   ===================================================================== */

const ADDRESS_NAME = 'interop-peer';
const DEVICE_ID = 1;

function toLibsignalPublicKey(publicKey) {
  return libsignal.PublicKey.deserialize(Buffer.from(publicKey.serialize()));
}

function fromLibsignalPublicKey(publicKey) {
  return PublicKey.deserialize(new Uint8Array(publicKey.serialize()));
}

/* =====================================================================
   シナリオ 1: libsignal (Alice) -> 純 TS (Bob) -> libsignal (Alice)
   ===================================================================== */

async function scenarioLibsignalAlice() {
  console.log('\n=== シナリオ 1: libsignal (Alice) <-> 純 TS 実装 (Bob) ===');

  // --- 純 TS 側の Bob 鍵 ---
  const bobIdentityPrivate = PrivateKey.generate();
  const bobIdentityPublic = bobIdentityPublicOf(bobIdentityPrivate);
  const bobSignedPreKeyPrivate = PrivateKey.generate();
  const bobSignedPreKeyPublic = bobSignedPreKeyPrivate.getPublicKey();
  const bobOneTimePreKeyPrivate = PrivateKey.generate();
  const bobOneTimePreKeyPublic = bobOneTimePreKeyPrivate.getPublicKey();
  const bobPreKeySignature = bobIdentityPrivate.sign(bobSignedPreKeyPublic.serialize());

  // --- libsignal 側の Alice 鍵 ---
  const aliceIdentity = libsignal.IdentityKeyPair.generate();
  const aliceSessionStore = new MemorySessionStore();
  const aliceIdentityStore = new MemoryIdentityStore(aliceIdentity.privateKey, 4242);
  const aliceAddress = libsignal.ProtocolAddress.new(ADDRESS_NAME, DEVICE_ID);

  // --- PreKeyBundle を組み立てて libsignal に processPreKeyBundle ---
  const bundle = libsignal.PreKeyBundle.new(
    7777,
    DEVICE_ID,
    0,
    toLibsignalPublicKey(bobOneTimePreKeyPublic),
    1,
    toLibsignalPublicKey(bobSignedPreKeyPublic),
    Buffer.from(bobPreKeySignature),
    toLibsignalPublicKey(bobIdentityPublic)
  );

  await libsignal.processPreKeyBundle(bundle, aliceAddress, aliceSessionStore, aliceIdentityStore);
  record('libsignal: processPreKeyBundle', true, 'セッション生成 OK');

  // --- libsignal が PreKeySignalMessage を送信 ---
  const plaintext = 'hello from libsignal to pure TypeScript';
  const cipher = await libsignal.signalEncrypt(
    Buffer.from(plaintext),
    aliceAddress,
    aliceSessionStore,
    aliceIdentityStore
  );
  const serialized = new Uint8Array(cipher.serialize());
  record(
    'libsignal: signalEncrypt (PreKeySignalMessage)',
    cipher.type() === libsignal.CiphertextMessageType.PreKey,
    `type=${cipher.type()} 先頭バイト=0x${serialized[0].toString(16)} 長さ=${serialized.length}`
  );

  // --- 純 TS 実装が復号 ---
  const preKeyMessage = PreKeySignalMessage.deserialize(serialized);
  const bobSession = processPreKeyMessage(
    preKeyMessage,
    bobIdentityPrivate,
    bobIdentityPublic,
    bobSignedPreKeyPrivate,
    bobSignedPreKeyPublic,
    bobOneTimePreKeyPrivate,
    9999
  );
  const decrypted = decryptMessage(bobSession, preKeyMessage.message);
  const decryptedText = Buffer.from(decrypted).toString('utf8');
  record('純 TS 実装: PreKeySignalMessage 復号', decryptedText === plaintext, `"${decryptedText}"`);

  // --- 純 TS 実装が返信 (SignalMessage) ---
  const replyPlaintext = 'reply from pure TypeScript to libsignal';
  const reply = encryptMessage(bobSession, encodeUtf8(replyPlaintext));
  const replyBytes = reply.serialize();
  record(
    '純 TS 実装: signalEncrypt (SignalMessage)',
    reply instanceof SignalMessage,
    `先頭バイト=0x${replyBytes[0].toString(16)} 長さ=${replyBytes.length}`
  );

  const libsignalReply = libsignal.SignalMessage.deserialize(Buffer.from(replyBytes));
  const libPlain = await libsignal.signalDecrypt(
    libsignalReply,
    aliceAddress,
    aliceSessionStore,
    aliceIdentityStore
  );
  record(
    'libsignal: SignalMessage 復号 (純 TS 実装からの返信)',
    Buffer.from(libPlain).toString('utf8') === replyPlaintext,
    `"${Buffer.from(libPlain).toString('utf8')}"`
  );

  // --- 続けて libsignal -> 純 TS (通常メッセージ) ---
  const second = 'second message over established session';
  const cipher2 = await libsignal.signalEncrypt(
    Buffer.from(second),
    aliceAddress,
    aliceSessionStore,
    aliceIdentityStore
  );
  const secondMessage = SignalMessage.deserialize(new Uint8Array(cipher2.serialize()));
  const secondPlain = Buffer.from(decryptMessage(bobSession, secondMessage)).toString('utf8');
  record(
    '純 TS 実装: SignalMessage 復号 (libsignal からの 2 回目)',
    secondPlain === second,
    `"${secondPlain}"`
  );
}

/* =====================================================================
   シナリオ 2: 純 TS (Alice) -> libsignal (Bob) -> 純 TS (Alice)
   ===================================================================== */

async function scenarioPureTypeScriptAlice() {
  console.log('\n=== シナリオ 2: 純 TS 実装 (Alice) <-> libsignal (Bob) ===');

  // --- libsignal 側の Bob 鍵 ---
  const bobIdentity = libsignal.IdentityKeyPair.generate();
  const bobSignedPreKey = libsignal.PrivateKey.generate();
  const bobOneTimePreKey = libsignal.PrivateKey.generate();
  const bobPreKeySignature = bobIdentity.privateKey.sign(
    bobSignedPreKey.getPublicKey().serialize()
  );

  const bobSessionStore = new MemorySessionStore();
  const bobIdentityStore = new MemoryIdentityStore(bobIdentity.privateKey, 8888);
  const bobPreKeyStore = new MemoryPreKeyStore();
  const bobSignedPreKeyStore = new MemorySignedPreKeyStore();
  const bobKyberPreKeyStore = new MemoryKyberPreKeyStore();
  const bobAddress = libsignal.ProtocolAddress.new(ADDRESS_NAME, DEVICE_ID);

  await bobSignedPreKeyStore.saveSignedPreKey(
    1,
    libsignal.SignedPreKeyRecord.new(
      1,
      Date.now(),
      bobSignedPreKey.getPublicKey(),
      bobSignedPreKey,
      Buffer.from(bobPreKeySignature)
    )
  );
  await bobPreKeyStore.savePreKey(
    0,
    libsignal.PreKeyRecord.new(0, bobOneTimePreKey.getPublicKey(), bobOneTimePreKey)
  );

  // --- 純 TS 側の Alice 鍵 ---
  const aliceIdentityPrivate = PrivateKey.generate();
  const aliceIdentityPublic = aliceIdentityPrivate.getPublicKey();

  // --- PreKeyBundle を組み立てる (libsignal の鍵で) ---
  const bundle = new PreKeyBundle(
    8888,
    DEVICE_ID,
    0,
    fromLibsignalPublicKey(bobOneTimePreKey.getPublicKey()),
    1,
    fromLibsignalPublicKey(bobSignedPreKey.getPublicKey()),
    new Uint8Array(bobPreKeySignature),
    fromLibsignalPublicKey(bobIdentity.publicKey)
  );

  const aliceSession = processPreKeyBundle(
    bundle,
    aliceIdentityPrivate,
    aliceIdentityPublic,
    5555,
    Math.floor(Date.now() / 1000)
  );
  record('純 TS 実装: processPreKeyBundle', true, 'libsignal 署名の XEdDSA 検証を 통과');

  const plaintext = 'hello from pure TypeScript to libsignal';
  const cipher = encryptMessage(aliceSession, encodeUtf8(plaintext));
  const serialized = cipher.serialize();
  record(
    '純 TS 実装: PreKeySignalMessage 生成',
    cipher instanceof PreKeySignalMessage,
    `先頭バイト=0x${serialized[0].toString(16)} 長さ=${serialized.length}`
  );

  const libPreKeyMessage = libsignal.PreKeySignalMessage.deserialize(Buffer.from(serialized));
  const libPlain = await libsignal.signalDecryptPreKey(
    libPreKeyMessage,
    bobAddress,
    bobSessionStore,
    bobIdentityStore,
    bobPreKeyStore,
    bobSignedPreKeyStore,
    bobKyberPreKeyStore
  );
  record(
    'libsignal: PreKeySignalMessage 復号 (純 TS 実装から)',
    Buffer.from(libPlain).toString('utf8') === plaintext,
    `"${Buffer.from(libPlain).toString('utf8')}"`
  );

  // --- libsignal が返信 ---
  const replyPlaintext = 'reply from libsignal to pure TypeScript alice';
  const libReply = await libsignal.signalEncrypt(
    Buffer.from(replyPlaintext),
    bobAddress,
    bobSessionStore,
    bobIdentityStore
  );
  const replyMessage = SignalMessage.deserialize(new Uint8Array(libReply.serialize()));
  const replyPlain = Buffer.from(decryptMessage(aliceSession, replyMessage)).toString('utf8');
  record(
    '純 TS 実装: SignalMessage 復号 (libsignal からの返信)',
    replyPlain === replyPlaintext,
    `"${replyPlain}"`
  );

  // --- 純 TS 実装がさらに送信 (libsignal 側で検証) ---
  const thirdPlaintext = 'third message from pure TypeScript alice';
  const third = encryptMessage(aliceSession, encodeUtf8(thirdPlaintext));
  const thirdLib = libsignal.SignalMessage.deserialize(Buffer.from(third.serialize()));
  const thirdPlain = await libsignal.signalDecrypt(
    thirdLib,
    bobAddress,
    bobSessionStore,
    bobIdentityStore
  );
  record(
    'libsignal: SignalMessage 復号 (純 TS 実装からの 2 回目)',
    Buffer.from(thirdPlain).toString('utf8') === thirdPlaintext,
    `"${Buffer.from(thirdPlain).toString('utf8')}"`
  );
}

/* =====================================================================
   シナリオ 3: 純 TS 実装だけのラウンドトリップ
   ===================================================================== */

async function scenarioPureRoundTrip() {
  console.log('\n=== シナリオ 3: 純 TS 実装のみ (X3DH + Double Ratchet) ===');

  const bobIdentityPrivate = PrivateKey.generate();
  const bobIdentityPublic = bobIdentityPrivate.getPublicKey();
  const bobSignedPreKeyPrivate = PrivateKey.generate();
  const bobSignedPreKeyPublic = bobSignedPreKeyPrivate.getPublicKey();
  const bobOneTimePreKeyPrivate = PrivateKey.generate();
  const bobOneTimePreKeyPublic = bobOneTimePreKeyPrivate.getPublicKey();
  const bobSignature = bobIdentityPrivate.sign(bobSignedPreKeyPublic.serialize());

  const aliceIdentityPrivate = PrivateKey.generate();
  const aliceIdentityPublic = aliceIdentityPrivate.getPublicKey();

  const bundle = new PreKeyBundle(
    1000,
    DEVICE_ID,
    0,
    bobOneTimePreKeyPublic,
    1,
    bobSignedPreKeyPublic,
    bobSignature,
    bobIdentityPublic
  );

  const aliceSession = processPreKeyBundle(
    bundle,
    aliceIdentityPrivate,
    aliceIdentityPublic,
    2000,
    Math.floor(Date.now() / 1000)
  );
  const aliceMessage = encryptMessage(aliceSession, encodeUtf8('ping'));
  record(
    '純 TS 実装: PreKeySignalMessage 生成',
    aliceMessage instanceof PreKeySignalMessage,
    `先頭バイト=0x${aliceMessage.serialize()[0].toString(16)}`
  );

  const bobSession = processPreKeyMessage(
    aliceMessage,
    bobIdentityPrivate,
    bobIdentityPublic,
    bobSignedPreKeyPrivate,
    bobSignedPreKeyPublic,
    bobOneTimePreKeyPrivate,
    3000
  );
  const bobPlain = Buffer.from(decryptMessage(bobSession, aliceMessage.message)).toString('utf8');
  record('純 TS 実装: 復号', bobPlain === 'ping', `"${bobPlain}"`);

  const bobReply = encryptMessage(bobSession, encodeUtf8('pong'));
  const alicePlain = Buffer.from(decryptMessage(aliceSession, bobReply)).toString('utf8');
  record('純 TS 実装: 返信復号', alicePlain === 'pong', `"${alicePlain}"`);
}

/* =====================================================================
   補助
   ===================================================================== */

function bobIdentityPublicOf(privateKey) {
  return privateKey.getPublicKey();
}

/* =====================================================================
   実行
   ===================================================================== */

(async () => {
  try {
    await scenarioLibsignalAlice();
    await scenarioPureTypeScriptAlice();
    await scenarioPureRoundTrip();
  } catch (err) {
    record('interop script', false, String((err && err.stack) || err));
  }

  console.log('\n=== 結果サマリ ===');
  const failed = results.filter((r) => !r.ok);
  console.log(
    `total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
  );
  if (failed.length > 0) {
    console.log('失敗:');
    for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`);
    process.exitCode = 1;
  }
})();
