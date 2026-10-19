/**
 * Push Notification Service
 * expo-notifications を使用したプッシュ通知管理
 *
 * 機能:
 *   - 通知権限の要求 (iOS/Android)
 *   - Expo プッシュトークンの取得・サーバー登録
 *   - 通知受信ハンドラ (フォアグラウンド / バックグラウンド / タップ時)
 *   - ローカル通知の送信 (テスト・デバッグ用)
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { usersApi } from './api';
import { useAuthStore } from '@/store/auth';

/** 通知設定完了フラグ */
let _isConfigured = false;

/** 通知初期化 (アプリ起動時に1回実行) */
export async function initializeNotifications(): Promise<boolean> {
  if (_isConfigured) return true;

  // 実機でない場合は通知をスキップ (シミュレータでは FCM/APNs が動作しない)
  if (!Device.isDevice) {
    console.warn('[Notifications] 実機ではないため、プッシュ通知をスキップします');
    return false;
  }

  try {
    // 通知権限の要求
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (finalStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('[Notifications] 通知権限が拒否されました');
      return false;
    }

    // Android 用: 通知チャンネル設定
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'デフォルト',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#0EA5E9',
      });
    }

    // Expo プッシュトークン取得
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: undefined, // 自動検出
    });

    const expoPushToken = tokenData.data;
    console.log('[Notifications] プッシュトークン取得:', expoPushToken);

    // サーバーにトークン登録
    const { user } = useAuthStore.getState();
    if (user) {
      await usersApi.registerPushToken({ expoPushToken });
      console.log('[Notifications] プッシュトークンをサーバーに登録');
    }

    // 通知受信ハンドラ設定
    setupNotificationHandlers();

    _isConfigured = true;
    return true;
  } catch (err) {
    console.error('[Notifications] 初期化に失敗:', err);
    return false;
  }
}

/** 通知ハンドラ設定 */
function setupNotificationHandlers(): void {
  // フォアグラウンドでの通知受信時の挙動
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  // 通知受信時の処理 (アプリがフォアグラウンド / バックグラウンド)
  Notifications.addNotificationReceivedListener(notification => {
    console.log('[Notifications] 通知受信:', notification.request.content);
    // ここに DMStore への反映ロジックを追加可能
  });

  // 通知タップ時の処理
  Notifications.addNotificationResponseReceivedListener(response => {
    console.log('[Notifications] 通知タップ:', response.notification.request.content);
    const data = response.notification.request.content.data;
    // ここに遷移ロジックを追加可能 (例: DM 画面へ)
  });
}

/** プッシュトークンを再登録 (ログイン後など) */
export async function registerPushTokenIfAuthenticated(): Promise<void> {
  const { user, isAuthenticated } = useAuthStore.getState();
  if (!isAuthenticated || !user) return;

  if (!Device.isDevice) return;

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync();
    await usersApi.registerPushToken({ expoPushToken: tokenData.data });
    console.log('[Notifications] プッシュトークンを再登録');
  } catch (err) {
    console.error('[Notifications] トークン再登録に失敗:', err);
  }
}

/** プッシュトークン登録解除 (ログアウト時) */
export async function unregisterPushTokenIfAuthenticated(): Promise<void> {
  try {
    await usersApi.unregisterPushToken();
    console.log('[Notifications] プッシュトークンを登録解除');
  } catch (err) {
    console.error('[Notifications] トークン登録解除に失敗:', err);
  }
}

/** ローカル通知を送信 (テスト用) */
export async function sendLocalNotification(title: string, body: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: { type: 'test' },
    },
    trigger: null, // 即時通知
  });
}

/** 通知権限状態取得 */
export async function getNotificationStatus(): Promise<Notifications.PermissionStatus> {
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}
