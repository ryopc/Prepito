/**
 * Register Screen
 * Creates new account with ed25519 keypair generation
 */

import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/auth';
import { generateKeypair } from '@/utils/crypto';
import { setSecureItem } from '@/utils/secureStore';
import { authApi } from '@/services/api';
import { styles } from './authStyles';

export default function RegisterScreen() {
  const router = useRouter();
  const { setAuth, setError, setLoading } = useAuthStore();
  
  const [username, setUsername] = useState('');
  const [isLoading, setLocalLoading] = useState(false);
  const [error, setLocalError] = useState('');

  const handleRegister = useCallback(async () => {
    const trimmed = username.trim();
    
    if (!trimmed) {
      setLocalError('ユーザー名を入力してください');
      return;
    }
    
    if (trimmed.length < 3 || trimmed.length > 32) {
      setLocalError('ユーザー名は3〜32文字で入力してください');
      return;
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setLocalError('ユーザー名は英数字、ハイフン、アンダースコアのみ使用可能です');
      return;
    }

    setLocalLoading(true);
    setLocalError('');
    setError(null);

    try {
      // 1. ed25519鍵ペア生成
      const keypair = await generateKeypair();
      
      // 2. 秘密鍵をローカル保存
      await setSecureItem('prepito.secret_key', keypair.secretKey);
      
      // 3. サーバー登録 (公開鍵のみ送信)
      const result = await authApi.register(trimmed, keypair.publicKey);
      
      // 4. 認証状態更新
      await setAuth({
        accessToken: result.token,
        refreshToken: result.refreshToken,
        userId: result.userId,
        username: trimmed,
      });

      // 5. デバイスセットアップ画面へ
      router.replace('/(auth)/device-setup');
    } catch (err) {
      let message = '登録に失敗しました';
      
      if (err instanceof Error) {
        if (err.message.includes('already exists') || err.message.includes('409')) {
          message = 'このユーザー名は既に使用されています';
        } else if (err.message.includes('400')) {
          message = '無効なユーザー名です';
        } else {
          message = err.message;
        }
      }
      
      setLocalError(message);
      setError(message);
    } finally {
      setLocalLoading(false);
    }
  }, [username, setAuth, setError, router]);

  const handleGoLogin = useCallback(() => {
    router.replace('/(auth)/login');
  }, [router]);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Prepito</Text>
        <Text style={styles.subtitle}>新規アカウント作成</Text>

        <Text style={styles.description}>
          エンドツーエンド暗号化メッセンジャーアカウントを作成します。
          あなたの秘密鍵はこのデバイスから決して出ません。
        </Text>

        <TextInput
          style={styles.input}
          placeholder="ユーザー名 (3-32文字)"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoComplete="username"
          textContentType="username"
          onSubmitEditing={handleRegister}
          editable={!isLoading}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary, isLoading && styles.buttonDisabled]}
          onPress={handleRegister}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="white" size="small" />
          ) : (
            <Text style={styles.buttonText}>アカウント作成</Text>
          )}
        </TouchableOpacity>

        <View style={styles.divider}>
          <Text style={styles.dividerText}>アカウントをお持ちの方</Text>
        </View>

        <TouchableOpacity
          style={styles.button}
          onPress={handleGoLogin}
          disabled={isLoading}
        >
          <Text style={[styles.buttonText, styles.buttonTextSecondary]}>ログイン</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        E2E暗号化 • 非中央集権 • プライバシー重視
      </Text>
    </View>
  );
}