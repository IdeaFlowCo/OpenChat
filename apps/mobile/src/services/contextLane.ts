import { api, ContextPost } from '../api/client';
import { logError } from './clientLogger';

export interface ContextLaneState {
  posts: ContextPost[];
  hasMore: boolean;
  nextCursor?: string;
  isLoading: boolean;
  isError: boolean;
  search: string;
}
const empty = (): ContextLaneState => ({ posts: [], hasMore: true, isLoading: false, isError: false, search: '' });
type Subscriber = (state: ContextLaneState) => void;
const unique = (posts: ContextPost[]) => [...new Map(posts.map(p => [p.id, p])).values()];

export class ContextLaneManager {
  private account: string | null = null;
  private generation = 0;
  private requests = new Map<string, number>();
  private stateByConversation = new Map<string, ContextLaneState>();
  private subscribers = new Map<string, Set<Subscriber>>();

  setAccount(account: string | null) {
    if (this.account === account) return;
    this.account = account;
    this.clearAll();
  }
  subscribe(conversationId: string, fn: Subscriber) {
    if (!this.subscribers.has(conversationId)) this.subscribers.set(conversationId, new Set());
    this.subscribers.get(conversationId)!.add(fn);
    fn(this.getState(conversationId));
    return () => { this.subscribers.get(conversationId)?.delete(fn); };
  }
  getState(conversationId: string): ContextLaneState {
    return this.stateByConversation.get(conversationId) || empty();
  }
  private setState(id: string, patch: Partial<ContextLaneState>) {
    const next = { ...this.getState(id), ...patch };
    this.stateByConversation.set(id, next);
    this.subscribers.get(id)?.forEach(fn => fn(next));
  }
  async loadInitial(id: string, search = this.getState(id).search) {
    const previous = this.getState(id);
    const generation = this.generation;
    const request = (this.requests.get(id) || 0) + 1;
    this.requests.set(id, request);
    this.setState(id, { isLoading: true, isError: false, search, ...(search !== previous.search ? { posts: [], nextCursor: undefined } : {}) });
    try {
      const res = await api.listContextPosts(id, undefined, undefined, undefined, search);
      if (generation !== this.generation || request !== this.requests.get(id)) return;
      this.setState(id, { isLoading: false, posts: unique(res.posts), hasMore: !!res.nextCursor, nextCursor: res.nextCursor });
    } catch (e: any) {
      if (generation !== this.generation || request !== this.requests.get(id)) return;
      logError('Failed to refresh context', e, { conversationId: id });
      this.setState(id, { isLoading: false, isError: true, ...(e.status === 401 || e.status === 403 ? { posts: [], nextCursor: undefined, hasMore: false } : {}) });
    }
  }
  async loadMore(id: string) {
    const state = this.getState(id);
    if (state.isLoading || !state.hasMore || !state.nextCursor) return;
    const generation = this.generation;
    const request = (this.requests.get(id) || 0) + 1;
    this.requests.set(id, request);
    this.setState(id, { isLoading: true, isError: false });
    try {
      const res = await api.listContextPosts(id, state.nextCursor, undefined, undefined, state.search);
      if (generation !== this.generation || request !== this.requests.get(id)) return;
      this.setState(id, { isLoading: false, posts: unique([...this.getState(id).posts, ...res.posts]), hasMore: !!res.nextCursor, nextCursor: res.nextCursor });
    } catch (e: any) {
      if (generation !== this.generation || request !== this.requests.get(id)) return;
      logError('Failed to load more context', e, { conversationId: id });
      this.setState(id, { isLoading: false, isError: true, ...(e.status === 401 || e.status === 403 ? { posts: [], nextCursor: undefined, hasMore: false } : {}) });
    }
  }
  private replace(id: string, post: ContextPost) {
    // A completed mutation invalidates older reads so they cannot erase its result.
    this.requests.set(id, (this.requests.get(id) || 0) + 1);
    const state = this.getState(id);
    const posts = state.posts.filter(p => p.id !== post.id);
    if (!state.search || post.text.toLowerCase().includes(state.search.toLowerCase())) posts.push(post);
    posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    this.setState(id, { posts, isLoading: false });
  }
  async addPost(id: string, text: string, clientRequestId: string, kind?: string, replyToId?: string) {
    const generation = this.generation;
    const post = await api.createContextPost(id, text, clientRequestId, kind, replyToId);
    if (generation === this.generation) this.replace(id, post);
    return post;
  }
  async updatePost(id: string, postId: string, text: string, expectedRevision: number) {
    const generation = this.generation;
    const post = await api.updateContextPost(id, postId, text, expectedRevision);
    if (generation === this.generation) this.replace(id, post);
    return post;
  }
  async deletePost(id: string, postId: string) {
    const generation = this.generation;
    await api.deleteContextPost(id, postId);
    if (generation !== this.generation) return;
    const old = this.getState(id).posts.find(p => p.id === postId);
    if (old) this.replace(id, { ...old, text: '', isDeleted: true });
    await this.loadInitial(id);
  }
  clear(id: string) {
    this.requests.set(id, (this.requests.get(id) || 0) + 1);
    this.stateByConversation.delete(id);
    this.subscribers.get(id)?.forEach(fn => fn(empty()));
  }
  clearAll() {
    this.generation++;
    this.stateByConversation.clear();
    this.requests.clear();
    this.subscribers.forEach(fns => fns.forEach(fn => fn(empty())));
  }
}
export const contextLaneManager = new ContextLaneManager();
