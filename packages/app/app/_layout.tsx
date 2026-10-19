/**
 * Root Layout
 * Entry point with providers and auth routing
 */

import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Providers } from './providers';
import { useAuthStore } from '@/store/auth';
import { connectWebSocket, disconnectWebSocket } from '@/services/websocket';
import { initializeNotifications, unregisterPushTokenIfAuthenticated } from '@/services/notifications';

export default function RootLayout() {
  const router = useRouter();
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
    return (
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="splash" />
      </Stack>
    );
  }

  return (
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
      
      {/* 共通モーダル等 */}
      <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
    </Stack>
  );
}