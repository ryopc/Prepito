/**
 * Device Setup Screen
 * First-time setup: generates X3DH keys for E2E encryption
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/auth';
import {
  runInitialDeviceSetup,
  checkDeviceRegistration,
  debugPrintKeys,
} from '@/services/crypto/device-keys';
import { styles } from './authStyles';

export default function DeviceSetupScreen() {
  const router = useRouter();
  const { setDeviceRegistered, setDeviceSetupComplete, isAuthenticated } = useAuthStore();

  const [step, setStep] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [progress, setProgress] = useState(0);

  const steps = [
    {
      title: '暗号鍵の生成',
      description:
        'このデバイス専用の公開鍵・秘密鍵ペアを生成します。秘密鍵はこのデバイスから決して出ません。',
    },
    {
      title: '鍵のサーバー登録',
      description:
        '公開鍵のみをサーバーに登録し、他のユーザーがあなたと暗号化通信できるようにします。',
    },
    {
      title: 'セットアップ完了',
      description: 'E2E暗号化の準備が完了しました。チャットを始めましょう。',
    },
  ];

  const handleSetup = useCallback(async () => {
    if (step === 0) {
      // Step 1: デバイス名入力（任意）
      setStep(1);
      return;
    }

    if (step === 1) {
      setIsLoading(true);
      setError('');
      setProgress(10);

      try {
        // 実際のセットアップ実行
        const success = await runInitialDeviceSetup(deviceName.trim() || undefined);

        if (success) {
          setProgress(100);
          await setDeviceRegistered(true);
          await setDeviceSetupComplete(true);

          // デバッグ出力
          await debugPrintKeys();

          setStep(2);

          // 少し待ってからチャット画面へ
          setTimeout(() => {
            router.replace('/(app)/chats');
          }, 1500);
        } else {
          throw new Error('デバイス登録に失敗しました');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'セットアップに失敗しました';
        setError(message);
        setProgress(0);
      } finally {
        setIsLoading(false);
      }
    }
  }, [step, deviceName, setDeviceRegistered, setDeviceSetupComplete, router]);

  const handleSkip = useCallback(async () => {
    // スキップ時も最小限の鍵生成を行う
    setIsLoading(true);
    setError('');
    try {
      const success = await runInitialDeviceSetup();
      if (success) {
        await setDeviceRegistered(true);
        await setDeviceSetupComplete(true);
        router.replace('/(app)/chats');
      } else {
        throw new Error('セットアップに失敗しました');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setIsLoading(false);
    }
  }, [setDeviceRegistered, setDeviceSetupComplete, router]);

  // 既にデバイス登録済みならスキップ
  useEffect(() => {
    if (isAuthenticated) {
      checkDeviceRegistration().then((registered) => {
        if (registered) {
          router.replace('/(app)/chats');
        }
      });
    }
  }, [isAuthenticated, router]);

  const currentStep = steps[Math.min(step, steps.length - 1)];

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {/* Progress Indicator */}
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${Math.min(progress, 100)}%` }]} />
          </View>
          <Text style={styles.progressText}>
            Step {step + 1} / {steps.length}
          </Text>
        </View>

        {/* Step Content */}
        <View style={styles.stepContainer}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepNumberText}>{step + 1}</Text>
          </View>
          <Text style={styles.stepTitle}>{currentStep.title}</Text>
          <Text style={styles.stepDescription}>{currentStep.description}</Text>
        </View>

        {/* Step 0: Device Name Input */}
        {step === 0 && (
          <View style={styles.featureList}>
            <TextInput
              style={styles.input}
              placeholder="デバイス名 (任意) 例: iPhone 15 Pro"
              value={deviceName}
              onChangeText={setDeviceName}
              maxLength={32}
              autoCapitalize="words"
            />
          </View>
        )}

        {/* Step 1: Progress */}
        {step === 1 && isLoading && (
          <View style={styles.featureList}>
            <Text style={styles.featureText}>暗号鍵を生成しています...</Text>
          </View>
        )}

        {/* Step 2: Complete */}
        {step === 2 && (
          <View style={styles.featureList}>
            <View style={styles.featureItem}>
              <View style={styles.featureIcon}>
                <Text style={{ fontSize: 16 }}>✓</Text>
              </View>
              <Text style={styles.featureText}>Identity Key (長期鍵) 生成完了</Text>
            </View>
            <View style={styles.featureItem}>
              <View style={styles.featureIcon}>
                <Text style={{ fontSize: 16 }}>✓</Text>
              </View>
              <Text style={styles.featureText}>Signed PreKey (中期間鍵) 生成完了</Text>
            </View>
            <View style={styles.featureItem}>
              <View style={styles.featureIcon}>
                <Text style={{ fontSize: 16 }}>✓</Text>
              </View>
              <Text style={styles.featureText}>One-Time PreKeys (100個) 生成完了</Text>
            </View>
            <View style={styles.featureItem}>
              <View style={styles.featureIcon}>
                <Text style={{ fontSize: 16 }}>✓</Text>
              </View>
              <Text style={styles.featureText}>サーバー登録完了</Text>
            </View>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        {/* Action Buttons */}
        {step === 0 && (
          <TouchableOpacity
            style={[styles.button, styles.buttonPrimary, isLoading && styles.buttonDisabled]}
            onPress={handleSetup}
            disabled={isLoading}
          >
            <Text style={styles.buttonText}>次へ</Text>
          </TouchableOpacity>
        )}

        {step === 1 && !isLoading && (
          <TouchableOpacity style={[styles.button, styles.buttonPrimary]} onPress={handleSetup}>
            <Text style={styles.buttonText}>セットアップ開始</Text>
          </TouchableOpacity>
        )}

        {step === 2 && (
          <TouchableOpacity
            style={[styles.button, styles.buttonPrimary]}
            onPress={() => router.replace('/(app)/chats')}
          >
            <Text style={styles.buttonText}>チャットを始める</Text>
          </TouchableOpacity>
        )}

        {step < 2 && (
          <TouchableOpacity style={styles.button} onPress={handleSkip} disabled={isLoading}>
            <Text style={[styles.buttonText, styles.buttonTextSecondary]}>スキップ</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.footer}>E2E暗号化 • Signal Protocol (X3DH + Double Ratchet)</Text>
    </View>
  );
}
