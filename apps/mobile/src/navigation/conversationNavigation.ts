import { CommonActions, createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();
type Destination = RootStackParamList['Chat'];
type Navigator = Pick<typeof navigationRef, 'isReady' | 'getRootState' | 'dispatch'>;

/** Keep the latest explicit tap until login, onboarding and navigation finish. */
export class ConversationNavigationQueue {
  private pending: Destination | null = null;

  open(destination: Destination, ref: Navigator) {
    if (!destination.conversationId.trim()) return;
    this.pending = destination;
    this.flush(ref);
  }

  flush(ref: Navigator) {
    if (!this.pending || !ref.isReady()) return;
    const root = ref.getRootState();
    if (root?.routes[root.index]?.name !== 'Main') return;
    const destination = this.pending;
    this.pending = null;
    ref.dispatch(CommonActions.navigate({
      name: 'Main',
      params: { screen: 'ChatsTab', params: { screen: 'Chat', params: destination } },
    }));
  }
}

const queue = new ConversationNavigationQueue();
export const openConversation = (destination: Destination) => queue.open(destination, navigationRef);
export const flushConversationNavigation = () => queue.flush(navigationRef);
