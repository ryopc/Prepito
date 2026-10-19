/**
 * Chats List Screen
 * Placeholder for Phase 3 implementation
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  title: { fontSize: 28, fontWeight: '700', color: '#1e293b' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: '#1e293b', marginBottom: 8 },
  emptyDescription: { fontSize: 16, color: '#64748b', textAlign: 'center', lineHeight: 24 },
  fab: { position: 'absolute', right: 24, bottom: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#0ea5e9', justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8 },
  comingSoon: { padding: 24, alignItems: 'center' },
  comingSoonText: { fontSize: 16, color: '#64748b', marginTop: 8 },
});

export default function ChatsScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>チャット</Text>
      </View>

      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>💬</Text>
        <Text style={styles.emptyTitle}>メッセージがありません</Text>
        <Text style={styles.emptyDescription}>
          新しい会話を始めるには、右下のボタンをタップして\n連絡先から相手を選択してください。
        </Text>
      </View>

      <TouchableOpacity style={styles.fab} onPress={() => router.push('/(app)/chats/new')}>
        <Ionicons name="add" size={28} color="white" />
      </TouchableOpacity>
    </View>
  );
}