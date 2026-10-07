import React from 'react';
import { useRoute } from '@react-navigation/native';
import { ContextLane } from '../components/ContextLane';
import type { RouteProps } from '../navigation/types';
/** Compatibility door: conversation Stream and Context use one audience-aware read. Personal Stream remains separate. */
export function ConversationThoughtsScreen() {
  const route = useRoute<RouteProps<'ConversationThoughts'>>();
  return <ContextLane conversationId={route.params.conversationId} />;
}
