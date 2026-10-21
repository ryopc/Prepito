#!/usr/bin/env bash
#
# Android ビルド準備スクリプト（単一の情報源）
#
# F-Droid サーバが `fdroid/com.prepito.app.yml` の `prebuild` で実行する処理と、
# GitHub Actions の `fdroid-build` / `release` ジョブが実行する処理を
# **同一のスクリプト**に集約する。これにより「F-Droid 向け APK」と
# 「GitHub Release 向け APK」が同一のソース・同一の依存・同一の Gradle 設定で
# ビルドされることを保証する（差異は署名だけ）。
#
# 環境変数:
#   FIREBASE_STUB_DIR      (必須) Firebase スタブの展開先ディレクトリ
#   VERCODE                (必須) APK に設定する versionCode（数字のみ）
#   PREPITO_SIGNING_MODE   (必須) 'unsigned' | 'release'
#   PREPITO_KEYSTORE_FILE  (release モードのみ必須) keystore の絶対パス
#   PREPITO_KEYSTORE_PASSWORD / PREPITO_KEY_ALIAS / PREPITO_KEY_PASSWORD
#                           (release モードのみ必須)
#
# 署名設定は config plugin `packages/app/plugins/withReleaseSigning.js` が
# `expo prebuild` の最中に適用する。本スクリプトは署名そのものを扱わない
# （Groovy の文字列操作を 1 箇所に集約するため）。
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 入力検証
# ---------------------------------------------------------------------------
: "${FIREBASE_STUB_DIR:?FIREBASE_STUB_DIR が設定されていません}"
: "${VERCODE:?VERCODE が設定されていません}"
: "${PREPITO_SIGNING_MODE:?PREPITO_SIGNING_MODE が設定されていません}"

# VERCODE は sed の置換文字列に入るため、数字以外を許可しない
if ! [[ "$VERCODE" =~ ^[0-9]+$ ]]; then
  echo "::error::VERCODE は数字でなければなりません（指定値: '$VERCODE'）" >&2
  exit 1
fi

case "$PREPITO_SIGNING_MODE" in
  unsigned) ;;
  release)
    : "${PREPITO_KEYSTORE_FILE:?PREPITO_SIGNING_MODE=release には PREPITO_KEYSTORE_FILE が必要です}"
    : "${PREPITO_KEYSTORE_PASSWORD:?PREPITO_SIGNING_MODE=release には PREPITO_KEYSTORE_PASSWORD が必要です}"
    : "${PREPITO_KEY_ALIAS:?PREPITO_SIGNING_MODE=release には PREPITO_KEY_ALIAS が必要です}"
    : "${PREPITO_KEY_PASSWORD:?PREPITO_SIGNING_MODE=release には PREPITO_KEY_PASSWORD が必要です}"
    if [ ! -f "$PREPITO_KEYSTORE_FILE" ]; then
      echo "::error::keystore が見つかりません: $PREPITO_KEYSTORE_FILE" >&2
      exit 1
    fi
    # keystore がストアパスワードで開き、エイリアスが存在するかを確認する。
    # Gradle 側の失敗（"keystore password was incorrect" 等）は原因が分かりにくい
    # ため、ここで先に検証して明示的なエラーにする。
    if command -v keytool > /dev/null 2>&1; then
      if ! keytool -list -keystore "$PREPITO_KEYSTORE_FILE" \
           -storepass "$PREPITO_KEYSTORE_PASSWORD" \
           -alias "$PREPITO_KEY_ALIAS" > /dev/null 2>&1; then
        echo "::error::keystore を開けません。ストアパスワードまたはエイリアスが誤っています" >&2
        echo "::error::  エイリアス: $PREPITO_KEY_ALIAS" >&2
        exit 1
      fi
      echo "    keystore を検証しました（エイリアス: ${PREPITO_KEY_ALIAS}）"
    else
      echo "::warning::keytool が見つからないため keystore の事前検証をスキップします"
    fi
    ;;
  *)
    echo "::error::PREPITO_SIGNING_MODE は 'unsigned' または 'release' です（指定値: '$PREPITO_SIGNING_MODE'）" >&2
    exit 1
    ;;
esac

if [ ! -d "$FIREBASE_STUB_DIR/firebase-messaging/src" ]; then
  echo "::error::Firebase スタブが見つかりません: $FIREBASE_STUB_DIR/firebase-messaging/src" >&2
  exit 1
fi

# F-Droid は prebuild の各コマンドを cwd = リポジトリルートで実行する。
# ただし CI からは任意のディレクトリから呼ばれる可能性があるため、
# スクリプト自身の位置からルートを確定する。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> ビルド準備を開始します"
echo "    リポジトリルート : $REPO_ROOT"
echo "    versionCode      : $VERCODE"
echo "    署名モード        : $PREPITO_SIGNING_MODE"

# ---------------------------------------------------------------------------
# 1) Firebase 実体への依存を除去し、スタブのソースを配置する
#
#    expo-notifications は Android で com.google.firebase:firebase-messaging を
#    必須依存するが、F-Droid は Google Play Services / Firebase を含むビルドを
#    認めていない（NonFree 判定）。公式の firebase-stub を使う。
# ---------------------------------------------------------------------------
echo "==> Firebase 依存をスタブに差し替えます"
sed -i -e '/firebase/d' node_modules/expo-notifications/android/build.gradle
cp -a "$FIREBASE_STUB_DIR/firebase-messaging/src" node_modules/expo-notifications/android

# ---------------------------------------------------------------------------
# 2) Play Install Referrer Library を除去する
#
#    com.android.installreferrer は F-Droid の NonFree 判定対象
#    (gradle_signatures: com.android.installreferrer)。
#    expo-notifications が expo-application 経由で導入するため除去する。
#    アプリ側で利用していない機能のため、削除しても影響しない。
# ---------------------------------------------------------------------------
echo "==> Play Install Referrer Library を除去します"
sed -i -e '/installreferrer/d' node_modules/expo-application/android/build.gradle
sed -i -e '/com\.android\.installreferrer\.api/d' node_modules/expo-application/android/src/main/java/expo/modules/application/ApplicationModule.kt
sed -i -e '/AsyncFunction("getInstallReferrerAsync")/,/^    }$/d' node_modules/expo-application/android/src/main/java/expo/modules/application/ApplicationModule.kt

# 除去した Kotlin ソースの構文健全性を検証する。
# sed の範囲削除が崩れるとコンパイルエラーになるため、原因を明確にするため
# ここで早期検出する。
echo "==> Kotlin ソースの構文健全性を検証します"
python3 -c "import sys;s=open('node_modules/expo-application/android/src/main/java/expo/modules/application/ApplicationModule.kt').read();d=s.count('{')-s.count('}');sys.exit('ERROR unbalanced Kotlin braces ' + str(d)) if d else None"

# ---------------------------------------------------------------------------
# 3) ビルドフラグファイル
#
#    APK に埋め込まれる assets/app.config は Gradle ビルド中の
#    createExpoConfig タスク（node getAppConfig.js）が生成する。
#    このタスクは Gradle プロセスの環境変数を参照するため、prebuild の
#    プロセスに EXPO_PUBLIC_ENABLE_PUSH を指定するだけでは反映されない。
#    ビルドフラグファイル経由で prebuild と Gradle ビルドの両方に伝える。
# ---------------------------------------------------------------------------
echo "==> ビルドフラグを設定します（プッシュ通知を無効化）"
printf '{"enablePushNotifications":false}\n' > .build-flags.json

# ---------------------------------------------------------------------------
# 4) Expo prebuild（android のみ）
#
#    署名の設定は config plugin が prebuild の最中に適用する。
#    PREPITO_SIGNING_MODE などの環境変数はこのプロセスに引き継がれる。
# ---------------------------------------------------------------------------
echo "==> expo prebuild を実行します"
( cd packages/app && EXPO_PUBLIC_ENABLE_PUSH=false npx expo prebuild -p android --clean )

# ---------------------------------------------------------------------------
# 5) versionCode を統一する
#
#    F-Droid はビルド成果 APK の versionCode が metadata の versionCode と
#    一致しない場合、ビルドを失敗させる（"Unexpected versionCode in output"）。
# ---------------------------------------------------------------------------
echo "==> versionCode を $VERCODE に設定します"
sed -i -e "s/^\([[:space:]]*\)versionCode .*/\1versionCode ${VERCODE}/" packages/app/android/app/build.gradle

# ---------------------------------------------------------------------------
# 6) 署名の検証
#
#    plugin が意図した状態になっているかを確認する。
#    ここがずれると「未署名のはずが debug 署名」、
#    「リリース署名のはずが未署名」になる。
# ---------------------------------------------------------------------------
echo "==> 署名設定を確認します"
BUILD_GRADLE="packages/app/android/app/build.gradle"
if grep -q "signingConfig signingConfigs.release" "$BUILD_GRADLE"; then
  if [ "$PREPITO_SIGNING_MODE" != "release" ]; then
    echo "::error::署名モード '$PREPITO_SIGNING_MODE' なのに release 署名が設定されています" >&2
    exit 1
  fi
  echo "    OK: release 署名が設定されています"
elif grep -q "signingConfig signingConfigs" "$BUILD_GRADLE"; then
  if [ "$PREPITO_SIGNING_MODE" != "release" ]; then
    echo "::error::署名モード '$PREPITO_SIGNING_MODE' なのに署名指定が残っています" >&2
    exit 1
  fi
  echo "    OK: release 署名が設定されています"
else
  if [ "$PREPITO_SIGNING_MODE" != "unsigned" ]; then
    echo "::error::署名モード '$PREPITO_SIGNING_MODE' なのに署名設定がありません" >&2
    exit 1
  fi
  echo "    OK: 未署名（署名指定なし）"
fi

echo "==> ビルド準備が完了しました"
