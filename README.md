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
├── tsconfig.json
├── .prettierrc
├── .eslintrc.js
├── packages/
│   ├── shared/                  # @prepito/shared - 共通型定義・ユーティリティ
│   │   ├── src/
│   │   │   └── index.ts         # koshi型の再エクスポート + Prepito固有型
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── eslint.config.js
│   └── app/                     # @prepito/app - Expo / React Native アプリ
│       ├── app/                 # Expo Router (file-based routing)
│       ├── src/
│       │   ├── components/      # 共通UIコンポーネント
│       │   ├── hooks/           # カスタムフック
│       │   ├── services/        # API / Crypto / Storage / Notifications
│       │   ├── store/           # Zustand ストア
│       │   └── utils/           # ユーティリティ
│       ├── assets/              # アイコン、スプラッシュ等
│       ├── package.json
│       ├── tsconfig.json
│       ├── eslint.config.js
│       └── app.config.ts
└── docker-compose.yml           # 開発用: PostgreSQL + koshi backend
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18
- pnpm >= 9
- [koshi backend](https://github.com/ryopc/koshi) 実行環境 (PostgreSQL + Redis)

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
```

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
| **Group** | Sender Keys (libsignal) → 将来 MLS 移行予定 |
| **Key Storage** | Expo SecureStore (iOS Keychain / Android Keystore) + SQLCipher |
| **Library** | `@signalapp/libsignal-client` (JSI / Native Module) |

> **Note**: EAS Development Build 必須 (libsignal-client は Native Module を使用)

## 📡 Platform API (koshi)

Prepito は koshi の以下の API を使用します：

| Category | Endpoints |
|----------|-----------|
| **Auth** | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh` |
| **Users** | `GET /api/users/search`, `GET /api/users/:id` |
| **DM** | `GET /api/dms`, `POST /api/dms/:userId`, `PUT /api/dms/:id/read` |
| **Groups** | `GET /api/groups`, `POST /api/groups`, `GET/POST /api/groups/:id/messages` |
| **E2E Keys** | `GET/POST /api/devices`, `GET /api/keys/bundle/:userId` |
| **WebSocket** | `/ws?token=<jwt>` — `dm_received`, `group_message`, `typing_start/stop`, `key_bundle_response` |

詳細: [koshi API Reference](https://koshi.js.org/api) / `src/types/index.ts` の `WSEventMap`

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | Expo SDK 51 / React Native 0.74 |
| **Routing** | Expo Router (file-based, typed routes) |
| **State** | Zustand + TanStack Query (React Query) |
| **Styling** | NativeWind (Tailwind CSS) + Reanimated |
| **Database** | Expo SQLite (SQLCipher) |
| **Crypto** | `@signalapp/libsignal-client` / `@noble/ed25519` |
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