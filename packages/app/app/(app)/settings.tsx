/**
 * Settings Screen
 * Placeholder for Phase 6 implementation
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/store/auth';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  title: { fontSize: 28, fontWeight: '700', color: '#1e293b' },
  section: { backgroundColor: '#ffffff', marginTop: 12 },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  itemLast: { borderBottomWidth: 0 },
  itemIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#dbeafe',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  itemContent: { flex: 1 },
  itemTitle: { fontSize: 16, fontWeight: '500', color: '#1e293b' },
  itemSubtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  itemChevron: { marginLeft: 8 },
  logoutButton: {
    marginHorizontal: 16,
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
  },
  logoutText: { color: '#dc2626', fontSize: 16, fontWeight: '600' },
  versionContainer: { padding: 24, alignItems: 'center' },
  versionText: { fontSize: 13, color: '#94a3b8' },
});

export default function SettingsScreen() {
  const { user, clearAuth } = useAuthStore();

  const handleLogout = () => {
    Alert.alert(
      'ログアウト',
      '本当にログアウトしますか？\nデバイスの暗号鍵はそのまま保持されます。',
      [
        { text: 'キャンセル', style: 'cancel' },
        { text: 'ログアウト', style: 'destructive', onPress: async () => await clearAuth() },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'アカウント削除',
      'この操作は取り消せません。\nすべてのメッセージ、連絡先、暗号鍵が削除されます。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除する',
          style: 'destructive',
          onPress: () => {
            /* 実装予定 */
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>設定</Text>
      </View>

      {/* Account Section */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>アカウント</Text>
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            /* プロフィール編集 */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="person-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>プロフィール</Text>
            <Text style={styles.itemSubtitle}>
              {user ? `@${user.username}` : '表示名、Bio、アバターの編集'}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.item, styles.itemLast]} onPress={handleLogout}>
          <View style={styles.itemIcon}>
            <Ionicons name="log-out-outline" size={20} color="#dc2626" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>ログアウト</Text>
            <Text style={styles.itemSubtitle}>現在のセッションを終了</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Security Section */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>セキュリティ</Text>
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            /* Security settings */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="lock-closed-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>アプリロック</Text>
            <Text style={styles.itemSubtitle}>Face ID / Touch ID / 生体認証でロック</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            /* Devices */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="laptop-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>デバイス管理</Text>
            <Text style={styles.itemSubtitle}>登録デバイスの確認・削除、鍵のローテーション</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.item, styles.itemLast]}
          onPress={() => {
            /* E2E Verification */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="shield-checkmark-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>暗号化の確認</Text>
            <Text style={styles.itemSubtitle}>セーフティナンバーでE2E暗号化を検証</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
      </View>

      {/* Notifications Section */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>通知</Text>
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            /* Notification settings */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="notifications-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>プッシュ通知</Text>
            <Text style={styles.itemSubtitle}>メッセージ、メンション、反応の通知設定</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.item, styles.itemLast]}
          onPress={() => {
            /* Quiet hours */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="moon-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>おやすみモード</Text>
            <Text style={styles.itemSubtitle}>通知を無音にする時間帯を設定</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
      </View>

      {/* Data & Storage */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>データとストレージ</Text>
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            /* Storage usage */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="folder-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>ストレージ使用量</Text>
            <Text style={styles.itemSubtitle}>キャッシュ、メディア、データベースの容量</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.item}
          onPress={() => {
            /* Export data */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="download-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>データのエクスポート</Text>
            <Text style={styles.itemSubtitle}>メッセージ履歴等をエクスポート</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.item, styles.itemLast]}
          onPress={() => {
            /* Clear cache */
          }}
        >
          <View style={styles.itemIcon}>
            <Ionicons name="trash-outline" size={20} color="#dc2626" />
          </View>
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle}>キャッシュをクリア</Text>
            <Text style={styles.itemSubtitle}>一時ファイルを削除して空き容量を増やす</Text>
          </View>
          <Ionicons
            name="chevron-forward-outline"
            size={20}
            color="#94a3b8"
            style={styles.itemChevron}
          />
        </TouchableOpacity>
      </View>

      {/* Danger Zone */}
      <View style={styles.section}>
        <Text style={styles.sectionHeader}>危険な操作</Text>
        <TouchableOpacity style={[styles.item, styles.itemLast]} onPress={handleDeleteAccount}>
          <View style={styles.itemIcon}>
            <Ionicons name="trash-outline" size={20} color="#dc2626" />
          </View>
          <View style={styles.itemContent}>
            <Text style={{ ...styles.itemTitle, color: '#dc2626' }}>アカウントを削除</Text>
            <Text style={styles.itemSubtitle}>すべてのデータが永久に削除されます</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Version Info */}
      <View style={styles.versionContainer}>
        <Text style={styles.versionText}>Prepito v0.0.1 (Phase 1 - Auth & Device Setup)</Text>
        <Text style={styles.versionText}>
          Built with Expo SDK 51 • React Native 0.74 • TypeScript
        </Text>
      </View>
    </View>
  );
}
