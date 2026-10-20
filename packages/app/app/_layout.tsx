/**
 * Root Layout
 * Entry point with providers and auth routing
 */

import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { Providers } from './providers';
import { useAuthStore } from '@/store/auth';
import { connectWebSocket, disconnectWebSocket } from '@/services/websocket';
import {
  initializeNotifications,
  unregisterPushTokenIfAuthenticated,
} from '@/services/notifications';

export default function RootLayout() {
  const { isAuthenticated, isLoading, initializeAuth } = useAuthStore();

  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  // 認証状態に基づく WebSocket 接続管理
  useEffect(() => {
    if (isAuthenticated) {
      connectWebSocket();
    } else {
      disconnectWebSocket();
    }
    return () => {
      disconnectWebSocket();
    };
  }, [isAuthenticated]);

  // 認証状態に基づくプッシュ通知初期化
  useEffect(() => {
    if (isAuthenticated) {
      initializeNotifications();
    } else {
      unregisterPushTokenIfAuthenticated();
    }
  }, [isAuthenticated]);

  // 認証状態に基づくルーティング
  if (isLoading) {
    // NOTE: 旧実装は <Stack.Screen name="splash" /> を参照していたが
    // app/splash.tsx は存在せず、expo-router の require.context により
    // 未定義ルート参照が発生していた。専用画面を持たせずインジケータで代替する。
    return (
      <Providers>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#0EA5E9" />
        </View>
      </Providers>
    );
  }

  return (
    <Providers>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#ffffff' },
        }}
      >
        {/* 認証済み: メインタブ */}
        {isAuthenticated ? (
          <Stack.Screen name="(app)" />
        ) : (
          /* 未認証: 認証スタック */
          <Stack.Screen name="(auth)" />
        )}
      </Stack>
    </Providers>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
});
