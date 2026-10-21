#!/usr/bin/env bash
#
# ローカルで F-Droid と同じビルドを実行するスクリプト
#
# CI（fdroid-build ジョブ）と F-Droid サーバは
# `fdroid/build-recipe.sh` を実行するため、このスクリプトも
# 同じスクリプトを実行することで「手元でビルドした APK」と
# 「配布される APK」の差異を最小にする。
#
# 使い方:
#   bash scripts/build-android.sh                # 未署名（F-Droid 相当）
#   bash scripts/build-android.sh --release      # 署名付き（GitHub Release 相当）
#
# 署名付きの場合は keystore が必要。docs/release-signing.md を参照。
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# F-Droid が使う公式 firebase-stub の srclib。
# CI (fdroid-build / release ジョブ) と同じコミットを固定する。
FB_STUB_SHA="ce90a956aacda17a85c60577ee443aeb83d876ef"
STUB_CACHE_DIR="${PREPITO_FIREBASE_STUB_DIR:-$HOME/.cache/prepito/firebase-stub}"

SIGNING_MODE="unsigned"
if [ "${1:-}" = "--release" ]; then
  SIGNING_MODE="release"
elif [ -n "${1:-}" ] && [ "$1" != "--unsigned" ]; then
  echo "使い方: bash scripts/build-android.sh [--release|--unsigned]" >&2
  exit 1
fi

# --- firebase-stub の取得 -------------------------------------------------
if [ ! -d "$STUB_CACHE_DIR/firebase-messaging/src" ]; then
  echo "==> firebase-stub を取得します（$FB_STUB_SHA）"
  mkdir -p "$STUB_CACHE_DIR"
  curl -fsSL "https://gitlab.com/freed-by-fdroid/firebase-stubs/-/archive/${FB_STUB_SHA}/firebase-stubs-${FB_STUB_SHA}.tar.gz" \
    | tar xz -C "$STUB_CACHE_DIR" --strip-components=1
fi
test -d "$STUB_CACHE_DIR/firebase-messaging/src" || {
  echo "::error::firebase-stub の取得に失敗しました" >&2
  exit 1
}

# --- versionCode ----------------------------------------------------------
VERCODE="$(grep -oE 'versionCode:[[:space:]]*[0-9]+' packages/app/app.config.ts | head -1 | grep -oE '[0-9]+')"
test -n "$VERCODE" || { echo "::error::app.config.ts から versionCode を取得できません" >&2; exit 1; }

# --- ビルド準備 -----------------------------------------------------------
echo "==> ビルド準備（署名モード: $SIGNING_MODE / versionCode: $VERCODE）"
FIREBASE_STUB_DIR="$STUB_CACHE_DIR" \
VERCODE="$VERCODE" \
PREPITO_SIGNING_MODE="$SIGNING_MODE" \
  bash fdroid/build-recipe.sh

# --- Gradle ビルド --------------------------------------------------------
echo "==> Gradle ビルド"
( cd packages/app/android && ./gradlew assembleRelease --no-daemon )

APK_DIR="packages/app/android/app/build/outputs/apk/release"
echo "==> ビルド結果"
ls -lh "$APK_DIR"/*.apk
