import type { ConfigContext, ExpoConfig } from 'expo/config';

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
    backgroundColor: '#ffffff'
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.prepito.app',
    infoPlist: {
      NSFaceIDUsageDescription: 'PrepitoでFace ID/Touch IDを使用してアプリをロック解除します',
      NSCameraUsageDescription: 'プロフィール画像やチャットで写真を撮影・選択するためにカメラへのアクセスを許可してください',
      NSPhotoLibraryUsageDescription: 'プロフィール画像やチャットで写真を選択するために写真ライブラリへのアクセスを許可してください',
      NSMicrophoneUsageDescription: 'ボイスメッセージ送信のためにマイクへのアクセスを許可してください'
    },
    associatedDomains: ['applinks:prepito.app']
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff'
    },
    package: 'com.prepito.app',
    permissions: [
      'android.permission.CAMERA',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.RECORD_AUDIO',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT'
    ],
    intentFilters: [
      {
        action: 'VIEW',
        data: { scheme: 'prepito' },
        category: ['BROWSABLE', 'DEFAULT']
      }
    ]
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-local-authentication',
    'expo-notifications',
    [
      'expo-build-properties',
      {
        ios: { useFrameworks: 'static' },
        android: { enableProguardInReleaseBuilds: true }
      }
    ]
  ],
  experiments: {
    typedRoutes: true
  },
  extra: {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000',
    wsBaseUrl: process.env.EXPO_PUBLIC_WS_BASE_URL || 'ws://localhost:3000',
    koshiVersion: '4.0.0'
  }
});