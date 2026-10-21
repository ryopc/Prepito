# koshi v5 実装プロンプト（Signal Protocol E2E 対応サーバ）

> **このファイルは他 AI エージェントへ渡す実装プロンプトです。**
> 「プロンプト」節の内容をそのまま渡してください。

---

## プロンプト

あなたは **koshi**（ターミナルネイティブ P2P 分散 SNS）のサーバ側開発者です。
`koshi` に **Signal Protocol（X3DH + Double Ratchet）による E2E 暗号化通信を
成立させるためのサーバ API** を実装してください。

クライアント（React Native アプリ **Prepito**）が実サーバに対して
E2E 暗号化 DM を送受信できる状態になるまでeness、それが完了条件です。

### 0. 前提情報

| 項目 | 値 |
|------|-----|
| リポジトリ | `~/projects/koshi`（`ryopc/koshi`） |
| 実装対象 | **ローカル完結サーバ `src/local/server-standalone.js`**（SQLite + Express + ws） |
| 参考実装 | Postgres 版 `src/api/devices.js` / `src/api/keys.js`（=device/keys は既にある。**Postgres 版の設計・命名・レスポンス形状に Levyすること**） |
| ランタイム | Node.js / ESM（`"type": "module"`） |
| 主な依存 | `express@4` / `ws` / `better-sqlite3` / `tweetnacl`（ed25519 検証）/ `jsonwebtoken` 相当の自作 HMAC-SHA256 JWT |
| ライセンス | MIT（変更不可） |
| 現在のバージョン | `4.0.0` → **実装後は `5.0.0` に上げる** こと（破壊的変更のため） |

### 1. 現状（実装済みの範囲）

`src/local/server-standalone.js` に以下は**既に実装済み**。壊さないこと。

- `POST /api/auth/register`（`publicKey` は **hex** 64 文字を検証）
- `POST /api/auth/login`（ed25519 チャレンジ応答、チャレンジ文字列は `koshi:login:{username}`）
- `GET /api/users/search/:query` / `GET /api/users/:username` / `PUT /api/users/me` / `DELETE /api/users/me`
- `POST|DELETE /api/users/:id/follow`
- `GET /api/posts/feed` / `POST /api/posts` / `GET /api/posts/:id`
- `GET /api/dms` / `GET /api/dms/unread/count` / `POST /api/dms/:userId` / `PUT /api/dms/:id/read`
- `GET /api/health` / `GET /api/config`
- WebSocket `/ws?token=<jwt>`（`connected` / `post_created` / `dm_received` / `pong`）

JWT は `signToken({ userId, username })` で、`requireAuth` が
`req.user = { userId, username }` を設定する。**既存のトークン形式を壊さないこと。**

### 1-1. 公開サーバでの実測（2026-10-21 / Prepito 開発者による検証）

公開サーバ `https://koshi.ryopc.org` は **Render.com 上に Postgres 版
（`bin/server.js`）をデプロイ**したインスタンスであり、**コミット済みの HEAD**
（= v5 実装前の状態）が動作している。以下は実測結果。

| 検証 | 結果 | 判定 |
|------|------|------|
| `GET /api/health` | 200 `{"status":"ok"}` | ✅ 動作 |
| `POST /api/auth/register`（hex publicKey） | **201** | ✅ 動作 |
| `POST /api/auth/login`（hex signature） | **200** | ✅ 動作 |
| `GET /api/users/search/:query` | 200（配列） | ✅ 動作 |
| `GET /api/posts/feed` | 200（配列） | ✅ 動作 |
| `GET /api/keys/bundle/:userId` | 400 `Cannot request key bundle for yourself.` | ✅ 実装済み（自己参照の拒否も正常動作） |
| WebSocket `wss://koshi.ryopc.org/ws?token=<jwt>` | **101 Switching Protocols** → `{"type":"user_online",...}` | ✅ 動作 |
| `GET /api/users/me` | **404** `User not found` | ❌ **未実装**（2-7 対応対象） |
| `POST /api/devices` | **500** `Internal server error` | ❌ **壊れている**（2-1 対応対象） |
| `GET /api/config` | 404 | ⚠️ Postgres 版には存在しない（クライアントは未使用） |

**重要な含意**:

1. `GET /api/users/me` の 404 と `POST /api/devices` の 500 は、
   **ローカル作業ツリー（未コミットの v5 実装）には既に修正计入されている**が、
   コミット &\ push されていないため**公開サーバには反映されていない**
2. したがって本プロンプトの作業は、**未コミットの差分を整理してコミット &\ push**し、
   **Render の自動デプロイを待つ**ことで公開サーバに反映される
3. `POST /api/devices` の 500 は原因が DB スキーマ（`one_time_pre_keys` の JSONB 化）
   と実装の不整合である可能性が高い。**既存 DB に対するマイグレーション**が
   必要になる可能性がある点に注意すること

### 2. 実装が必要なエンドポイント（10 項目）

> **重要**: レスポンスのキー名・型は**クライアントが固定で前提としている**。
> クライアント側の定義は `packages/app/src/services/api.ts` にあり、
> レスポンス形状が一致しないとクライアントは正しく動かない。

---

#### 2-1. `POST /api/devices`（デバイス登録・X3DH 鍵）

**リクエスト**

```json
{
  "deviceName": "Pixel 8",
  "identityKey": "<base64: 33 bytes>",
  "signedPreKey": "<base64: 33 bytes>",
  "preKeySignature": "<base64: 64 bytes>",
  "oneTimePreKeys": ["<base64: 33 bytes>", "..."]
}
```

**レスポンス（201）** — クライアントは `result.id` を「サーバ発行デバイス ID」として保存する

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

- `id` は **数値文字列**（`"3"`）で返すこと。クライアントは文字列として扱う。
- `oneTimePreKeys` は **base64**（hex ではない）。
- `oneTimePreKeys` は 1〜100 個。0 個や 100 超は 400。
- 各鍵は base64 形式であるべき（`/^[A-Za-z0-9+/]+={0,2}$/`）。

---

#### 2-2. `GET /api/devices`（自分のデバイス一覧）

**レスポンス（200）**: 2-1 と同じオブジェクトの配列（降順 `created_at`）。

---

#### 2-3. `DELETE /api/devices/:deviceId`（デバイス削除）

- 本人のデバイスのみ削除可能。他人の deviceId は **404**（403 ではない）。
- **成功時 200** `{"success": true}`（`404` ではない）。
- 存在しない deviceId は 404 `{"error": "Device not found."}`。

---

#### 2-4. `GET /api/devices/user/:userId`（他ユーザーのデバイス取得）

**レスポンス（200）**: 2-1 と同じオブジェクトの配列。

- **秘密鍵は絶対に含めない**（このサーバは公開鍵しか扱わないため問題なし）。
- 対象ユーザーが存在しない場合は 404。

---

#### 2-5. `GET /api/keys/bundle/:userId`（PreKey Bundle 取得）★最重要★

X3DH 鍵交換の要。**これが無ければ暗号化メッセージの送信は原理的に成立しない。**

**クエリ**: `deviceId`（任意。相手端末を絞る場合）

**レスポンス（200）** — クライアントは `bundle.oneTimePreKeys[0]` を使う

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

- `deviceId` クエリ指定時: そのデバイスのバンドルを返す。
- 未指定時: 対象ユーザーの**最新の**デバイス 1 台から返す。
- 対象ユーザーまたはデバイスに**未使用の one-time prekey が 1 つも無い場合は 404**
  `{"error": "No prekeys available"}`。
  - 理由: クライアントは 404 時に「セッション確立失敗」を表示する。
    空配列を返すとクライアントが `oneTimePreKeys[0]` で `undefined` になり
    原因究明不能なエラーになる。**明示的に 404 にすること。**
- `preKeySignature` は **XEdDSA**（ed25519 ではない）署名。
  仕様: <https://signal.org/docs/specifications/xeddsa/>
  - サーバ側で検証可能な範囲のみ検証し、**OpenSSL の ed25519 で検証しないこと**
    （XEdDSA は Edwards 群→Montgomery 変換を伴うため ed25519 と互換ではない）。
  - 検証できない場合は「検証をスキップし 200 を返す」実装でもよいが、
    少なくとも `preKeySignature` が base64 であることの形式検証は行え。

---

#### 2-6. `POST /api/auth/refresh`（アクセストークン更新）

**リクエスト**: `{"refreshToken": "<token>"}`

**レスポンス（200）**:

```json
{ "token": "<new access token>", "refreshToken": "<new refresh token>" }
```

- 現在の `signToken` は `iat` のみで期限がない。**refresh token の実装に合わせて
  トークンに `exp` / `type` を持たせる変更が必要。**
- 既存 access token（`type` なしの JWT）は**引き続き有効**であること
  （既存クライアントを壊さない）。
- refresh token は `type: 'refresh'` を付与し、access token での使用を拒否する。
- 期限切れ・不正な refresh token は **401** `{"error": "Invalid refresh token"}`。

---

#### 2-7. `GET /api/users/me`（自分のプロフィール）

**レスポンス（200）**:

```json
{
  "id": "uuid",
  "username": "alice",
  "displayName": "Alice",
  "bio": "...",
  "avatarUrl": "...",
  "publicKey": "<hex: 64 chars>",
  "followersCount": 0,
  "followingCount": 0,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

---

#### 2-8. `POST|DELETE /api/users/me/push-token`（プッシュトークン登録・削除）

**POST リクエスト**:

```json
{ "expoPushToken": "ExponentPushToken[xxx]", "deviceId": "3" }
```

- `deviceId` は 2-1 で発行された ID（省略可）。
- 同じ `expoPushToken` は**上書き**（同一ユーザーで 1 件）。

**レスポンス（200）**: `{"success": true}`

**DELETE**: 自分のトークンを削除 → `{"success": true}`

---

#### 2-9. `GET /api/users/:username` の**追加対応**（既存エンドポイントの拡張）

既存のプロフィールレスポンスに **`publicKey`（hex 64 文字）を追加**すること。

```json
{
  "id": "uuid",
  "username": "alice",
  "displayName": "Alice",
  "bio": "...",
  "avatarUrl": "...",
  "publicKey": "<hex: 64 chars>",
  "followersCount": 0,
  "followingCount": 0,
  "createdAt": "..."
}
```

> **理由**: クライアントは受信 DM の ed25519 署名を検証するために
> 送信者の公開鍵を必要とする。現状この値が無いため、クライアントは
> 署名検証をスキップしている（`src/services/dm.ts` の `receiveDM`）。
> この値が返るようになればクライアント側の検証が有効になる。
> **秘密鍵は絶対に返さないこと。**

---

#### 2-10. `POST /api/auth/logout`（ログアウト）

- クライアントは best-effort で呼ぶため **404 でもよい**が、実装 preferable。
- 実装する場合: 該当 refresh token を失効登记表に追加し `{"success": true}`。
- access token の即時失効は行わない（ステートレス JWT のため）。

### 3. データモデル（SQLite）

`src/local/server-standalone.js` の `db.exec(...)` に以下を追加すること。
**既存の `CREATE TABLE IF NOT EXISTS` 群に並べて追加**し、起動時の
自動マイグレーションで作成されるようにすること（`PRAGMA user_version` の
管理は不要でよい。`IF NOT EXISTS` のみでも可）。

```sql
-- X3DH デバイス（ユーザー単位に複数）
CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT,
    identity_key TEXT NOT NULL,
    signed_pre_key TEXT NOT NULL,
    pre_key_signature TEXT NOT NULL,
    one_time_pre_keys TEXT NOT NULL DEFAULT '[]',   -- JSON 配列（base64 文字列の配列）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- プッシュ通知トークン
CREATE TABLE IF NOT EXISTS push_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT,
    expo_push_token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'android',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, expo_push_token)
);

-- リフレッシュトークン（失効管理）
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
```

- `one_time_pre_keys` は **JSON 文字列**として保存する。
  要素は `{ id: number, publicKey: string }` のオブジェクト配列を推奨
  （2-12 参照。preKey の id が必要）。
- デバイス削除時は `push_tokens.device_id` も整合的に削除すること。

### 4. エンコーディング規約（**混同すると致命**）

| 対象 | 形式 | 長さ | 根拠 |
|------|------|------|------|
| `/api/auth/register` の `publicKey` | **hex** | 64 文字 | `/^[0-9a-f]{64}$/i` で検証済み |
| `/api/auth/login` の `signature` | **hex** | 128 文字 | `hexToBytes()` でデコード |
| `identityKey` / `signedPreKey` / `oneTimePreKeys` | **base64** | 44 文字 | 33 バイト（`0x05` + 32 バイト）のシリアライズ結果 |
| `preKeySignature` | **base64** | 88 文字 | XEdDSA 署名 64 バイト |

> **base64 で `publicKey` を送ると 400 `"Invalid public key format"`。**
> **hex でデバイス鍵を送るとクライアント側でデコードに失敗しセッション確立が失敗する。**
> 逆も同様。**新規コードを書く際は必ず上の表を参照すること。**

### 5. WebSocket の拡張

既存の `broadcast(event, payload, targetUserId)` はそのまま使う。

| type | 用途 | payload |
|------|------|---------|
| `dm_received` | 受信 DM（**既存**） | `{ id, from: { id, username }, content, signature, timestamp }` |
| `dm_sent` | 送信 DM の確定 | `{ id, to: { id, username }, content, signature, timestamp }` |
| `dm_read` | 既読通知 | `{ id, by: { id, username } }` |
| `typing_start` / `typing_stop` | 入力中インジケータ | `{ conversationId }` |

- `dm_received` は現状 `POST /api/dms/:userId` から `broadcast` されている ✓。
- `dm_received` の payload に **`timestamp`** を追加すること
  （クライアントは `createdAt` にマッピングする）。
  現在の `formatDM` の `createdAt` と同じ値を入れる。
- `dm_sent` / `dm_read` / `typing_*` は、
  それぞれ `POST /api/dms/:userId`（送信者向け）/
  `PUT /api/dms/:id/read`（送信者向け）/
  WebSocket 受信メッセージ（`{ type: 'typing_start', payload: { conversationId } }`）で
  送信する。
- 送信者向けの broadcast は `targetUserId` に送信者の `userId` を渡す。

### 6. `preKeyId` の取り扱い（推奨改善）

現状クライアントは `bundle.oneTimePreKeys[0]` を使い preKey id を `0` 固定で
通知するため、受信側で「MAC 検証が通るまで未使用 prekey を順に試す」
フォールバックが必要になっている。

サーバ側で以下を実装すると、この回避が不要になる:

1. `one_time_pre_keys` を `{ id, publicKey }` の JSON 配列で保持する
2. `GET /api/keys/bundle/:userId` の `bundle` に
   `oneTimePreKeys: string[]`（**既存キー名・既存形式を維持**）と
   並行して `preKeyId: number`（使用した prekey の id）を含める
3. クライアントが prekey id を通知できるよう、DM 送信 API が
   任意で `preKeyId` を受け取れるようにする

> **後方互換を最優先すること。** 既存クライアントは
> `bundle.oneTimePreKeys[0]` を読むため、このキーは消さない。

### 7. 受け入れ基準

**すべて satisfied すること。** 実装後、以下の手順で**実測**すること
（推測で「動きました」と言わないこと）。

```bash
# 0) サーバ起動
cd ~/projects/koshi && PORT=3000 node src/local/server-standalone.js
# 別ターミナルで:

# 1) 登録（publicKey は hex 64 文字）
curl -s -X POST localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","publicKey":"'$(printf 'a%.0s' {1..64})'"}'
# → 201 {"userId":"...","token":"..."}

# 2) デバイス登録（鍵は base64）
curl -s -X POST localhost:3000/api/devices \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"deviceName":"Pixel 8","identityKey":"<base64 33B>","signedPreKey":"<base64 33B>","preKeySignature":"<base64 64B>","oneTimePreKeys":["<base64 33B>"]}'
# → 201 {"id":"1",...}

# 3) 鍵バンドル取得（相手の userId）
curl -s "localhost:3000/api/keys/bundle/$OTHER_USER_ID" -H "Authorization: Bearer $TOKEN"
# → 200 {"userId":"...","deviceId":"1","bundle":{...}}
# 相手の one-time prekey を 0 個にした状態では → 404 {"error":"No prekeys available"}

# 4) プロフィールに publicKey が含まれること
curl -s localhost:3000/api/users/alice | grep -q publicKey && echo OK

# 5) GET /api/users/me が 200 で publicKey を含むこと
curl -s localhost:3000/api/users/me -H "Authorization: Bearer $TOKEN"

# 6) refresh が新しい token を返すこと
curl -s -X POST localhost:3000/api/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"'"$REFRESH"'"}'

# 7) push-token 登録 → 一覧 → 削除
curl -s -X POST localhost:3000/api/users/me/push-token \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"expoPushToken":"ExponentPushToken[test]","deviceId":"1"}'

# 8) 他人のデバイスを削除できないこと（404）
curl -s -X DELETE "localhost:3000/api/devices/$OTHER_DEVICE_ID" -H "Authorization: Bearer $TOKEN"
```

**追加チェック**:

- 既存 API の**退行がない**こと（`/api/auth/login` の ed25519 チャレンジ応答、
  `/api/dms` の送受信、`/api/posts`、`/api/users/*` が従来どおり動作する）
- `node --check src/local/server-standalone.js` が通る
- `npm run lint`（`eslint . --ext .js`）で **error 0 件**
- サーバ起動時に **エラー・警告なく**ログが出ること（SQL の構文エラー多有注意）

### 7-1. 公開サーバへの反映確認（デプロイ後）

ローカル検証.maps、**コミット &\ push 後に公開サーバでも同じ受け入れ基準を確認する**こと
（Render の自動デプロイ完了を待つ。反映されない場合は手動で
`https://koshi.ryopc.org` に対して再確認する）。

```bash
BASE=https://koshi.ryopc.org

# 1) 登録（publicKey は hex 64 文字）
curl -s -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"alice","publicKey":"'$(printf 'a%.0s' {1..64})'"}'
# → 201 {"userId":"...","token":"..."}

# 2) デバイス登録（鍵は base64）→ 公開サーバは現状 500 になるはず
curl -s -X POST "$BASE/api/devices" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"deviceName":"Pixel 8","identityKey":"<base64 33B>","signedPreKey":"<base64 33B>","preKeySignature":"<base64 64B>","oneTimePreKeys":["<base64 33B>"]}'
# → 201 {"id":"...",...} （デプロイ前なら 500）

# 3) GET /api/users/me → 公開サーバは現状 404 になるはず
curl -s "$BASE/api/users/me" -H "Authorization: Bearer $TOKEN"
# → 200 {...} （デプロイ前なら 404）

# 4) WebSocket 接続（wss）
# node -e で 'wss://koshi.ryopc.org/ws?token=<jwt>' に接続し
# {"type":"user_online",...} を受信できること
```

**合格条件**: 上記 2) と 3) が **200 / 201** を返すこと
（公開サーバで 500 / 404 のままならデプロイが反映されていない）。

### 8. 制約・禁止事項

- **既存の API のレスポンス形状・キー名を変更しない**（既存クライアント互換）。
- **既存の認証方式（ed25519 チャレンジ応答）を変更しない**。
- 秘密鍵・暗号文の復号をサーバで行わない（サーバは E2E の**中継者**に過ぎない）。
  `content` は **暗号文をそのまま**保存・配信すること。
  サーバが復号_funcion を実装しては**ならない**。
- 新しい npm 依存を追加する場合は **MIT ライセンス**のものに限る。
  既存の `tweetnacl` / `node:crypto` で実装可能な範囲で優先すること。
- Postgres 版 `src/api/*` との**整合性を保つ**こと。
  同じ概念のエンドポイントは両方の実装で同じキー名・同じレスポンス形状にすること
  （Postgres 版が既に `devices` / `keys` を持つため、SQLite 版に合わせること）。
- 破壊的変更があるため `package.json` の `version` を **`5.0.0`** に上げる。
- データベースのマイグレーションは**起動時に自動適用**されるようにすること
  （手動 migration コマンドを要求しない）。

### 9. 成果物の報告

完了したら、以下の形式で報告すること。

1. **実装したエンドポイント一覧**（パス・メソッド・ステータスコード）
2. **追加した DB テーブル**（DDL を貼る）
3. **受け入れ基準の実測結果**（上記の curl コマンドの**実際の出力**を貼る。
   実行していない項目は「未実行」と明記すること）
4. **既存 API の退行チェック結果**
5. **lint / 構文チェックの結果**
6. **残した課題**（あれば）

### 10. 参考資料

- Prepito 側のコントラクト（ Implements 済みの設計根拠）:
  `~/projects/Pito/docs/koshi-api-contract.md`
- クライアントの API 定義（レスポンス形状の**正典**）:
  `~/projects/Pito/packages/app/src/services/api.ts`
- Signal Protocol 仕様: <https://signal.org/docs/specifications/>
- XEdDSA 仕様: <https://signal.org/docs/specifications/xeddsa/>

---

## 補足（このプロンプトの前提）

本プロンプトは **Prepito（クライアント）側の実装が完了している**ことを前提とする。
クライアント側は以下を実装済みであり、サーバ側はこれに**正確に合わせる**こと。

- Signal Protocol（X3DH + Double Ratchet + XEdDSA）の**純 TypeScript 実装**
  （`@noble/*` ベース。ネイティブ NAPI に依存しない）
- `libsignal-client` との**双方向相互運用テスト 14/14 PASS**
- 会話状態はクライアント側（SecureStore + SQLCipher）に保持される
- サーバが鍵を受信時に**即座に消費**する one-time prekey の models は、
  クライアント側で「未使用 prekey を順に試す」フォールバックを持つ
  （サーバ側が `preKeyId` を返すことで将来このフォールバックを削減できる）
