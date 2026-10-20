/**
 * Contacts Screen
 * Placeholder for Phase 3 implementation
 */

import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
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
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#dbeafe',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: { fontSize: 18, fontWeight: '600', color: '#0ea5e9' },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 16, fontWeight: '600', color: '#1e293b' },
  contactUsername: { fontSize: 14, color: '#64748b', marginTop: 2 },
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0ea5e9',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
});

const MOCK_CONTACTS = [
  { id: '1', username: 'alice', displayName: 'Alice' },
  { id: '2', username: 'bob', displayName: 'Bob Smith' },
  { id: '3', username: 'charlie', displayName: 'Charlie' },
];

export default function ContactsScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>連絡先</Text>
      </View>

      <FlatList
        data={MOCK_CONTACTS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.contactItem}
            onPress={() => router.push(`/(app)/contacts/${item.id}`)}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {item.displayName?.[0] || item.username[0].toUpperCase()}
              </Text>
            </View>
            <View style={styles.contactInfo}>
              <Text style={styles.contactName}>{item.displayName || item.username}</Text>
              <Text style={styles.contactUsername}>@{item.username}</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color="#94a3b8" />
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>👥</Text>
            <Text style={styles.emptyTitle}>連絡先がありません</Text>
            <Text style={styles.emptyDescription}>ユーザーを検索して連絡先に追加しましょう</Text>
          </View>
        }
      />

      <TouchableOpacity style={styles.fab} onPress={() => router.push('/(app)/contacts/search')}>
        <Ionicons name="person-add-outline" size={28} color="white" />
      </TouchableOpacity>
    </View>
  );
}
