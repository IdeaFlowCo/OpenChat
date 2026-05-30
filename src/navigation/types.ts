/**
 * Native-stack route params. Centralized so screens can import a single
 * type rather than redeclaring at each navigation.navigate() call site.
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

export type RootStackParamList = {
  Login: undefined;
  Conversations: undefined;
  Chat: { conversationId: string };
  NewConversation: undefined;
  GroupSettings: { conversationId: string };
};

export type NavProp<T extends keyof RootStackParamList> = NativeStackNavigationProp<RootStackParamList, T>;
export type RouteProps<T extends keyof RootStackParamList> = RouteProp<RootStackParamList, T>;
