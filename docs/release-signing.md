# リリース署名鍵（GitHub Release 用）の準備

GitHub Releases に添付する APK は**端末にインストールできる必要がある**ため、
未署名 APK では配信として使えません。
一方 F-Droid はビルドサーバ側で署名するため、**F-Droid ビルドには署名鍵は不要**です。

本ドキュメントは GitHub Release 用の署名鍵を 1 度だけ生成し、
GitHub Actions の Secret として保管する手順です。

## なぜ「一度だけ生成して失効させない」のか

Android は APK の署名を update の同一性判定に使います。
署名鍵を毎回生成すると、インストール済みアプリとの間で
「署名不一致のため更新できない」という問題が発生します。

| ケース | 署名 | 結果 |
|--------|------|------|
| F-Droid から更新 | F-Droid のサーバ鍵 | 問題なし（F-Droid 側で一貫） |
| GitHub Releases から更新 | 自分のリリース鍵 | **鍵が変わると更新失敗** |
| F-Droid 版 → GitHub 版へ移行 | 別鍵 | インストールできず（別アプリ扱い） |

そのため、リリース鍵は **一度生成して Secret に保管**し、漏らさないことを推奨します。

## 1. keystore の生成

`keytool`（JDK に同梱）を使います。

```bash
keytool -genkeypair -v \
  -keystore prepito-release.keystore \
  -storetype JKS \
  -alias prepito \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

> **重要**: `-storetype JKS` を明示すること。
> JDK 9 以降の `keytool` の既定は **PKCS12** だが、PKCS12 は
> 「ストアのパスワード」と「鍵のパスワード」を別々に設定できない
> （`-keypass` が無視され、鍵のパスワードはストアのパスワードと同一になる）。
> 明示的に JKS にすることで、ストアと鍵で異なるパスワードを使える。

入力する内容:

| 項目 | 値 |
|------|-----|
| keystore パスワード | 任意の強いパスワード（Secret に入れる） |
| エイリアス | `prepito`（Secret に入れる） |
| 鍵パスワード | 任意の強いパスワード（Secret に入れる） |
| 氏名 / 組織名 / 都市名 / 都道府県 / 国 | `ryopc` / `ryopc` / 任意 / 任意 / `JP` |

生成された `prepito-release.keystore` は**リポジトリにコミットしない**こと
（`.gitignore` に対象パターンを追加済み）。

## 2. GitHub Secret への登録

4 つの Secret を登録します。

```bash
# keystore を base64 化（バイナリを env に直接通せないため）
base64 -i prepito-release.keystore | tr -d '\n' > prepito-release.keystore.b64

gh secret set ANDROID_KEYSTORE_BASE64   < prepito-release.keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD  # 対話で入力
gh secret set ANDROID_KEY_ALIAS         # prepito
gh secret set ANDROID_KEY_PASSWORD      # 対話で入力
```

確認:

```bash
gh secret list
```

| Secret | 内容 |
|--------|------|
| `ANDROID_KEYSTORE_BASE64` | base64 化した keystore |
| `ANDROID_KEYSTORE_PASSWORD` | keystore のパスワード |
| `ANDROID_KEY_ALIAS` | 鍵のエイリアス |
| `ANDROID_KEY_PASSWORD` | 鍵のパスワード |

## 3. 動作

`release.yml` は以下の順で処理します。

1. `Restore release keystore` — Secret から keystore を復元し `$RUNNER_TEMP` に配置
2. `Build preparation (shared recipe script)` — `fdroid/build-recipe.sh` を実行
   （`PREPITO_SIGNING_MODE=release`）
3. `Gradle assembleRelease` — 署名済み APK を生成
4. `Verify APK` — 署名済みであること / package 名 / versionCode / GMS 非包含を検証
5. `Create GitHub Release` → `Upload Android APK to Release`

署名設定の適用は config plugin `packages/app/plugins/withReleaseSigning.js` が
`expo prebuild` の最中に行います（Groovy の文字列操作を 1 箇所に集約するため）。

Secret が 1 つでも未設定の場合、Release ジョブは**明示的なエラーで失敗**します
（未署名 APK を Release に添付しないため）。

## 4. F-Droid ビルドとの関係

| 項目 | F-Droid ビルド | GitHub Release ビルド |
|------|----------------|----------------------|
| ビルド手順 | `fdroid/build-recipe.sh` | **同じスクリプト** |
| 署名 | なし（F-Droid が署名） | リリース鍵 |
| `PREPITO_SIGNING_MODE` | `unsigned` | `release` |
| 出力 | `app-release-unsigned.apk` | `app-release.apk`（署名 + zipalign 済み） |
| プッシュ通知 | 無効 | 無効（同一ビルドのため） |
| Firebase / GMS | 除去（同一ビルドのため） | 除去（同一ビルドのため） |

**差異は署名だけ**です。ソース・依存・Gradle 設定・ビルドフラグは同一です。

## 5. 鍵をロストした場合

GitHub Release からのアップデートはできなくなりますが、
F-Droid からの利用には影響しません（F-Droid は自分の鍵で署名するため）。
必要であれば新しい鍵を生成して `ANDROID_KEYSTORE_*` を差し替えます
（その場合、GitHub Release 版は新規インストールのみとなります）。
