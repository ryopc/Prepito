import type { ConfigContext, ExpoConfig } from 'expo/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ビルドフラグファイル
 *
 * F-Droid ビルドでは `EXPO_PUBLIC_ENABLE_PUSH=false` を指定して
 * プッシュ通知を無効化する。しかしこの環境変数は
 * `expo prebuild` のプロセスにのみ伝わり、APK に埋め込まれる
 * `assets/app.config` は **Gradle ビルド中の `createExpoConfig` タスク**
 * （`node getAppConfig.js`）が生成するため、Gradle プロセスの
 * 環境変数を参照する。
 *
 * そこでリポジトリルートにビルドフラグファイルを置き、
 * prebuild と Gradle ビルドの両方から参照できるようにする。
 */
interface BuildFlags {
  enablePushNotifications?: boolean;
}

function readBuildFlags(): BuildFlags {
  // app.config.ts は packages/app/ に置かれているため、ルートは 2 つ上
  const flagPath = path.resolve(__dirname, '../../.build-flags.json');
  try {
    return JSON.parse(fs.readFileSync(flagPath, 'utf8')) as BuildFlags;
  } catch {
    return {};
  }
}

const buildFlags = readBuildFlags();

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Prepito',
  slug: 'prepito',
  scheme: 'prepito',
  version: '0.0.1',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.prepito.app',
    infoPlist: {
      NSFaceIDUsageDescription: 'PrepitoでFace ID/Touch IDを使用してアプリをロック解除します',
      NSCameraUsageDescription:
        'プロフィール画像やチャットで写真を撮影・選択するためにカメラへのアクセスを許可してください',
      NSPhotoLibraryUsageDescription:
        'プロフィール画像やチャットで写真を選択するために写真ライブラリへのアクセスを許可してください',
      NSMicrophoneUsageDescription:
        'ボイスメッセージ送信のためにマイクへのアクセスを許可してください',
    },
    associatedDomains: ['applinks:prepito.app'],
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0EA5E9',
    },
    package: 'com.prepito.app',
    /**
     * versionCode はリテラル固定する。
     *
     * F-Droid はビルド成果 APK の versionCode が metadata の versionCode と
     * 一致しない場合、ビルドを失敗させる（"Unexpected versionCode in output"）。
     * そのため `eas.json` の `cli.appVersionSource` は `"local"` に固定し、
     * EAS / GitHub Release / F-Droid で同じ versionCode を使う。
     * リリース時はこの値を明示的に更新する。
     */
    versionCode: 1,
    // 未使用機能に対応するパーミッションは要求しない（F-Droid 審査の観点）
    // - CAMERA / RECORD_AUDIO: カメラ・録音機能は未実装
    // - READ/WRITE_EXTERNAL_STORAGE: expo-file-system はアプリ私有ディレクトリのみ使用
    // - USE_BIOMETRIC / USE_FINGERPRINT: expo-local-authentication は未実装（placeholder）
    // なお RECEIVE_BOOT_COMPLETED は expo-notifications の AndroidManifest が
    // 宣言しているため、manifest merge 経由で付与される（ここでは宣言しない）。
    permissions: ['android.permission.VIBRATE', 'android.permission.POST_NOTIFICATIONS'],
    intentFilters: [
      {
        action: 'VIEW',
        data: { scheme: 'prepito' },
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-notifications',
    // Expo SDK 51 のテンプレート (dist-tag 可変) が Gradle 8.8 を使うと
    // expo-modules-core / expo-task-manager がビルド失敗するため 8.6 に固定する
    './plugins/withGradleVersion',
    [
      'expo-build-properties',
      {
        ios: { useFrameworks: 'static' },
        android: { enableProguardInReleaseBuilds: true },
      },
    ],
    /**
     * 署名設定（F-Droid ビルドは未署名、GitHub Release ビルドはリリース署名）
     *
     * モードは環境変数 `PREPITO_SIGNING_MODE` で指定する。
     * - `unsigned` : 署名指定を除去する（F-Droid は自前の鍵で署名するため）
     * - `release`  : `PREPITO_KEYSTORE_*` の keystore で署名する
     * - 未指定     : 何もしない（prebuild 既定の debug 署名のまま）
     *
     * 他の plugin が build.gradle を書き換えた**後**に適用したいので、
     * この plugin は最後に配置している。
     */
    './plugins/withReleaseSigning',
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    /**
     * 公開サーバの URL（単一情報源）
     *
     * F-Droid ビルドサーバは環境変数を設定できないため、
     * `EXPO_PUBLIC_*` は Metro のバンドル時にインライン化されるだけで
     * 値を差し込めない。公開 URL を**リポジトリにコミットして固定する**。
     *
     * - release ビルドの AndroidManifest は cleartext を無効化しているため
     *   HTTPS / WSS 必須（debug ビルドのみ `usesCleartextTraffic="true"`）
     * - ローカル開発で別サーバを使いたい場合は
     *   `EXPO_PUBLIC_API_BASE_URL` / `EXPO_PUBLIC_WS_BASE_URL` で上書きする
     */
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL || 'https://koshi.ryopc.org',
    wsBaseUrl: process.env.EXPO_PUBLIC_WS_BASE_URL || 'wss://koshi.ryopc.org',
    koshiVersion: '4.0.0',
    /**
     * プッシュ通知（Expo Push / FCM）の有効フラグ
     *
     * 既定は true。F-Droid ビルドでは `EXPO_PUBLIC_ENABLE_PUSH=false` を
     * 指定して無効化する。理由:
     * - F-Droid は Google Play Services / Firebase を含むビルドを認めない
     * - Expo Push トークン取得は `exp.host` への常時通信を伴うため、
     *   既定オフ + 明示同意の状態でなければ Anti-Feature「Tracking」に該当しうる
     */
    enablePushNotifications:
      buildFlags.enablePushNotifications ?? process.env.EXPO_PUBLIC_ENABLE_PUSH !== 'false',
    /**
     * EAS プロジェクト ID
     *
     * プロジェクト: @ryopc/prepito (https://expo.dev/accounts/ryopc/projects/prepito)
     * `eas build` / `eas submit` はこの ID が未設定だと
     * "EAS project not configured" で失敗する。
     * EXPO_PUBLIC_EAS_PROJECT_ID 環境変数で上書き可能。
     */
    eas: {
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? '9825e4a3-f449-4d29-9b99-c72985d23f00',
    },
  },
});
