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
 *   - <ChatScreen conversationId={...} embedded /> — the same full-feature
 *     screen mobile uses, parameterized to skip its native-stack header
 *     (OpenChat-601.2)
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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { OPENCHAT_URL } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { useSocialExperience } from '../contexts/SocialExperienceContext';
import { getColors } from '../theme/colors';
import { ConversationList } from './ConversationList';
import { AppIcon } from './AppIcon';
import { AgentOverlayButton } from './AgentOverlayButton';
import { ConnectionStatusLine } from './ConnectionStatusLine';
// The wide /app/ pane renders the same ChatScreen as the compact layout — with full
// feature parity (voice / preview / transform / forwarding / reactions /
// edit / delete / mentions / attachments / read receipts / pagination).
// Pass embedded=true so it doesn't try to configure a stack header
// (MasterDetailLayout owns the chrome). OpenChat-601.2.
import { ChatScreen } from '../screens/ChatScreen';
import { AgentOverlayScreen } from '../screens/AgentOverlayScreen';
import type { NavProp } from '../navigation/types';

const SIDEBAR_WIDTH_EXPANDED = 320;
const SIDEBAR_WIDTH_COLLAPSED = 56;
const SIDEBAR_ANIM_MS = 160;
const STORAGE_KEY = 'openchat_sidebar_collapsed';

/**
 * Hover-aware icon button for the desktop sidebar header (desktop-ux-audit).
 *
 * The previous inline Pressables had no hover feedback and a small click
 * target (~24px tall) — fine for touch, but on desktop web with a mouse you
 * couldn't tell the cog / search / + were clickable until you clicked. This
 * gives them a 32px-min target, a pointer cursor, and a surfaceElevated
 * hover wash (light + dark safe). `title` is the native browser tooltip.
 */
function IconButton({
  onPress, title, accessibilityLabel, hoverBg, children,
}: {
  onPress: () => void;
  title: string;
  accessibilityLabel: string;
  hoverBg: string;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={Platform.OS === 'web' ? () => setHovered(true) : undefined}
      onHoverOut={Platform.OS === 'web' ? () => setHovered(false) : undefined}
      // @ts-ignore — title is a web-only DOM attr; RN-web passes through.
      title={title}
      accessibilityLabel={accessibilityLabel}
      style={[styles.iconBtn, hovered ? { backgroundColor: hoverBg } : null]}
    >
      {children}
    </Pressable>
  );
}

export function MasterDetailLayout() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'Conversations'>>();
  const { enhanced } = useSocialExperience();
  const {
    currentUser, isConnected, activeConversationId, setActiveConversation,
    conversationsLoaded, refreshConversations, conversations,
  } = useChat();

  // Keep the latest list + active id in refs so the keydown handler (bound
  // once) can read current values for arrow-key navigation without
  // re-registering the DOM listener on every conversation update.
  const conversationsRef = useRef(conversations);
  const activeIdRef = useRef(activeConversationId);
  conversationsRef.current = conversations;
  activeIdRef.current = activeConversationId;

  const [collapsed, setCollapsed] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
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
  const openAgentOverlay = useCallback(() => setAgentPanelOpen(true), []);
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
      // Arrow-key conversation navigation (Up/Down move the selection through
      // the sidebar list; wraps at the ends). Skip when focus is inside a
      // text input / textarea / contentEditable so arrows keep their normal
      // caret-movement behavior in the composer and search box.
      if (!meta && (key === 'ArrowDown' || key === 'ArrowUp')) {
        const state = navigation.getState?.();
        const routes = state?.routes ?? [];
        const top = routes[routes.length - 1]?.name;
        if (top && top !== 'Conversations') return;

        const target = ev.target as HTMLElement | null;
        const tag = target?.tagName;
        const isTyping =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          (target?.isContentEditable ?? false);
        if (isTyping) return;
        const list = conversationsRef.current;
        if (!list || list.length === 0) return;
        ev.preventDefault();
        const currentIdx = list.findIndex(cv => cv.id === activeIdRef.current);
        const delta = key === 'ArrowDown' ? 1 : -1;
        // From no selection: Down → first, Up → last. Otherwise step + wrap.
        const nextIdx =
          currentIdx === -1
            ? (delta === 1 ? 0 : list.length - 1)
            : (currentIdx + delta + list.length) % list.length;
        setActiveConversation(list[nextIdx].id);
        return;
      }
      if (key === 'Escape') {
        if (agentPanelOpen) {
          setAgentPanelOpen(false);
          return;
        }
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
  }, [openSearch, openNew, openSettings, openShortcuts, navigation, activeConversationId, agentPanelOpen, setActiveConversation]);

  useEffect(() => {
    if (!enhanced) setAgentPanelOpen(false);
  }, [enhanced]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Animated.View
        style={[
          styles.sidebar,
          { width: widthAnim, borderColor: c.border, backgroundColor: c.surface, opacity: storageReady ? 1 : 0 },
        ]}
      >
        {/* Back-to-home bar (OpenChat-601.1). Top-of-sidebar affordance
            so users in the master-detail view can always navigate back
            to the OpenChat home page (chat.globalbr.ai/). Collapses to a
            tiny icon when the sidebar is in icon-only mode. */}
        <Pressable
          onPress={() => void Linking.openURL(OPENCHAT_URL + '/')}
          // @ts-ignore — title is a web-only DOM attr; RN-web passes through.
          title="OpenChat home (chat.globalbr.ai)"
          accessibilityLabel="OpenChat home"
          style={[styles.homeBar, { borderColor: c.border }]}
        >
          {collapsed ? (
            <AppIcon name="reply" color={c.primary} size={16} />
          ) : (
            <>
              <View style={{ marginRight: 6 }}><AppIcon name="reply" color={c.primary} size={14} /></View>
              <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '500' }} numberOfLines={1}>
                chat.globalbr.ai
              </Text>
            </>
          )}
        </Pressable>
        {collapsed ? (
          // Compact (icon-only) header: just the expand toggle + a new-chat
          // button. Everything else is hidden — clicking the toggle restores
          // the full header.
          <View style={[styles.sidebarHeaderCompact, { borderColor: c.border }]}>
            <IconButton
              onPress={toggleCollapsed}
              title="Expand sidebar"
              accessibilityLabel="Expand sidebar"
              hoverBg={c.surfaceElevated}
            >
              <AppIcon name="chevron-right" color={c.primary} size={19} />
            </IconButton>
            <IconButton
              onPress={openNew}
              title="New conversation (⌘N)"
              accessibilityLabel="New conversation"
              hoverBg={c.surfaceElevated}
            >
              <AppIcon name="plus" color={c.primary} size={20} />
            </IconButton>
            {enhanced && <AgentOverlayButton color={c.primary} onPress={openAgentOverlay} size={19} />}
          </View>
        ) : (
          <View style={[styles.sidebarHeader, { borderColor: c.border }]}>
            <IconButton
              onPress={toggleCollapsed}
              title="Collapse sidebar"
              accessibilityLabel="Collapse sidebar"
              hoverBg={c.surfaceElevated}
            >
              <AppIcon name="chevron-left" color={c.primary} size={19} />
            </IconButton>
            <IconButton
              onPress={openSettings}
              title="Settings (⌘,)"
              accessibilityLabel="Settings"
              hoverBg={c.surfaceElevated}
            >
              <AppIcon name="settings" color={c.primary} size={19} strokeWidth={1.8} />
            </IconButton>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: c.textPrimary }}>Chats</Text>
              <ConnectionStatusLine
                account={currentUser?.email}
                connected={isConnected}
                connectedColor={c.presenceAvailable}
                disconnectedColor={c.presenceOffline}
                textColor={c.textSecondary}
                disconnectedLabel="connecting…"
              />
            </View>
            <IconButton
              onPress={openSearch}
              title="Search (⌘K)"
              accessibilityLabel="Search"
              hoverBg={c.surfaceElevated}
            >
              <AppIcon name="search" color={c.primary} size={19} />
            </IconButton>
            {enhanced && <AgentOverlayButton color={c.primary} onPress={openAgentOverlay} size={19} />}
            <IconButton
              onPress={openNew}
              title="New conversation (⌘N)"
              accessibilityLabel="New conversation"
              hoverBg={c.surfaceElevated}
            >
              <AppIcon name="plus" color={c.primary} size={20} />
            </IconButton>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <ConversationList
            activeId={activeConversationId}
            onSelect={setActiveConversation}
            onStartChat={openNew}
            compact={collapsed}
            onCreateStory={() => navigation.navigate('StoryComposer')}
            onOpenStory={(story) => navigation.navigate('StoryViewer', { story })}
            onOpenReview={() => navigation.navigate('SocialReview')}
          />
        </View>
      </Animated.View>

      <View style={[styles.detail, { backgroundColor: c.background }]}>
        {activeConversationId ? (
          <ChatScreen
            key={activeConversationId}
            conversationId={activeConversationId}
            embedded
            onOpenAgent={openAgentOverlay}
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
      {enhanced && agentPanelOpen && (
        <View
          style={[styles.agentPanel, { backgroundColor: c.background, borderLeftColor: c.border }]}
        >
          <AgentOverlayScreen
            embedded
            onClose={() => setAgentPanelOpen(false)}
            onOpenConversation={(conversationId) => {
              setActiveConversation(conversationId);
              setAgentPanelOpen(false);
            }}
          />
        </View>
      )}
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
    gap: 8,
  },
  sidebarHeaderCompact: {
    flexDirection: 'column',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  iconBtn: {
    minWidth: 36,
    minHeight: 36,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    // @ts-ignore — web-only: show a pointer so these read as clickable.
    cursor: 'pointer',
  },
  // Back-to-home bar at the top of the sidebar (OpenChat-601.1)
  homeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detail: { flex: 1 },
  agentPanel: { width: 420, maxWidth: '42%', borderLeftWidth: StyleSheet.hairlineWidth },
  emptyDetail: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
