/**
 * Chats List Screen
 * DMスレッド一覧表示 (E2E暗号化)
 */

import React, { useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDMStore } from '@/store/dm';
import { useAuthStore } from '@/store/auth';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#ffffff' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: '#1e293b' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 4 },
  listContainer: { flex: 1 },
  contentContainer: { paddingBottom: 100 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: '#1e293b', marginBottom: 8 },
  emptyDescription: { fontSize: 16, color: '#64748b', textAlign: 'center', lineHeight: 24 },
  threadItem: {
    flexDirection: 'row', alignItems: 'center', padding: 16,
    borderBottomWidth: 1, borderBottomColor: '#f1f5f9', backgroundColor: '#ffffff',
  },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#e2e8f0' },
  avatarText: { color: '#64748b', textAlign: 'center', fontSize: 18 },
  threadInfo: { flex: 1, marginLeft: 12 },
  threadHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  threadName: { fontSize: 16, fontWeight: '600', color: '#1e293b' },
  unreadBadge: {
    backgroundColor: '#0ea5e9', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2,
    minWidth: 24, alignItems: 'center',
  },
  unreadBadgeText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  threadPreview: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  previewText: { fontSize: 14, color: '#64748b' },
  previewTime: { fontSize: 12, color: '#94a3b8' },
  fab: {
    position: 'absolute', right: 24, bottom: 24,
    width: 56, height: 56, borderRadius: 28, backgroundColor: '#0ea5e9',
    justifyContent: 'center', alignItems: 'center', elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8,
  },
  loading: { padding: 24, justifyContent: 'center', alignItems: 'center' },
});

export default function ChatsScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  const {
    threads, threadsLoading, unreadCount,
    fetchThreads, markAsRead, setActiveConversation, error, clearError,
  } = useDMStore();

  useEffect(() => {
    if (user) {
      fetchThreads();
    }
    return () => {
      // コンポーネントアンマウント時はアクティブ会話をクリア
      setActiveConversation(null);
    };
  }, [user, fetchThreads, setActiveConversation]);

  const handleThreadPress = (threadId: string) => {
    setActiveConversation(threadId);
    markAsRead(threadId);
    router.push(`/(app)/chats/${threadId}`);
  };

  const renderItem = ({ item }: { item: typeof threads[number] }) => (
    <TouchableOpacity style={styles.threadItem} onPress={() => handleThreadPress(item.conversationId)}>
      <View style={styles.avatar}>
        {item.otherAvatarUrl ? (
          // TODO: 画像コンポーネント
          <Text style={styles.avatarText}>{item.otherUsername.charAt(0).toUpperCase()}</Text>
        ) : (
          <Text style={styles.avatarText}>{item.otherUsername.charAt(0).toUpperCase()}</Text>
        )}
      </View>
      <View style={styles.threadInfo}>
        <View style={styles.threadHeader}>
          <Text style={styles.threadName}>{item.otherDisplayName || item.otherUsername}</Text>
          {item.unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{item.unreadCount}</Text>
            </View>
          )}
        </View>
        <View style={styles.threadPreview}>
          <Text style={styles.previewText} numberOfLines={1}>
            {item.lastMessage ? item.lastMessage.slice(0, 60) : 'メッセージを送信してください'}
          </Text>
          <Text style={styles.previewTime}>
            {item.lastMessageAt ? new Date(item.lastMessageAt).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' }) : ''}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward-outline" size={20} color="#94a3b8" />
    </TouchableOpacity>
  );

  if (error) {
    Alert.alert('エラー', error);
    clearError();
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>チャット</Text>
            <Text style={styles.subtitle}>
              {unreadCount > 0 ? `未読 ${unreadCount}件` : ''}
            </Text>
          </View>
          <Ionicons name="refresh-outline" size={24} color="#64748b" onPress={fetchThreads} />
        </View>
      </View>

      {threadsLoading && (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      )}

      <FlatList
        style={styles.listContainer}
        data={threads}
        keyExtractor={(item) => item.conversationId}
        renderItem={renderItem}
        contentContainerStyle={styles.contentContainer}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="chatbubbles-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyTitle}>メッセージがありません</Text>
            <Text style={styles.emptyDescription}>
              新しい会話を始めるには、右下のボタンをタップして\n連絡先から相手を選択してください。
            </Text>
          </View>
        }
      />

      <TouchableOpacity style={styles.fab} onPress={() => router.push('/(app)/chats/new')}>
        <Ionicons name="add" size={28} color="#ffffff" />
      </TouchableOpacity>
    </View>
  );
}
