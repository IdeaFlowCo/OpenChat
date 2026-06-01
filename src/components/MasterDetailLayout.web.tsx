/**
 * MasterDetailLayout — the side-by-side desktop view of OpenChat.
 *
 * Layout:
 *   [ 320px (or 56px collapsed) sidebar  ][ flex 1 chat pane ]
 *
 * The sidebar has its own header (title + connection dot + Settings cog +
 * Search + New Conversation buttons) so we don't depend on the native-stack
 * header (which native-stack hides for this route — see App.tsx).
 *
 * The right pane shows either:
 *   - an empty state ("Select a conversation"), or
 *   - <ChatPane showInlineHeader/> for the active conversation
 *
 * Active conversation lives in ChatContext (activeConversationId), set by
 * row press. Each switch remounts the pane via React's `key=` so the
 * useEffect-driven setActiveConversation cleanup runs cleanly per switch.
 *
 * Sidebar collapse (OpenChat-jvh):
 *   - A chevron button at the top toggles between 320 (expanded) and 56
 *     (icon-only) sidebar width. Smoothly animated via Animated.timing.
 *   - Preference persists in AsyncStorage under `openchat_sidebar_collapsed`.
 *   - Compact mode propagates to ConversationList (avatar-only rows) and
 *     hides the header title / email / action icons except the new-chat +
 *     toggle buttons.
 *
 * Web-only desktop affordances are wired here:
 *   - Cmd-K / Ctrl-K → opens Search
 *   - Cmd-N / Ctrl-N → opens NewConversation
 *   - Cmd-, / Ctrl-, → opens Settings
 *   - Cmd-/ / Ctrl-/ → opens KeyboardShortcuts cheat-sheet
 *   - Esc → if a modal is open it closes; else deselects the active
 *     conversation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
// Explicit .web imports — these files are web-only and never reached from
// native code paths. TypeScript needs the explicit extension because we
// don't enable `moduleSuffixes` globally (it breaks node_modules typings).
// Metro on web resolves identically; on native the dep graph never reaches
// these files because nothing in native code imports MasterDetailLayout.
import { ConversationList } from './ConversationList.web';
import { ChatPane } from './ChatPane.web';
import type { NavProp } from '../navigation/types';

const SIDEBAR_WIDTH_EXPANDED = 320;
const SIDEBAR_WIDTH_COLLAPSED = 56;
const SIDEBAR_ANIM_MS = 160;
const STORAGE_KEY = 'openchat_sidebar_collapsed';

export function MasterDetailLayout() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'Conversations'>>();
  const {
    currentUser, isConnected, activeConversationId, setActiveConversation,
    conversationsLoaded, refreshConversations,
  } = useChat();

  const [collapsed, setCollapsed] = useState(false);
  // Animated width — initialized to expanded; we'll snap (no animation) to
  // the persisted value on mount once we've read AsyncStorage, then any
  // subsequent toggles animate. Avoids a flash-of-expanded-then-collapsed.
  const widthAnim = useRef(new Animated.Value(SIDEBAR_WIDTH_EXPANDED)).current;
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    if (!conversationsLoaded) refreshConversations();
  }, [conversationsLoaded, refreshConversations]);

  // Hydrate persisted sidebar collapse state once. AsyncStorage works on
  // both native (RN) and web (localStorage shim), so this is platform-safe.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled) return;
        const isCollapsed = v === 'true';
        setCollapsed(isCollapsed);
        widthAnim.setValue(isCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED);
      } catch (err) {
        // Storage failure is non-fatal — default to expanded.
        console.warn('[MasterDetailLayout] sidebar collapse load failed:', err);
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [widthAnim]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      Animated.timing(widthAnim, {
        toValue: next ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        duration: SIDEBAR_ANIM_MS,
        // width isn't natively supported by useNativeDriver; on RN-web this
        // ends up as a JS-driven animation anyway, which is fine for this
        // short transition.
        useNativeDriver: false,
      }).start();
      AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false').catch(err => {
        console.warn('[MasterDetailLayout] sidebar collapse save failed:', err);
      });
      return next;
    });
  }, [widthAnim]);

  const openSearch = useCallback(() => navigation.navigate('Search'), [navigation]);
  const openNew = useCallback(() => navigation.navigate('NewConversation'), [navigation]);
  const openSettings = useCallback(() => navigation.navigate('Settings'), [navigation]);
  const openShortcuts = useCallback(() => navigation.navigate('KeyboardShortcuts'), [navigation]);
  const openGroupSettings = useCallback(
    (cid: string) => navigation.navigate('GroupSettings', { conversationId: cid }),
    [navigation]
  );

  // Keyboard shortcuts (web only). DOM listeners aren't available on native.
  // Listening on `document` (vs window) so the handler still fires when focus
  // is inside an iframe-mounted RN-web composer in some edge cases.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;
    const onKey = (ev: KeyboardEvent) => {
      const meta = ev.metaKey || ev.ctrlKey;
      const key = ev.key;

      if (meta && (key === 'k' || key === 'K')) {
        ev.preventDefault();
        openSearch();
        return;
      }
      // Cmd-N. Note: Cmd-N is a browser shortcut for "new window" — most
      // browsers don't allow JS to intercept it. We preventDefault best-effort
      // (works in Electron / some browsers) and also accept Cmd-Shift-O as a
      // reliable alternative.
      if (meta && (key === 'n' || key === 'N')) {
        ev.preventDefault();
        openNew();
        return;
      }
      if (meta && ev.shiftKey && (key === 'o' || key === 'O')) {
        ev.preventDefault();
        openNew();
        return;
      }
      if (meta && key === ',') {
        ev.preventDefault();
        openSettings();
        return;
      }
      if (meta && key === '/') {
        ev.preventDefault();
        openShortcuts();
        return;
      }
      if (key === 'Escape') {
        // If a modal is open (NewConv/Settings/Search/GroupSettings/Shortcuts),
        // close it. Else deselect the active conversation.
        const state = navigation.getState?.();
        const routes = state?.routes ?? [];
        const top = routes[routes.length - 1]?.name;
        if (top && top !== 'Conversations') {
          navigation.goBack();
          return;
        }
        if (activeConversationId) {
          setActiveConversation(null);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openSearch, openNew, openSettings, openShortcuts, navigation, activeConversationId, setActiveConversation]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Animated.View
        style={[
          styles.sidebar,
          { width: widthAnim, borderColor: c.border, backgroundColor: c.surface, opacity: storageReady ? 1 : 0 },
        ]}
      >
        {collapsed ? (
          // Compact (icon-only) header: just the expand toggle + a new-chat
          // button. Everything else is hidden — clicking the toggle restores
          // the full header.
          <View style={[styles.sidebarHeaderCompact, { borderColor: c.border }]}>
            <Pressable
              onPress={toggleCollapsed}
              // @ts-ignore — title is a web-only DOM attr; RN-web passes through.
              title="Expand sidebar"
              style={styles.iconBtn}
              accessibilityLabel="Expand sidebar"
            >
              <Text style={{ color: c.primary, fontSize: 18 }}>›</Text>
            </Pressable>
            <Pressable
              onPress={openNew}
              // @ts-ignore
              title="New conversation (⌘N)"
              style={styles.iconBtn}
              accessibilityLabel="New conversation"
            >
              <Text style={{ color: c.primary, fontSize: 22, lineHeight: 22, fontWeight: '300' }}>＋</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.sidebarHeader, { borderColor: c.border }]}>
            <Pressable
              onPress={toggleCollapsed}
              // @ts-ignore
              title="Collapse sidebar"
              style={styles.iconBtn}
              accessibilityLabel="Collapse sidebar"
            >
              <Text style={{ color: c.primary, fontSize: 18 }}>‹</Text>
            </Pressable>
            <Pressable
              onPress={openSettings}
              // @ts-ignore
              title="Settings (⌘,)"
              style={styles.iconBtn}
              accessibilityLabel="Settings"
            >
              <Text style={{ color: c.primary, fontSize: 20 }}>⚙︎</Text>
            </Pressable>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: c.textPrimary }}>Chats</Text>
              <Text style={{ fontSize: 11, color: c.textSecondary }} numberOfLines={1}>
                {currentUser?.email}  ·  {isConnected ? '🟢 connected' : '⚪ connecting…'}
              </Text>
            </View>
            <Pressable
              onPress={openSearch}
              // @ts-ignore
              title="Search (⌘K)"
              style={styles.iconBtn}
              accessibilityLabel="Search"
            >
              <Text style={{ color: c.primary, fontSize: 18 }}>🔍</Text>
            </Pressable>
            <Pressable
              onPress={openNew}
              // @ts-ignore
              title="New conversation (⌘N)"
              style={styles.iconBtn}
              accessibilityLabel="New conversation"
            >
              <Text style={{ color: c.primary, fontSize: 26, lineHeight: 26, fontWeight: '300' }}>＋</Text>
            </Pressable>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <ConversationList
            activeId={activeConversationId}
            onSelect={setActiveConversation}
            onStartChat={openNew}
            compact={collapsed}
          />
        </View>
      </Animated.View>

      <View style={[styles.detail, { backgroundColor: c.background }]}>
        {activeConversationId ? (
          <ChatPane
            key={activeConversationId}
            conversationId={activeConversationId}
            showInlineHeader
            onOpenGroupSettings={openGroupSettings}
          />
        ) : (
          <View style={styles.emptyDetail}>
            <Text style={{ color: c.textPrimary, fontSize: 22, fontWeight: '600', marginBottom: 6 }}>
              OpenChat
            </Text>
            <Text style={{ color: c.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 32 }}>
              Select a conversation from the sidebar, or press ⌘K to search.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  sidebar: {
    borderRightWidth: StyleSheet.hairlineWidth,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  sidebarHeaderCompact: {
    flexDirection: 'column',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  iconBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  detail: { flex: 1 },
  emptyDetail: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
