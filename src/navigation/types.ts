/**
 * Route params. Centralized so screens can import a single type rather than
 * redeclaring at each navigation.navigate() call site.
 *
 * The app uses a bottom-tab navigator (Chats / Thoughts) wrapping native stacks.
 * The types below cover all screens across both tabs.
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { Thought } from '../api/client';

// ── Bottom-tab navigator ─────────────────────────────────────────────────────
export type TabParamList = {
  ChatsTab: undefined;
  ThoughtsTab: undefined;
};

// ── Chats stack (all pre-existing screens) ───────────────────────────────────
export type RootStackParamList = {
  Login: undefined;
  Onboarding: undefined;
  Conversations: undefined;
  Chat: { conversationId: string };
  NewConversation: undefined;
  GroupSettings: { conversationId: string };
  Settings: undefined;
  Search: undefined;
  MyQrCode: undefined;
  ScanQr: undefined;
  /** Blocked users management screen (OpenChat-46p). */
  BlockedUsers: undefined;
  /** Profile editing screen (OpenChat-tml). */
  ProfileEdit: undefined;
  /** Group invite modal — owner can generate / copy / revoke invite (OpenChat-240). */
  GroupInvite: { conversationId: string };
  /** Group invite preview — shown after scanning a QR or opening an invite link (OpenChat-240). */
  GroupInvitePreview: { token: string };
  /** Forward picker — select conversation to forward a message into (OpenChat-hhc). */
  ForwardPicker: { messageId: string };
};

// ── Thoughts stack (OpenChat-zi1) ─────────────────────────────────────────────
export type ThoughtsStackParamList = {
  ThoughtsList: undefined;
  /** Add / edit a thought. When `thought` is provided it's edit mode. */
  AddEditThought: { thought?: Thought } | undefined;
};

export type NavProp<T extends keyof RootStackParamList> = NativeStackNavigationProp<RootStackParamList, T>;
export type RouteProps<T extends keyof RootStackParamList> = RouteProp<RootStackParamList, T>;

export type ThoughtsNavProp<T extends keyof ThoughtsStackParamList> = NativeStackNavigationProp<ThoughtsStackParamList, T>;
export type ThoughtsRouteProps<T extends keyof ThoughtsStackParamList> = RouteProp<ThoughtsStackParamList, T>;
