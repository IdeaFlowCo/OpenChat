import { api, ContextPost } from '../api/client';
import { clearSession } from '../api/client';
import { logError } from './clientLogger';

export interface ContextLaneState {
  posts: ContextPost[];
  hasMore: boolean;
  nextCursor?: string;
  isLoading: boolean;
  isError: boolean;
}

const DEFAULT_STATE: ContextLaneState = {
  posts: [],
  hasMore: true,
  isLoading: false,
  isError: false,
};

type Subscriber = (state: ContextLaneState) => void;

class ContextLaneManager {
  private stateByConversation = new Map<string, ContextLaneState>();
  private subscribers = new Map<string, Set<Subscriber>>();

  subscribe(conversationId: string, fn: Subscriber) {
    if (!this.subscribers.has(conversationId)) {
      this.subscribers.set(conversationId, new Set());
    }
    this.subscribers.get(conversationId)!.add(fn);
    return () => {
      this.subscribers.get(conversationId)?.delete(fn);
    };
  }

  getState(conversationId: string): ContextLaneState {
    return this.stateByConversation.get(conversationId) || { ...DEFAULT_STATE };
  }

  private setState(conversationId: string, newState: Partial<ContextLaneState>) {
    const current = this.getState(conversationId);
    const updated = { ...current, ...newState };
    this.stateByConversation.set(conversationId, updated);
    this.notify(conversationId, updated);
  }

  private notify(conversationId: string, state: ContextLaneState) {
    const subs = this.subscribers.get(conversationId);
    if (subs) {
      subs.forEach((fn) => fn(state));
    }
  }

  async loadInitial(conversationId: string) {
    if (this.getState(conversationId).isLoading) return;
    this.setState(conversationId, { isLoading: true, isError: false, posts: [], hasMore: true, nextCursor: undefined });
    try {
      const res = await api.listContextPosts(conversationId);
      this.setState(conversationId, {
        isLoading: false,
        posts: res.posts,
        hasMore: !!res.nextCursor,
        nextCursor: res.nextCursor,
      });
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) {
        this.clear(conversationId);
      }
      logError('Failed to load initial context lane', e, { conversationId });
      this.setState(conversationId, { isLoading: false, isError: true });
    }
  }

  async loadMore(conversationId: string) {
    const state = this.getState(conversationId);
    if (state.isLoading || !state.hasMore || !state.nextCursor) return;
    
    this.setState(conversationId, { isLoading: true, isError: false });
    try {
      const res = await api.listContextPosts(conversationId, state.nextCursor);
      this.setState(conversationId, {
        isLoading: false,
        posts: [...state.posts, ...res.posts],
        hasMore: !!res.nextCursor,
        nextCursor: res.nextCursor,
      });
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) {
        this.clear(conversationId);
      }
      logError('Failed to load more context posts', e, { conversationId });
      this.setState(conversationId, { isLoading: false, isError: true });
    }
  }

  async addPost(conversationId: string, text: string, clientRequestId: string, kind?: string) {
    const res = await api.createContextPost(conversationId, text, clientRequestId, kind);
    const state = this.getState(conversationId);
    this.setState(conversationId, {
      posts: [res, ...state.posts], // Prepend to list (descending order)
    });
    return res;
  }

  async updatePost(conversationId: string, postId: string, text: string, expectedRevision: number) {
    const res = await api.updateContextPost(conversationId, postId, text, expectedRevision);
    const state = this.getState(conversationId);
    this.setState(conversationId, {
      posts: state.posts.map(p => p.id === postId ? res : p),
    });
    return res;
  }

  async deletePost(conversationId: string, postId: string) {
    await api.deleteContextPost(conversationId, postId);
    const state = this.getState(conversationId);
    this.setState(conversationId, {
      posts: state.posts.filter(p => p.id !== postId),
    });
  }

  clear(conversationId: string) {
    this.stateByConversation.delete(conversationId);
    this.notify(conversationId, { ...DEFAULT_STATE });
  }

  clearAll() {
    this.stateByConversation.clear();
    for (const [cid] of this.subscribers) {
      this.notify(cid, { ...DEFAULT_STATE });
    }
  }
}

export const contextLaneManager = new ContextLaneManager();
