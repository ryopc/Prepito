/**
 * DMチャット画面
 * E2E暗号化メッセージの送受信
 * ルート: /(app)/chats/[conversationId]
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDMStore } from '@/store/dm';
import { useAuthStore } from '@/store/auth';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  headerLeft: { flex: 1 },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#1e293b' },
  headerSubtitle: { fontSize: 13, color: '#64748b' },
  messagesContainer: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  contentContainer: { paddingBottom: 100 },
  messageBubble: {
    maxWidth: '80%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    marginBottom: 8,
  },
  messageBubbleOutgoing: { backgroundColor: '#dbeafe', alignSelf: 'flex-end' },
  messageBubbleIncoming: {
    backgroundColor: '#ffffff',
    alignSelf: 'flex-start',
    borderColor: '#e2e8f0',
    borderWidth: 1,
  },
  messageText: { fontSize: 15, color: '#1e293b', lineHeight: 22 },
  messageTextOutgoing: { color: '#1e3a8a' },
  messageTextIncoming: { color: '#1e293b' },
  messageTextUndecryptable: { color: '#94a3b8', fontStyle: 'italic' },
  messageTime: { fontSize: 11, color: '#94a3b8', marginTop: 4, alignSelf: 'flex-end' },
  messageTimeIncoming: { fontSize: 11, color: '#94a3b8', marginTop: 4, alignSelf: 'flex-start' },
  statusText: { fontSize: 10, color: '#94a3b8', marginTop: 2, alignSelf: 'flex-end' },
  inputContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 12,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  input: {
    flex: 1,
    backgroundColor: '#f1f5f9',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1e293b',
    minHeight: 44,
  },
  sendButton: {
    backgroundColor: '#0ea5e9',
    borderRadius: 22,
    padding: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyText: { color: '#64748b', fontSize: 16 },
  errorText: { color: '#ef4444', fontSize: 13, marginBottom: 8, textAlign: 'center' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});

interface ChatScreenProps {
  params: { conversationId: string };
}

export default function ChatScreen({ params }: ChatScreenProps) {
  const { conversationId } = params;
  const router = useRouter();
  const { user } = useAuthStore();

  const {
    messages,
    messagesLoading,
    error,
    fetchThreads,
    fetchMessages,
    sendMessage,
    setActiveConversation,
    markAsRead,
    clearError,
  } = useDMStore();

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    setActiveConversation(conversationId);
    if (user) {
      fetchMessages(conversationId, conversationId);
      fetchThreads();
      markAsRead(conversationId);
    }
    return () => {
      setActiveConversation(null);
    };
  }, [conversationId, user, fetchMessages, fetchThreads, setActiveConversation, markAsRead]);

  // メッセージ送信
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !user) return;

    setSending(true);
    clearError();
    setInputText('');

    try {
      await sendMessage(conversationId, conversationId, text);
    } catch (err) {
      Alert.alert('送信エラー', err instanceof Error ? err.message : '不明なエラー');
    } finally {
      setSending(false);
    }
  }, [inputText, user, conversationId, sendMessage, clearError]);

  // スクロールを最下部へ
  const scrollToBottom = useCallback(() => {
    flatListRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  if (!user) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerLeft}>
          <Ionicons name="chevron-back-outline" size={24} color="#64748b" />
        </TouchableOpacity>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>@{conversationId}</Text>
          <Text style={styles.headerSubtitle}>
            {messages.length > 0 ? `${messages.length}通` : ''}
          </Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      <View style={styles.messagesContainer}>
        {messagesLoading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" />
          </View>
        )}
        {messages.length === 0 && !messagesLoading && (
          <View style={styles.empty}>
            <Ionicons name="chatbubbles-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>メッセージを送信して会話を始めましょう</Text>
          </View>
        )}
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.localId || item.id}
          renderItem={({ item }) => {
            const isOutgoing = item.isOutgoing;
            const time = new Date(item.createdAt).toLocaleTimeString('ja-JP', {
              hour: '2-digit',
              minute: '2-digit',
            });
            return (
              <View style={{ flexDirection: isOutgoing ? 'row-reverse' : 'row', marginBottom: 10 }}>
                <View
                  style={[
                    styles.messageBubble,
                    isOutgoing ? styles.messageBubbleOutgoing : styles.messageBubbleIncoming,
                  ]}
                >
                  <Text
                    style={[
                      styles.messageText,
                      isOutgoing ? styles.messageTextOutgoing : styles.messageTextIncoming,
                      item.decryptionFailed && styles.messageTextUndecryptable,
                    ]}
                  >
                    {item.decryptionFailed ? '⚠️ 復号できないメッセージ' : item.plaintext}
                  </Text>
                  <Text style={isOutgoing ? styles.statusText : styles.messageTimeIncoming}>
                    {time}{' '}
                    {item.status === 'sending' ? '送信中…' : item.status === 'failed' ? '失敗' : ''}
                  </Text>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={null}
          contentContainerStyle={styles.contentContainer}
        />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.inputContainer}
      >
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="メッセージを入力…"
            multiline={false}
            maxLength={1000}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            editable={!sending}
          />
          <TouchableOpacity
            style={styles.sendButton}
            onPress={handleSend}
            disabled={!inputText.trim() || sending}
          >
            <Ionicons name={sending ? 'reload-circle' : 'send-outline'} size={20} color="#ffffff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
