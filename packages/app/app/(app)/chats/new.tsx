/**
 * 新規DM作成画面
 * ユーザー検索・選択 → チャット開始
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/auth';
import { usersApi } from '@/services/api';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#1e293b' },
  searchContainer: { padding: 12 },
  searchInput: {
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: '#1e293b',
  },
  loading: { padding: 24, justifyContent: 'center', alignItems: 'center' },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#64748b', marginTop: 12, fontSize: 16 },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#e2e8f0' },
  avatarText: { color: '#64748b', textAlign: 'center', fontSize: 16 },
  userInfo: { flex: 1, marginLeft: 12 },
  userName: { fontSize: 16, fontWeight: '600', color: '#1e293b' },
  userUsername: { fontSize: 14, color: '#64748b' },
  startButton: {
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  startButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },
});

interface UserResult {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

export default function NewDM() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserResult[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (text: string) => {
    setQuery(text);
    if (!text.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const users = await usersApi.search(text);
      setResults(users.filter((u) => u.id !== user?.id));
    } catch (err) {
      console.error('[NewDM] 検索失敗:', err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (otherUser: UserResult) => {
    router.push(`/(app)/chats/${otherUser.id}`);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>新しいメッセージ</Text>
      </View>

      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="ユーザー名で検索"
          value={query}
          onChangeText={handleSearch}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : results.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="search-outline" size={48} color="#cbd5e1" />
          <Text style={styles.emptyText}>
            {query ? 'ユーザーが見つかりませんでした' : 'ユーザーを検索してください'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.userItem} onPress={() => handleSelect(item)}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.username.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName}>{item.displayName || item.username}</Text>
                <Text style={styles.userUsername}>@{item.username}</Text>
              </View>
              <TouchableOpacity style={styles.startButton} onPress={() => handleSelect(item)}>
                <Text style={styles.startButtonText}>チャット開始</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}
