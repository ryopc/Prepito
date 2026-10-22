# koshi サーバ API コントラクト（Prepito が必要とするもの）

> **サーバ実装を他 AI エージェントに委譲する場合のプロンプト**:
> [`koshi-v5-implementation-prompt.md`](koshi-v5-implementation-prompt.md)

Prepito（クライアント）が前提とする koshi サーバの API 仕様です。

## ✅ 実装済み・本番デプロイ済み（2026-10-22 確認）

公開サーバ `https://koshi.ryopc.org` に対し、Prepito クライアントの
**契約に一致するレスポンス**が返ることを確認しました
（コミット `ad971ae` / `a15aae7` で Render へデプロイ済み）。

| メソッド | パス | 実装 | 用途 | 実測 |
|---------|------|------|------|------|
| POST | `/api/auth/register` | ✅ | ユーザー登録（公開鍵は hex） | 201 |
| POST | `/api/auth/login` | ✅ | ed25519 チャレンジ応答ログイン | 200 |
| POST | `/api/auth/refresh` | ✅ | アクセストークン更新（refresh token はローテーション） | 200 / 再利用 401 |
| POST | `/api/auth/logout` | ✅ | ログアウト | 200 `{"success":true}` |
| GET | `/api/users/me` | ✅ | 自分のプロフィール取得（`publicKey` / `isAdmin` 付き） | 200 |
| POST | `/api/users/me/push-token` | ✅ | プッシュトークン登録 | 200 |
| DELETE | `/api/users/me/push-token` | ✅ | プッシュトークン削除 | 200 |
| GET | `/api/devices` | ✅ | 自分のデバイス一覧 | 200 |
| POST | `/api/devices` | ✅ | デバイス登録（X3DH 鍵） | 201 |
| DELETE | `/api/devices/:deviceId` | ✅ | デバイス削除（他人のものは 404） | 200 / 404 |
| GET | `/api/devices/user/:userId` | ✅ | 他ユーザーのデバイス取得 | 200 |
| GET | `/api/keys/bundle/:userId` | ✅ | **PreKey Bundle 取得（X3DH の要）** | 200（prekey 1 消費） |
| GET | `/api/users/:username` | ✅ | プロフィール取得（`publicKey` hex 64 / `isAdmin` 付き） | 200 |
| GET/POST | `/api/groups/*` | ⚠️ 未実装 | グループ機能（現状クライアントでも未使用） | - |

**E2E 暗号化 DM の実証**: アプリの実暗号実装（純 TS Signal Protocol）を使い、
実サーバに対して X3DH セッション確立 → Double Ratchet 暗号化 → DM 送受信 →
復号までを一気通貫で検証済み。平文完全一致・2 通目も成功。
検証スクリプト: [`packages/app/scripts/live-e2e-dm.cjs`](../packages/app/scripts/live-e2e-dm.cjs)

```bash
# 公開サーバに対して E2E 暗号化 DM を通す（本番 DB にテストユーザを作るため注意）
node packages/app/scripts/live-e2e-dm.cjs
```

### 実装上の注意点

- `bundle.oneTimePreKeys` は **base64 の `string[]`** で返る
  （サーバ内部では JSONB `[{id, publicKey}]` で保存しているが、API 層で `string[]` に変換される）
- `preKeySignature` は **XEdDSA 署名**であること
  （identity 鍵で signed prekey の公開鍵に署名する。
  不正な署名を登録してもサーバは受理し、クライアント側で
  `Signature validation failed` によりセッション確立に失敗する）
- `POST /api/auth/refresh` は refresh token を使用ごとにローテーションされ、
  使用済みのトークンの再利用は 401 になる

---

## 1. エンコーディング規約

**用途ごとに異なる**ため、混同しないこと。

| 対象 | 形式 | 長さ | 根拠 |
|------|------|------|------|
| `/api/auth/register` の `publicKey` | **hex** | 64 文字 | サーバが `/^[0-9a-f]{64}$/i` で検証 |
| `/api/auth/login` の `signature` | **hex** | 128 文字 | サーバが `hexToBytes()` でデコード |
| デバイスの `identityKey` / `signedPreKey` / `oneTimePreKeys` | **base64** | 44 文字 | 33 バイト（`0x05` + 32 バイト）のシリアライズ結果 |
| デバイスの `preKeySignature` | **base64** | 88 文字 | XEdDSA 署名 64 バイト |

> base64 で送ると 400 `"Invalid public key format"` 、
> hex でデバイス鍵を送るとデコードに失敗してセッション確立が失敗する。

---

## 2. `POST /api/devices`（デバイス登録）

### リクエスト

```json
{
  "deviceName": "Pixel 8",
  "identityKey": "<base64: 33 bytes>",
  "signedPreKey": "<base64: 33 bytes>",
  "preKeySignature": "<base64: 64 bytes>",
  "oneTimePreKeys": ["<base64: 33 bytes>", "..."]
}
```

### レスポンス（200 / 201）

```json
{
  "id": "3",
  "userId": "uuid",
  "deviceName": "Pixel 8",
  "identityKey": "<base64>",
  "signedPreKey": "<base64>",
  "preKeySignature": "<base64>",
  "oneTimePreKeys": ["<base64>"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "lastSeenAt": "2026-01-01T00:00:00.000Z"
}
```

- `id` は **数値文字列**として返し、端末の識別子（device id）として
  `GET /api/keys/bundle/:userId?deviceId=<id>` と WebSocket の
  `ProtocolAddress`（`userId` + device id）中使用する。
- `oneTimePreKeys` は未使用のものだけを返すこと。

---

## 3. `GET /api/keys/bundle/:userId`（PreKey Bundle 取得）

X3DH 鍵交換の要。**このエンドポイントが無ければ暗号化メッセージの送信が
原理的に成立しない。**

### クエリ

- `deviceId`（任意）: 相手端末を特定する場合は指定

### レスポンス（200）

```json
{
  "userId": "uuid",
  "deviceId": "3",
  "bundle": {
    "identityKey": "<base64: 33 bytes>",
    "signedPreKey": "<base64: 33 bytes>",
    "preKeySignature": "<base64: 64 bytes>",
    "oneTimePreKeys": ["<base64: 33 bytes>"]
  }
}
```

### 検証について

サーバは送信者の `identityKey` で `preKeySignature` を **XEdDSA** で検証し、
無効な場合は拒否すること（クライアント側でも検証する）。

XEdDSA の仕様: <https://signal.org/docs/specifications/xeddsa/>

---

## 4. `preKeyId` が返らない問題（要サーバ側改善）

現状のクライアントは `bundle.oneTimePreKeys[0]` を使い、
preKey id を `0` として通知する。サーバが preKey id を返さないため、
受信側では **MAC 検証が成功するまで未使用の one-time prekey を順に試す**
フォールバックで対処している。

サーバ側で以下を実装すると、この回避が不要になり堅牢になる。

- `bundle` に `oneTimePreKeys` ではなく、
  `oneTimePreKey: { id: number, publicKey: string }` のような
  **id 付きのオブジェクト**（または `preKeyId` フィールド）を含める
- igna送信時に、使用した prekey を該当ユーザーから削除する

---

## 5. その他のエンドポイント

### `GET /api/devices`

自分のデバイス一覧。`POST /api/devices` と同じ要素の配列を返す。

### `DELETE /api/devices/:deviceId`

自分のデバイスのみ削除可能であること。他人のデバイスは 403/404 を返す。

### `GET /api/devices/user/:userId`

他ユーザーのデバイス一覧。**公開鍵のみ**（秘密鍵は絶対に含めない）。

### `GET /api/users/me`

認証済みユーザーのプロフィール。

### `GET /api/users/:username`

公開ユーザープロフィール。**`publicKey`（ed25519 公開鍵・hex 64 文字）を含むこと。**

```json
{
  "id": "uuid",
  "username": "alice",
  "displayName": "Alice",
  "publicKey": "<hex: 64 chars>"
}
```

Prepito は受信 DM の ed25519 署名を検証するために、この公開鍵を必要とする。
現状のサーバは `publicKey` を返さないため、クライアントは
**Double Ratchet の MAC による真正性検証にフォールバック**する
（`src/services/dm.ts` の `receiveDM` 参照）。

`publicKey` が返るようサーバを修正すれば、クライアント側の
署名検証が有効になる。サーバ側は ed25519 公開鍵のみを公開し、
秘密鍵は絶対に含めないこと。

### `POST /api/users/me/push-token`

```json
{ "expoPushToken": "ExponentPushToken[...]", "deviceId": "<server device id>" }
```

`deviceId` は `POST /api/devices` で発行された ID。
これを指定することで、サーバは
- 正しいデバイスへ通知を配信できる
- 通知 payload に送信者のデバイス ID を含められる（複数端末での E2E 配送に必要）

### `POST /api/auth/refresh`

```json
{ "refreshToken": "<token>" }
```

→ `{ "token": "<new access token>", "refreshToken": "<new refresh token>" }`

---

## 6. WebSocket

Prepito は `/ws?token=<jwt>` に接続し、`{ type, payload }` のエンベロープで
メッセージを受信する。

| type | 用途 |
|------|------|
| `dm_received` | 受信 DM |
| `dm_sent` | 送信 DM の確定 |
| `dm_read` |  既読通知 |
| `typing_start` / `typing_stop` | 入力中Indicator |
| `key_bundle_request` / `key_bundle_response` | デバイス間鍵配送 |

### `dm_received` の payload

```json
{
  "id": "uuid",
  "from": { "id": "uuid", "username": "alice" },
  "to": { "id": "uuid", "username": "bob" },
  "content": "<ciphertext>",
  "signature": "<hex: 128 chars>",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`signature` は ed25519 署名で、**hex** 形式。

---

## 7. 認証フロー（クライアント実装）

```
1. POST /api/auth/register { username, publicKey(hex) }
   → { token, userId }

2. POST /api/auth/login { username, signature(hex) }
   challenge = "koshi:login:" + username.trim().toLowerCase()
   signature = ed25519_sign(challenge, secretKey)
   → { token, userId }

3. POST /api/devices { ... }
4. GET /api/keys/bundle/:userId?deviceId=<id>
```

ユーザー名はサーバ側で `trim().toLowerCase()` される。
クライアントも同じ正規化を行い、`koshi:login:{username}` の
チャレンジ文字列を一致させること（大文字小文字の不一致は 401 になる）。
