/**
 * Login Screen
 * Handles username/passwordless login via ed25519 signature challenge
 */

import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/auth';
import { signMessage } from '@/utils/crypto';
import { getSecureItem } from '@/utils/secureStore';
import { checkDeviceRegistration } from '@/services/crypto/device-keys';
import { styles } from './authStyles';

export default function LoginScreen() {
  const router = useRouter();
  const { setAuth, setError } = useAuthStore();

  const [username, setUsername] = useState('');
  const [isLoading, setLocalLoading] = useState(false);
  const [error, setLocalError] = useState('');

  const handleLogin = useCallback(async () => {
    if (!username.trim()) {
      setLocalError('ユーザー名を入力してください');
      return;
    }

    setLocalLoading(true);
    setLocalError('');
    setError(null);

    try {
      // ローカルの秘密鍵取得
      const secretKey = await getSecureItem('prepito.secret_key');

      if (!secretKey) {
        throw new Error('秘密鍵が見つかりません。再登録してください。');
      }

      // チャレンジ: "koshi:login:{username}"
      // サーバはユーザー名を trim + 小文字化して検証するため、
      // クライアント側でも同じ正規化を行わないと署名が一致しない
      const normalizedUsername = username.trim().toLowerCase();
      const challenge = `koshi:login:${normalizedUsername}`;
      const signature = await signMessage(challenge, secretKey);

      // ログインAPI呼び出し
      const { authApi } = await import('@/services/api');
      const result = await authApi.login(normalizedUsername, signature);

      // 認証状態更新
      await setAuth({
        accessToken: result.token,
        refreshToken: result.refreshToken,
        userId: result.userId,
        username: normalizedUsername,
      });

      // デバイス登録確認 → 未登録なら device-setup へ
      const hasDevice = await checkDeviceRegistration();

      if (hasDevice) {
        router.replace('/(app)/chats');
      } else {
        router.replace('/(auth)/device-setup');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ログインに失敗しました';
      setLocalError(message);
      setError(message);
    } finally {
      setLocalLoading(false);
    }
  }, [username, setAuth, setError, router]);

  const handleGoRegister = useCallback(() => {
    router.push('/(auth)/register');
  }, [router]);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Prepito</Text>
        <Text style={styles.subtitle}>koshi platform reference client</Text>

        <TextInput
          style={styles.input}
          placeholder="ユーザー名"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoComplete="username"
          textContentType="username"
          onSubmitEditing={handleLogin}
          editable={!isLoading}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, isLoading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="white" size="small" />
          ) : (
            <Text style={styles.buttonText}>ログイン</Text>
          )}
        </TouchableOpacity>

        <View style={styles.divider}>
          <Text style={styles.dividerText}>または</Text>
        </View>

        <TouchableOpacity style={styles.button} onPress={handleGoRegister} disabled={isLoading}>
          <Text style={[styles.buttonText, styles.buttonTextSecondary]}>新規登録</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>E2E暗号化 • 非中央集権 • プライバシー重視</Text>
    </View>
  );
}
