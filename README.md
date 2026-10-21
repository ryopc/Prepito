# Prepito

> **koshi platform reference client** — React Native / Expo メッセンジャーアプリ

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.x-orange)](https://pnpm.io/)

Prepito は [koshi](https://github.com/ryopc/koshi) プラットフォーム上で動作する、**参照実装クライアント**です。エンドツーエンド暗号化（Signal Protocol / X3DH + Double Ratchet）、グループチャット、リアルタイムメッセージングを実装したモバイルファーストなメッセンジャーアプリです。

## ✨ Features

- 🔐 **End-to-End Encryption** — Signal Protocol (X3DH + Double Ratchet / Sender Keys)
- 💬 **1:1 Direct Messages** — リアルタイム WebSocket 配信
- 👥 **Group Chats** — メンバー管理、リプライ、メンション
- ✅ **Read Receipts** — 既読表示（1:1 / グループ両対応）
- ⌨️ **Typing Indicators** — 入力中表示
- 📱 **React Native / Expo** — iOS / Android / Web 対応
- 🔑 **Biometric Lock** — Face ID / Touch ID / Biometric でアプリロック
- 🔔 **Push Notifications** — Expo Push (FCM / APNs)
- 💾 **Offline First** — SQLite (SQLCipher) ローカルキャッシュ

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     koshi Platform                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Backend    │  │    CLI      │  │   Shared Library    │  │
│  │  (API/WS)   │  │  (kb cmd)   │  │   (@ryopc/koshi)    │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼─────────────────────┼─────────────┘
          │                │                     │
          └────────────────┴─────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  Prepito    │  ← このリポジトリ
                    │  (Client)   │
                    └─────────────┘
```

## 📦 Monorepo Structure

```
Prepito/
├── package.json                 # Root workspace config
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── .npmrc                       # node-linker=hoisted（Expo ビルドの必須設定）
├── tsconfig.json
├── .prettierrc
├── eslint.config.js             # ESLint flat config（単一の情報源）
├── patches/                     # pnpm patchedDependencies（Gradle 8.x 互換パッチ）
├── packages/
│   ├── shared/                  # @prepito/shared - 共通型定義・ユーティリティ
│   │   ├── src/
│   │   │   └── index.ts         # koshi型の再エクスポート + Prepito固有型
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── app/                     # @prepito/app - Expo / React Native アプリ
│       ├── app/                 # Expo Router (file-based routing)
│       ├── src/
│       │   ├── components/      # 共通UIコンポーネント
│       │   ├── hooks/           # カスタムフック
│       │   ├── services/        # API / Crypto / Storage / Notifications
│       │   ├── store/           # Zustand ストア
│       │   └── utils/           # ユーティリティ
│       ├── assets/              # アイコン、スプラッシュ等
│       ├── plugins/             # Expo config plugin（Gradle バージョン固定）
│       ├── package.json
│       ├── tsconfig.json
│       ├── jest.config.js
│       ├── eas.json
│       └── app.config.ts
└── docker-compose.yml           # 開発用: PostgreSQL + koshi backend
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18（Expo SDK 51 は Node 20 / 22 推奨）
- pnpm >= 9
- [koshi backend](https://github.com/ryopc/koshi) 実行環境 (PostgreSQL + Redis)

> **pnpm の node_modules レイアウト（重要）**
>
> ルートの `.npmrc` で **`node-linker=hoisted`** を指定している。
> **この指定を削除すると Android ビルドが壊れる。**
>
> Expo / React Native のツールチェーンは、プロジェクトルート起点で
> `resolve-from` や `require.resolve(..., { paths: [projectRoot] })` を使って
> パッケージを解決する。pnpm の strict レイアウトでは推移的依存が
> `packages/app/node_modules` に現れないため、以下の2点で失敗する。
>
> | 失敗箇所 | エラー |
> |---|---|
> | `@expo/metro-config` の `getAssetPlugins()`（`expo-asset/tools/hashAssetFiles` を解決） | `The required package 'expo-asset' cannot be found` |
> | Expo が生成する `android/settings.gradle` の `require.resolve('@react-native/gradle-plugin/package.json')`（paths ヒント無し） | Gradle が `Included build '.../android/null' does not exist` で失敗 |
>
> `hoisted` なら workspace ルート直下の `node_modules` に全パッケージが
> フラット配置され、Node の上位探索（`packages/app/node_modules` →
> ルート `node_modules`）が機能するため解消する。
> `@expo/metro-config` のモノレポ自動検出（`getWatchFolders` / `getModulesPaths`）も
> この前提で動作するため、`metro.config.js` の手動設定は不要。
>
> なお `@react-native/gradle-plugin` は `packages/app/package.json` の
> `devDependencies` に明示している（react-native と同一バージョンで、
> 重複インストールは発生しない）。バージョン固定の意図を明文化するためで、
> `hoisted` 化により代替可能になったもの。

> **Gradle 8.x 互換パッチ**
>
> Gradle 8.0 で `Jar.classifier` と `SoftwareComponentContainer.getRelease()` が削除された。
> Expo SDK 51 系の以下の3パッケージはこれらの旧 API を使用しているため、
> Gradle 8.x では次のエラーで必ずビルドが失敗する。
>
> ```
> Could not set unknown property 'classifier' for task ':expo-task-manager:androidSourcesJar'
> Could not get unknown property 'release' for SoftwareComponent container
> ```
>
> | パッケージ | 発生源 | 経緯 |
> |---|---|---|
> | `expo-modules-core@1.12.26` | `android/ExpoModulesCorePlugin.gradle` | 1.12.x の最終版で 8.x 対応版が存在しない |
> | `expo-task-manager@11.0.1` | `android/build.gradle` | 11.8.2 で修正されるが `expo-notifications@0.28.x` の peer 範囲（`~11.0.0`）を逸する |
> | `unimodules-app-loader@4.0.0` | `android/build.gradle` | `expo-task-manager@11.0.1` の推移的依存。4.2.0 で `classifier` 修正、4.6.0 で `components.release` 修正 |
>
> なお **Expo 公式テンプレートは `expo-task-manager` を直接依存しない**ため
> （`expo-template-bare-minimum@51.0.31` の package.json を確認のこと）、
> 潜在していただけであった。本アプリが直接依存したことで顕在化した。
>
> そこでルートの `package.json` の `pnpm.patchedDependencies` で3パッケージを
> **最小差分で patch** している（`patches/` ディレクトリ）。差分は2種類のみ。
> - `classifier = 'sources'` → `archiveClassifier = 'sources'`
> - `from components.release` → `project.components.findByName('release')` でガードし、
>   存在する場合のみ `from` する
>   （AGP 8.x は `release` SoftwareComponent を `components` に登録しないため、
>   無条件の `from` は必ず失敗する。アプリビルドでは publication 内容は不要）
>
> さらに `packages/app/plugins/withGradleVersion.js`（Expo config plugin）が
> prebuild 後に `android/gradle/wrapper/gradle-wrapper.properties` を **Gradle 8.6** に固定する。
> RN 0.74.5 のテンプレートが 8.6 であり、テンプレート dist-tag
> （`expo-template-bare-minimum@sdk-51`）の変動にもビルド結果が影響されなくなる。

### Installation

```bash
# リポジトリクローン
git clone https://github.com/ryopc/Prepito.git
cd Prepito

# 依存関係インストール
pnpm install --recursive

# koshi バックエンド起動 (別ターミナルで)
pnpm dev:koshi

# Expo アプリ起動
pnpm dev:app
```

### Development

```bash
# 型チェック
pnpm typecheck

# Lint
pnpm lint

# テスト
pnpm --filter @prepito/app test

# ビルド (EAS)
pnpm --filter @prepito/app build:ios
pnpm --filter @prepito/app build:android

# libsignal-client との相互運用テスト（実ネイティブ実装との往復）
pnpm --filter @prepito/app test:interop
```

### ⚠️ Expo SDK 51 の依存バージョン固定

`expo-router` は `expo-linking` と `expo-status-bar` を **`*`** で peer 宣言する。
このため pnpm は最新版（SDK 54 向け）を解決し、`expo@51` と非互換になる。

| パッケージ | 固定バージョン | 解決되는と何が起きるか |
|-----------|---------------|------------------------|
| `expo-linking` | `~6.3.1` | `expo/internal/bundle-origin` を import し、Metro が解決に失敗する |
| `expo-status-bar` | `~1.12.1` | 同上（Expo SDK 54 専用 API を参照） |

**`packages/app/package.json` の `dependencies` に直接宣言して固定している。**
`pnpm.overrides` では auto-install される peer には効かない点に注意。

> `pnpm-lock.yaml` を再生成すると、この 2 つの解決版が巻き戻るため、
> ビルド失敗時は上記の直接宣言が残っているか確認する。

### 🔔 通知（Notifications）

`src/services/notifications.ts` は 2 つの責務を分離している。

| 種別 | 有効条件 | 用途 |
|------|---------|------|
| **ローカル通知** | 常時有効 | 受信 DM の復号 → ストア反映 → 通知表示。F-Droid ビルドでも動作する |
| **リモートプッシュ** | `extra.enablePushNotifications` | Expo Push トークン取得・サーバ登録。F-Droid ビルドでは `EXPO_PUBLIC_ENABLE_PUSH=false` |

設計上の制約:

- **通知本文に暗号文（ciphertext）を表示しない。** 復号できない場合は
  送信者名と定型文のみを表示する（ロック画面の preview での平文露出を防ぐ）
- WebSocket とプッシュ通知の双方から `handleIncomingDM()` を呼び、
  単一の入口で「復号 → ストア反映 → 通知表示」を行う
- ストア側で ID による重複排除を行い、二重登録を防ぐ
- プッシュトークンはサーバ発行デバイス ID と紐づけて登録する
  （`POST /api/users/me/push-token` の `deviceId`）

## 📱 App Structure (Expo Router)

```
app/
├── (auth)/
│   ├── login.tsx
│   ├── register.tsx
│   └── device-setup.tsx      # E2E初期鍵生成
├── (app)/
│   ├── _layout.tsx           # タブバー + 認証ガード
│   ├── chats/
│   │   ├── index.tsx         # チャット一覧
│   │   ├── [id].tsx          # チャット画面 (DM/Group共通)
│   │   └── new.tsx           # 新規チャット作成
│   ├── contacts/
│   │   ├── index.tsx         # 連絡先一覧
│   │   └── [id].tsx          # プロフィール詳細
│   └── settings/
│       ├── index.tsx
│       ├── security.tsx      # E2E設定・デバイス管理
│       └── notifications.tsx
```

## 🔐 E2E Encryption

| Layer | Implementation |
|-------|---------------|
| **1:1** | X3DH (Key Agreement) + Double Ratchet |
| **Group** | Sender Keys — 未実装（`group messaging is not supported` を送出） |
| **Key Storage** | Expo SecureStore (iOS Keychain / Android Keystore) + SQLCipher |
| **Library** | 純 TypeScript 実装（`@noble/curves` / `@noble/hashes` / `@noble/ciphers`） |

### なぜ純 TypeScript なのか

`@signalapp/libsignal-client` は Node.js 専用の NAPI モジュールであり、
React Native / Metro では解決できない（`Unable to resolve module crypto`）。
また Emscripten ベースの実装は Hermes が WebAssembly 非対応のため利用できない。

そのため Signal Protocol（X3DH + Double Ratchet + XEdDSA）を**自前実装**している。

| 項目 | 内容 |
|------|------|
| 暗号曲線 | X25519（`@noble/curves`）+ Edwards 群演算（自前） |
| 鍵導出 | HKDF-SHA256 / HMAC-SHA256（`@noble/hashes`） |
| 暗号化 | AES-256-CBC（`@noble/ciphers`） |
| 署名 | XEdDSA（自前、Signal 仕様準拠） |
| 乱数 | `expo-crypto`（ネイティブ CSPRNG） |

Hermes には `TextEncoder` / `atob` / `crypto` グローバルが存在しないため、
エンコーディングと UTF-8 は `src/services/crypto/bytes.ts` で自前実装し、
Node core（`fs` / `path` / `crypto` / `Buffer`）には依存しない。

### 検証

- `pnpm --filter @prepito/app test` — 69 テスト
  （X25519 / XEdDSA / AES-256-CBC / ChainKey / protobuf / UTF-8 の
  libsignal 公式テストベクタ・NIST SP 800-38A に基づく）
- `pnpm --filter @prepito/app test:interop` — 実 `libsignal-client` との
  **双方向**相互運用テスト（14/14 PASS）

> **Note**: libsignal-client は相互運用テスト専用に `devDependencies` へ置いている。
> アプリ本体のバンドルには含まれない（Metro の解決対象から外れる）。

## 📡 Platform API (koshi)

Prepito は koshi の以下の API を使用します：

| Category | Endpoints | koshi 4.0.0 |
|----------|-----------|--------------|
| **Auth** | `POST /api/auth/register`, `POST /api/auth/login` | ✅ 実装済み |
| **Auth** | `POST /api/auth/refresh`, `POST /api/auth/logout` | ⚠️ 未実装 |
| **Users** | `GET /api/users/search/:query`, `GET /api/users/:username`, `PUT /api/users/me` | ✅ 実装済み |
| **Users** | `GET /api/users/me`, `POST/DELETE /api/users/me/push-token` | ⚠️ 未実装 |
| **DM** | `GET /api/dms`, `POST /api/dms/:userId`, `PUT /api/dms/:id/read`, `GET /api/dms/unread/count` | ✅ 実装済み |
| **E2E Keys** | `GET/POST /api/devices`, `GET /api/keys/bundle/:userId` | ⚠️ 未実装 |
| **Groups** | `GET/POST /api/groups`, `GET/POST /api/groups/:id/messages` | ⚠️ 未実装（クライアントも未使用） |
| **WebSocket** | `/ws?token=<jwt>` — `dm_received`, `typing_start/stop` | ✅ 実装済み |

> ⚠️ **サーバ側の前提について**
>
> 発行済みの `@ryopc/koshi@4.0.0`（および `ryopc/koshi` の `main` ブランチ）には、
> 上の ⚠️ のエンドポイントが**まだ存在しません**。
> そのため現状、Prepito は以下の機能を含む完全動作を確認できません。
>
> - デバイス登録（`POST /api/devices`）— 登録後のデバイスセットアップが 404 になる
> - X3DH 鍵交換（`GET /api/keys/bundle/:userId`）— 相手への暗号化が成立しない
> - アクセストークン更新（`POST /api/auth/refresh`）— トークン失効時に再ログインが必要
>
> **完全動作を確認するには、上記エンドポイントを含む koshi サーバが必要です。**
> サーバ側の実装が完了するまで、Prepito を F-Droid へ掲載する場合は
> 掲載説明にこの制約を明記してください（F-Droid の審査基準
> 「説明どおりの機能か」の観点で重要）。

### 暗号のエンコーディング規約

Prepito と koshi の間では、公開鍵・署名・秘密鍵をすべて **hex** で受け渡します
（koshi は公開鍵を `/^[0-9a-f]{64}$/i` で検証し、署名を `hexToBytes()` で
デコードします）。base64 で送信すると登録が 400、ログインが 401 になります。

詳細: [koshi API Reference](https://koshi.js.org/api) / `src/types/index.ts` の `WSEventMap`

### サーバ実装の引き渡しドキュメント

Prepito が要求する koshi v5 の API 仕様（リクエスト / レスポンスの形式、
エンドポイントごとの実装状況、暗号の hex 規約、WebSocket payload）は
以下のドキュメントに集約している。サーバ側の実装はこれを参照すること。

**→ [`docs/koshi-api-contract.md`](docs/koshi-api-contract.md)**

サーバ実装を**他 AI エージェントに委譲するためのプロンプト**も用意している。

**→ [`docs/koshi-v5-implementation-prompt.md`](docs/koshi-v5-implementation-prompt.md)**

特に次の 2 点が未実装で、Prepito 側のフォールバックが必要になっている。

| 項目 | 現状 | 影響 |
|------|------|------|
| `GET /api/users/:username` の `publicKey` | 返さない | 受信 DM の ed25519 署名検証をスキップ（Double Ratchet の MAC で担保） |
| `GET /api/users/me` | 未実装 | プロフィール取得に失敗（メッセージ受信自体は継続） |

## 🚀 CI/CD

GitHub Actions が型チェック → Lint → テスト → ビルド → リリース公開までを実行する。

| Job | トリガー | 内容 |
|-----|---------|------|
| `typecheck` / `lint` / `test` | push / PR | 品質ゲート |
| `build-app` | push / PR | `eas build --local` で APK 検証（Artifacts に保存） |
| `fdroid-build` | push / PR | F-Droid レシピで APK をビルドし、Firebase / GMS 非包含と versionCode 一致を検証 |
| `release` | tag push (`v*`) | APK をビルドして GitHub Release に添付 |

### EXPO_TOKEN 未設定時の挙動

`build-app` ジョブは EAS サーバーに接続する必要があるため、`EXPO_TOKEN` が
未設定だと `An Expo user account is required to proceed.` で失敗する。
Secret を登録していないリポジトリでも品質ゲートを成立させるため、
トークンの有無を判定し、**未設定時は Gradle 直接ビルドへフォールバック**する。

| 状態 | 実行経路 | 生成される APK |
|------|---------|---------------|
| `EXPO_TOKEN` あり | `eas build --local`（`eas.json` の profile を適用） | `app-release.apk` |
| `EXPO_TOKEN` なし | `expo prebuild` → `./gradlew assembleRelease` | `app-release.apk`（debug 署名） |

F-Droid 公開の本命は `fdroid-build` ジョブであり、こちらは
`EXPO_TOKEN` に依存せず常に同じ経路（署名除去 → `app-release-unsigned.apk`）で通る。

> **注意**: `expo prebuild` が生成する `app/build.gradle` には
> `release { signingConfig signingConfigs.debug }` が含まれるため、
> 署名を除去しないビルドの出力は `app-release.apk`（debug 署名）になる。
> `app-release-unsigned.apk` は署名を除去した場合だけのファイル名。

### F-Droid 検証の厳格さ

`fdroid-build` ジョブの NonFree チェックは、`fdroid/check-nonfree.py` で
Gradle の依存グラフ（`releaseRuntimeClasspath`）を走査する。

- 依存グラフの取得には **Gradle ラッパー (`./gradlew`)** を使う。
  システム `gradle` はバージョンがプロジェクト（Gradle 8.6 固定）と不一致で失敗し、
  出力が空になると判定が常に成功してしまう（空振り）
- 依存グラフに `releaseRuntimeClasspath` が含まれない場合は **ジョブを失敗**させる
- `aapt` が利用可能な場合は `package` 名と `versionCode` も検証する

### ビルド方式

ビルドは **EAS ローカルビルド** (`eas build --local`) を採用している。
EAS サーバーに接続するのはプロジェクト存在の確認のみで、ビルド本体は
GitHub Actions のランナー上で実行されるため、**EAS のビルド時間を消費しない**
（フリーティア枠の枯渇を回避）。

- ビルド出力の指定は `--output`（`--local` 専用フラグ。cwd 相対で解決されるため絶対パスを渡す）
- Android のみ対応（iOS のローカルビルドは macOS + Xcode が必要なため）
- ランナーの既定 NDK は 27/29/30 で、プロジェクトが要求する `26.1.10909125`
  と不一致なため CI で `sdkmanager` により明示導入している
- `eas-cli` は `25.2.0` に pin している（ローカルビルドプラグインのバージョンを
  `@expo/eas-build-job` から導出するため、eas-cli の内部構成が変わると導出が壊れるため）
- Gradle 8.x 互換パッチ（`pnpm.patchedDependencies`）を適用している。
  `pnpm install` が patch を適用するため、CI でもローカルでも同じ状態になる
  （詳細は Prerequisites の「Gradle 8.x 互換パッチ」を参照）
- ローカルビルドプラグインは `EAS_LOCAL_BUILD_PLUGIN_PATH` で事前導入したものを使用する。
  `dtrace-provider`（bunyan の optional 依存）はネイティブビルドが失敗すると
  `dtrace-provider.js` が 0 バイトになり、プラグインが
  `dtrace.createDTraceProvider is not a function` で `TypeError` する。
  除去すれば bunyan は既定実装へフォールバックするため、OS やツールチェーンに依存しない

リリース時に EAS クラウドビルドを使いたい場合は、`workflow_dispatch` の
`build_mode` 入力に `cloud` を指定する。

### ローカルでのビルド（検証用）

CI と同じ手順をローカルで再現する場合：

```bash
# 依存ツール (Homebrew)
brew install openjdk@17
brew install --cask android-commandlinetools
brew install --cask eas-cli
nvm install 22 && nvm use 22     # Node 20 / 22 推奨 (CI は Node 20 固定)

# 環境変数 (~/.zshrc)
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# SDK パッケージ (プロジェクトが要求する NDK バージョンを合わせる)
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;26.1.10909125"

# ローカルビルドプラグインを事前導入し dtrace-provider を除去する
# (macOS ではネイティブビルドが失敗して dtrace-provider.js が壊れるため)
PLUGIN_VERSION=$(node -p "require('$(npm root -g)/eas-cli/node_modules/@expo/eas-build-job/package.json').version")
PLUGIN_DIR="$HOME/.cache/eas-local-build-plugin"
mkdir -p "$PLUGIN_DIR" && cd "$PLUGIN_DIR" && npm init -y > /dev/null
npm install --no-save "eas-cli-local-build-plugin@$PLUGIN_VERSION"
find "$PLUGIN_DIR/node_modules" -type d -name 'dtrace-provider' -prune -exec rm -rf {} + 2>/dev/null || true
export EAS_LOCAL_BUILD_PLUGIN_PATH="$PLUGIN_DIR/node_modules/eas-cli-local-build-plugin/bin/run"

# ビルド
cd packages/app
eas login
eas build --local --platform android --profile preview --non-interactive --output ./out/prepito.apk
```

### 必要な Secret

| Secret | 取得元 | 用途 |
|--------|--------|------|
| `EXPO_TOKEN` | [expo.dev/settings/access-tokens](https://expo.dev/settings/access-tokens) で生成 | EAS CLI の認証（`eas login` は不要） |
| `GITHUB_TOKEN` | GitHub が自動発行 | Release 作成 |
| `NPM_TOKEN` | npmjs.com → Access Tokens | `@prepito/shared` の publish |

### 初回セットアップ（1回のみ）

EAS プロジェクトとのリンクが必要（未設定だと `eas build` が
`EAS project not configured` で失敗する）。

```bash
cd packages/app
EXPO_TOKEN=<トークン> eas init --force --non-interactive
# 表示された projectId を app.config.ts の extra.eas.projectId に設定
# （EXPO_PUBLIC_EAS_PROJECT_ID 環境変数でも可）
```

### リリース作成

`app.config.ts` の `version` と `android.versionCode` を更新してから tag を push する。

```bash
# packages/app/app.config.ts の version / android.versionCode を更新
git tag v1.0.0 && git push origin v1.0.0
```

> **versionCode は単一情報源に集約している。**
> `eas.json` の `cli.appVersionSource` は `"local"`（既定の `"remote"` ではない）。
> EAS の自動採番は F-Droid ビルドでは参照されないうえ、
> F-Droid は「APK の versionCode と metadata の versionCode が一致すること」を
>  要求するため、EAS / GitHub Release / F-Droid で同じ値を使う必要がある。

## 📦 F-Droid 掲載

F-Droid への掲載は、GitHub への公開と同じソースから再現可能な形でビルドできる。
**EAS とは独立した経路**であり、Google Play Services / Firebase を含まない
ビルドを F-Droid 用に生成する。

### 対応済みの F-Droid 要件

| 要件 | 対応 |
|------|------|
| ライセンス | MIT（F-Droid 受理可能） |
| `google-services.json` / 秘密鍵 | リポジトリに一切含めない |
| Google Play Services / Firebase | `expo-notifications` の Firebase 依存を F-Droid ビルド時のみ除去し、公式の `firebase-stub` srclib で代替 |
| トラッキング / 解析 SDK | 含まれない（トラッキング・解析・広告 SDK いずれも 0 件） |
| ネイティブバイナリ | 含まれない。Signal Protocol は `@noble/*` による純 TypeScript 実装（X25519 / SHA-2 / AES-CBC / XEdDSA）で、`@signalapp/libsignal-client` 等のネイティブ NAPI モジュールに依存しない |
| OTA による動的コード取得 | `expo-updates` を使用しない |
| `versionCode` | `app.config.ts` の `android.versionCode` にリテラル固定（F-Droid は APK と metadata の不一致でビルドを失敗させる） |
| 署名 | F-Droid 側の鍵で署名するため `signingConfig` は除去 |
| メタデータ | `fastlane/metadata/android/{en-US,ja}/` にタイトル・説明・画像・変更履歴を配置 |

### ファイル

| パス | 役割 |
|------|------|
| `fastlane/metadata/android/en-US/` | F-Droid 掲載用メタデータ（英語） |
| `fastlane/metadata/android/ja/` | F-Droid 掲載用メタデータ（日本語） |
| `fdroid/com.prepito.app.yml` | fdroiddata 提出用ビルドレシピ |
| `fdroid/check-nonfree.py` | fdroidserver の NonFree 判定を再現する検証スクリプト |
| `.fdroid.yml` | ローカル `fdroid build` 用の設定 |

### ビルド方法

F-Droid のビルドサーバは Node.js を持たないため、レシピ側で導入する。
Expo モジュールは SDK 51 では既定で node_modules のソースからビルドされる
（autolinking の解決結果に全モジュールの `sourceDir` が含まれる）ため、
prebuilt AAR の回避設定は不要である。

```bash
# fdroidserver の導入
pip install fdroidserver

# アプリと同じディレクトリに fdroiddata がある前提
fdroid build com.prepito.app
```

### レシピ設計上の注意

F-Droid の `prebuild` コマンドは `;` で連結され、**cwd がリポジトリルート**の
1 つの bash セッションで実行される。したがって以下に注意する。

| 項目 | 内容 |
|------|------|
| `cd` の引き継ぎ | `cd` の効果は後続コマンドにも引き継がれる。ディレクトリを移す場合は `(cd ... && ...)` のサブシェルで囲む |
| `node_modules` の位置 | pnpm の hoisted 配置（`.npmrc` の `node-linker=hoisted`）のため**リポジトリルート**にある。`packages/app/node_modules` は存在しない |
| 秘密情報 | `google-services.json`・keystore・API キーはリポジトリに含めない |
| バージョン置換 | `$$VERCODE$$` は F-Droid の metadata の versionCode に置換される |
| Gradle | システム Gradle ではなくラッパー (`./gradlew`) を使う。プロジェクトは Gradle 8.6 に固定しており（`plugins/withGradleVersion`）、ビルドイメージの Gradle に依存すると版本不一致で失敗する |
| ビルドフラグ | APK に埋め込まれる `assets/app.config` は **Gradle ビルド中**の `createExpoConfig` タスクが生成する（prebuild 中ではない）。そのため prebuild プロセスへの環境変数指定だけでは反映されず、リポジトリ 루ートの `.build-flags.json` で両者に伝える |

### 検証済みのビルド結果

隔離環境（F-Droid ビルドと同じ構成）で `assembleRelease` を実行し、
**APK 生成まで成功すること**を実測済み。

| 検証項目 | 結果 |
|---------|------|
| Gradle ビルド | `BUILD SUCCESSFUL`（約 4 分） |
| APK | `app-release-unsigned.apk`（約 77 MB / 4 ABI: arm64-v8a, armeabi-v7a, x86, x86_64） |
| packageName | `com.prepito.app` |
| versionCode | `1`（metadata と一致） |
| 署名 | なし（F-Droid 側で署名する想定） |
| GMS / Firebase | **0 件**（dex 文字列・ネイティブライブラリとも非包含） |
| 外部依存 | 108 件、NonFree **0 件** |
| `libsignal-client` | バンドル内参照 **0 件**（純 TS 実装に完全置換） |
| プッシュ通知 | `enablePushNotifications: false`（`assets/app.config` で確認） |

> **Note**: `enablePushNotifications` は `assets/app.config` に埋め込まれる値で
> 実行時に判定される。Gradle ビルドのプロセス環境ではなく
> `.build-flags.json` 経由で伝わるため、値の検証は APK 内を直接確認する。

### 提出手順

1. `fdroiddata` を fork し、`metadata/com.prepito.app.yml` を作成
   （内容は `fdroid/com.prepito.app.yml` を転記する）
2. `fdroid lint com.prepito.app` で静的検証
3. fdroiddata の CI でビルドが通ることを確認
4. `New App` ラベルの Merge Request を作成

### 未対応の項目

| 項目 | 状況 |
|------|------|
| phoneScreenshots | `fastlane/metadata/android/*/images/phoneScreenshots/` は未投入。実機でのスクリーンショット取得後に追加する（掲載には任意） |
| サーバ URL | 既定の `localhost` のまま。公開サーバの用意が必要 |
| アイコン以外の画像 | `icon.png`（512x512）と `featureGraphic.png`（1024x500）は投入済み |

### F-Droid 版での制約

- **プッシュ通知は無効**。Google Play Services に依存するため
  （`EXPO_PUBLIC_ENABLE_PUSH=false`）。アプリは起動中の間 WebSocket で
  リアルタイムにメッセージを受信する
- **サーバ URL は公開 HTTPS が必要**。`app.config.ts` の
  `extra.apiBaseUrl` / `extra.wsBaseUrl` に公開エンドポイントを設定する
  （既定の `localhost` では動作しない）
- **`android/` は git 管理外**。F-Droid は `expo prebuild` を実行して生成する
- **サーバ側 API の制約**。`/api/devices`・`/api/keys/bundle/:userId` 等が
  未実装の koshi に対しては E2E 通信が成立しない（Platform API 節を参照）

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | Expo SDK 51 / React Native 0.74 |
| **Routing** | Expo Router (file-based, typed routes) |
| **State** | Zustand + TanStack Query (React Query) |
| **Styling** | NativeWind (Tailwind CSS) + Reanimated |
| **Database** | Expo SQLite (SQLCipher) |
| **Crypto** | Signal Protocol 純 TS 実装（X3DH + Double Ratchet、XEdDSA）— `@noble/curves` / `@noble/hashes` / `@noble/ciphers` + `@noble/ed25519` |
| **Auth** | JWT (HS256) + ed25519 message signing |
| **CI/CD** | GitHub Actions + EAS Build |

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 🔗 Related Projects

- [koshi](https://github.com/ryopc/koshi) — Platform backend & CLI
- [@ryopc/koshi](https://www.npmjs.com/package/@ryopc/koshi) — Shared library (npm)

---

Built with ❤️ by [ryopc](https://github.com/ryopc)