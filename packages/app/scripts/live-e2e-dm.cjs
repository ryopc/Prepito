'use strict';

/**
 * 公開サーバ (https://koshi.ryopc.org) に対する E2E 暗号化 DM の実動作検証。
 *
 * アプリの純 TS 暗号実装 (packages/app/src/services/crypto) をそのまま使い、
 * 実サーバの REST API と組み合わせて
 *   送信側: X3DH セッション確立 -> Double Ratchet 暗号化 -> POST /api/dms/:userId
 *   受信側: GET /api/dms -> PreKeySignalMessage -> セッション構築 -> 復号
 * までを一気通貫で確認する。
 *
 * 実行方法:
 *   node packages/app/scripts/live-e2e-dm.cjs
 *
 * ⚠️ 注意:
 *   - 本番 DB にテストユーザを 2 件作成する（削除はしない）
 *   - 認証系にレート制限があるため、連続実行すると 429 になる
 *     （429 は自動で指数バックオフして再試行する）
 *   - CI では実行しない（ネットワーク依存のため）。手動でのみ実行すること
 *
 * 対比: オフラインで暗号コアのみを検証する場合は
 *       packages/app/scripts/libsignal-interop.cjs を使う
 */

const path = require('path');
const Module = require('module');
const nodeCrypto = require('crypto');

// ---------------------------------------------------------------------------
// expo-crypto は React Native 専用なので Node 実行時は crypto.randomBytes に差し替える
// ---------------------------------------------------------------------------
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'expo-crypto') {
    return { getRandomBytes: (n) => nodeCrypto.randomBytes(n) };
  }
  return originalLoad.apply(this, arguments);
};

require('sucrase/register/ts');

const cryptoDir = path.join(__dirname, '..', 'src', 'services', 'crypto');
const { IdentityKeyPair, PrivateKey, PublicKey, PreKeyBundle } = require(
  path.join(cryptoDir, 'signal-keys.ts')
);
const { PreKeySignalMessage, SignalMessage, CiphertextMessageType } = require(
  path.join(cryptoDir, 'signal-message.ts')
);
const { processPreKeyBundle, processPreKeyMessage, encryptMessage, decryptMessage } = require(
  path.join(cryptoDir, 'signal-session.ts')
);
const { bytesToBase64, base64ToBytes, utf8Encode, utf8Decode } = require(
  path.join(cryptoDir, 'bytes.ts')
);

const BASE = 'https://koshi.ryopc.org';
const hex = (b) => Buffer.from(b).toString('hex');

const results = [];
function record(name, okFlag, detail) {
  results.push({ name, ok: okFlag, detail });
  console.log(`[${okFlag ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

/* ------------------------------------------------------------------ */
/* HTTP ヘルパ                                                        */
/* ------------------------------------------------------------------ */
async function req(pathname, { method = 'GET', body, token } = {}) {
  // 429 (authLimiter 等) は指数バックオフで再試行する
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (res.status === 429 && attempt < 5) {
      const waitMs = 20000 * (attempt + 1);
      console.log(`  [429] ${pathname} を ${waitMs}ms 待機して再試行 (${attempt + 1}/5)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    return { status: res.status, body: parsed };
  }
  return { status: 429, body: { error: 'rate limited' } };
}

/* ------------------------------------------------------------------ */
/* デバイス鍵生成（アプリと同じ signal-keys.ts を使う）                 */
/* ------------------------------------------------------------------ */
function makeDevice() {
  const identity = IdentityKeyPair.generate();
  const signedPreKey = PrivateKey.generate();
  const oneTimePreKeys = [PrivateKey.generate(), PrivateKey.generate(), PrivateKey.generate()];
  return {
    identity,
    signedPreKey,
    oneTimePreKeys,
    registrationId: 10000 + Math.floor(Math.random() * 80000),
  };
}

/** デバイス鍵をサーバ想定の base64 形式に変換 */
function deviceToPayload(device) {
  // アプリと同じ: identity 鍵で signed prekey の公開鍵に XEdDSA 署名する
  // (device-keys.ts の generateDeviceKeys と同じ logic)
  const preKeySignatureBytes = device.identity.privateKey.sign(
    device.signedPreKey.getPublicKey().serialize()
  );
  return {
    deviceName: 'live-e2e-device',
    identityKey: bytesToBase64(device.identity.publicKey.serialize()),
    signedPreKey: bytesToBase64(device.signedPreKey.getPublicKey().serialize()),
    preKeySignature: bytesToBase64(preKeySignatureBytes),
    oneTimePreKeys: device.oneTimePreKeys.map((k) => bytesToBase64(k.getPublicKey().serialize())),
  };
}

/* ------------------------------------------------------------------ */
/* ユーザー登録（ed25519 hex / サーバの認証鍵）                         */
/* ------------------------------------------------------------------ */
async function makeUser(tag) {
  const username = `prepito_live_${tag}_${Date.now().toString(36)}`.slice(0, 32);
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyHex = hex(spki.subarray(spki.length - 32));

  const reg = await req('/api/auth/register', {
    method: 'POST',
    body: { username, publicKey: publicKeyHex },
  });
  if (reg.status !== 201)
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);

  const uname = username.trim().toLowerCase();
  const sig = nodeCrypto.sign(null, Buffer.from(`koshi:login:${uname}`, 'utf8'), privateKey);
  const login = await req('/api/auth/login', {
    method: 'POST',
    body: { username, signature: hex(sig) },
  });
  if (login.status !== 200)
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);

  return { username, userId: reg.body.userId, token: login.body.token, publicKeyHex };
}

/* ================================================================== */
(async () => {
  console.log('=== 0. ユーザー作成 ===');
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  console.log(`  alice: ${alice.username} (${alice.userId})`);
  console.log(`  bob  : ${bob.username} (${bob.userId})`);

  console.log('\n=== 1. デバイス登録（実サーバ） ===');
  const aliceDevice = makeDevice();
  const bobDevice = makeDevice();
  const aliceDevRes = await req('/api/devices', {
    method: 'POST',
    token: alice.token,
    body: deviceToPayload(aliceDevice),
  });
  const bobDevRes = await req('/api/devices', {
    method: 'POST',
    token: bob.token,
    body: deviceToPayload(bobDevice),
  });
  console.log(`  alice device: HTTP ${aliceDevRes.status} id=${aliceDevRes.body?.id}`);
  console.log(`  bob   device: HTTP ${bobDevRes.status} id=${bobDevRes.body?.id}`);
  aliceDevRes.status === 201 && bobDevRes.status === 201
    ? record('POST /api/devices（両者）', true, 'HTTP 201')
    : record(
        'POST /api/devices（両者）',
        false,
        `alice=${aliceDevRes.status} bob=${bobDevRes.status}`
      );

  console.log('\n=== 2. 送信側: 実サーバから PreKey Bundle 取得 ===');
  const bundleRes = await req(`/api/keys/bundle/${bob.userId}`, { token: alice.token });
  console.log(`  HTTP ${bundleRes.status}`);
  if (bundleRes.status !== 200) {
    record(
      'GET /api/keys/bundle',
      false,
      `HTTP ${bundleRes.status} ${JSON.stringify(bundleRes.body)}`
    );
    process.exit(1);
  }
  const sb = bundleRes.body.bundle;
  record(
    'GET /api/keys/bundle',
    true,
    `deviceId=${bundleRes.body.deviceId} prekeys=${sb.oneTimePreKeys.length}`
  );

  console.log(
    '\n=== 3. 送信側: X3DH セッション確立（app の convertToPreKeyBundle と同じ logic）==='
  );
  // session-manager.ts の convertToPreKeyBundle と同じ: preKeyId は 0 固定
  const oneTimePreKeys = sb.oneTimePreKeys || [];
  const preKeyPublic =
    oneTimePreKeys.length > 0 ? PublicKey.deserialize(base64ToBytes(oneTimePreKeys[0])) : null;
  const preKeyBundle = PreKeyBundle.new(
    bobDevice.registrationId,
    1,
    preKeyPublic ? 0 : null,
    preKeyPublic,
    1,
    PublicKey.deserialize(base64ToBytes(sb.signedPreKey)),
    base64ToBytes(sb.preKeySignature),
    PublicKey.deserialize(base64ToBytes(sb.identityKey))
  );
  const aliceSession = processPreKeyBundle(
    preKeyBundle,
    aliceDevice.identity.privateKey,
    aliceDevice.identity.publicKey,
    aliceDevice.registrationId,
    Math.floor(Date.now() / 1000)
  );
  record('processPreKeyBundle（送信側）', !!aliceSession, `preKeyId=${preKeyBundle.preKeyId}`);

  console.log('\n=== 4. 送信側: Double Ratchet 暗号化 ===');
  const PLAINTEXT = 'こんにちは、Prepito E2E 暗号化テスト 🍣 ' + Date.now();
  const encrypted = encryptMessage(aliceSession, utf8Encode(PLAINTEXT));
  const ciphertextB64 = bytesToBase64(encrypted.serialize());
  const msgType =
    encrypted instanceof PreKeySignalMessage
      ? CiphertextMessageType.PreKey
      : CiphertextMessageType.Whisper;
  console.log(`  暗号文長: ${ciphertextB64.length}  type=${msgType}`);
  record('encryptMessage（送信側）', ciphertextB64.length > 0, `type=${msgType}`);

  console.log('\n=== 5. 送信: POST /api/dms/:userId（実サーバ） ===');
  const sendRes = await req(`/api/dms/${bob.userId}`, {
    method: 'POST',
    token: alice.token,
    body: { content: ciphertextB64, signature: hex(nodeCrypto.randomBytes(64)) },
  });
  console.log(`  HTTP ${sendRes.status}  ${JSON.stringify(sendRes.body).slice(0, 200)}`);
  sendRes.status === 201 || sendRes.status === 200
    ? record('POST /api/dms/:userId', true, `HTTP ${sendRes.status} id=${sendRes.body?.id}`)
    : record(
        'POST /api/dms/:userId',
        false,
        `HTTP ${sendRes.status} ${JSON.stringify(sendRes.body).slice(0, 150)}`
      );

  console.log('\n=== 6. 受信側: GET /api/dms（実サーバ） ===');
  const dmRes = await req('/api/dms', { token: bob.token });
  console.log(
    `  HTTP ${dmRes.status}  DM数=${Array.isArray(dmRes.body) ? dmRes.body.length : 'n/a'}`
  );
  if (dmRes.status !== 200 || !Array.isArray(dmRes.body) || dmRes.body.length === 0) {
    record(
      'GET /api/dms',
      false,
      `HTTP ${dmRes.status} ${JSON.stringify(dmRes.body).slice(0, 150)}`
    );
    process.exit(1);
  }
  const dm = dmRes.body[0];
  record('GET /api/dms', true, `from=${dm.from?.username} contentLen=${dm.content.length}`);

  console.log('\n=== 7. 受信側: PreKeySignalMessage → セッション構築 → 復号 ===');
  const raw = base64ToBytes(dm.content);
  const preKeyMessage = PreKeySignalMessage.deserialize(raw);
  console.log(
    `  preKeyId=${preKeyMessage.preKeyId} signedPreKeyId=${preKeyMessage.signedPreKeyId} registrationId=${preKeyMessage.registrationId}`
  );

  // クライアントの collectPreKeyCandidates と同じ候補探索:
  // 1) メッセージの preKeyId に対応する未使用 prekey
  // 2) 未使用 prekey を順に試す (MAC 検証で正解判定)
  const candidateIds = [];
  if (preKeyMessage.preKeyId !== null) candidateIds.push(preKeyMessage.preKeyId);
  for (let i = 0; i < bobDevice.oneTimePreKeys.length; i++) {
    if (!candidateIds.includes(i)) candidateIds.push(i);
  }

  let decrypted = null;
  let usedCandidate = null;
  let bobSession = null;
  for (const cid of candidateIds) {
    const candidate = bobDevice.oneTimePreKeys[cid];
    if (!candidate) continue;
    try {
      const session = processPreKeyMessage(
        preKeyMessage,
        bobDevice.identity.privateKey,
        bobDevice.identity.publicKey,
        bobDevice.signedPreKey,
        bobDevice.signedPreKey.getPublicKey(),
        candidate,
        bobDevice.registrationId
      );
      const plaintext = decryptMessage(session, preKeyMessage.message);
      decrypted = utf8Decode(plaintext);
      usedCandidate = cid;
      bobSession = session;
      break;
    } catch (e) {
      // 候補が一致しない場合は次を試す (クライアントのフォールバックと同じ挙動)
    }
  }

  if (decrypted === null) {
    record('復号（受信側）', false, '全ての prekey 候補で復号失敗');
  } else {
    record('復号（受信側）', true, `採用 prekey 候補 index=${usedCandidate}`);
    record(
      '平文が一致',
      decrypted === PLAINTEXT,
      `期待="${PLAINTEXT.slice(0, 40)}..." / 実際="${decrypted.slice(0, 40)}..."`
    );
  }

  console.log('\n=== 8. 既存セッションでの 2 通目（Double Ratchet の更新） ===');
  const PLAINTEXT2 = '2 通目のメッセージ（既存セッション）';
  const encrypted2 = encryptMessage(aliceSession, utf8Encode(PLAINTEXT2));
  const send2 = await req(`/api/dms/${bob.userId}`, {
    method: 'POST',
    token: alice.token,
    body: {
      content: bytesToBase64(encrypted2.serialize()),
      signature: hex(nodeCrypto.randomBytes(64)),
    },
  });
  console.log(
    `  POST HTTP ${send2.status}  type=${encrypted2 instanceof PreKeySignalMessage ? 'PreKey(3)' : 'Whisper(2)'}`
  );
  const dmRes2 = await req('/api/dms', { token: bob.token });
  const dm2 = dmRes2.body.find((d) => d.content !== dm.content);
  if (dm2 && bobSession) {
    // 2 通目も PreKeySignalMessage の可能性がある
    // (送信側が prekey の ack を受けるまで PreKey で送り続けるのが Signal の仕様)
    const bytes2 = base64ToBytes(dm2.content);
    let inner;
    try {
      const asPre = PreKeySignalMessage.deserialize(bytes2);
      inner = asPre.message;
    } catch {
      inner = SignalMessage.deserialize(bytes2);
    }
    let plain2 = null;
    try {
      plain2 = utf8Decode(decryptMessage(bobSession, inner));
    } catch (e) {
      plain2 = `復号エラー: ${e.message}`;
    }
    record(
      '2 通目の復号（既存セッション）',
      plain2 === PLAINTEXT2,
      plain2 === PLAINTEXT2 ? `実際="${plain2}"` : plain2
    );
  } else {
    record('2 通目の復号（既存セッション）', false, '2 通目の DM またはセッションが取得できない');
  }

  console.log('\n' + '='.repeat(64));
  console.log('  判定サマリ');
  console.log('='.repeat(64));
  for (const r of results)
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  const fails = results.filter((r) => !r.ok).length;
  console.log('='.repeat(64));
  console.log(`  PASS ${results.length - fails} / FAIL ${fails}`);
  process.exit(fails > 0 ? 1 : 0);
})().catch((e) => {
  console.error('  FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
