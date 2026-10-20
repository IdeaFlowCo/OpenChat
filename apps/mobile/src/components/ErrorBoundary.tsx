/**
 * React error boundary (openchat-dwk).
 *
 * Until this existed, a single render-phase throw anywhere in the tree was a
 * *fatal* event: React unmounts the whole tree, and in a release build the
 * ExceptionsManager escalates the unhandled exception to `RCTFatal` → SIGABRT,
 * so the app terminates rather than degrading. That is exactly how installed
 * iOS v0.1.24 binaries died on `p.user.email.split('@')` when the server
 * stopped sending `email` — see `privacy/legacyEmailCompat.ts` on the server.
 *
 * `installClientLogger()`'s global handlers do NOT cover render errors, so this
 * is also the only way such a throw reaches `/api/client-logs`.
 *
 * Wrap the app root once, and wrap any list row whose data comes from the
 * server, so one malformed item degrades to a placeholder instead of blanking
 * the list.
 */

import { Component, ErrorInfo, ReactNode, useState } from 'react';
import { Appearance, ScrollView, StyleSheet, Text, TouchableOpacity } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { logError } from '../services/clientLogger';
import { getColors } from '../theme/colors';
import { radius, space, touchTarget, type } from '../theme/tokens';

interface Props {
  children?: ReactNode;
  /** Identifies the boundary in logs, e.g. `app-root` or `chat-message`. */
  scope: string;
  /**
   * Alternative to `children` for content produced by a function, such as a
   * FlatList row builder. Use this rather than `{buildRow(item)}`: a boundary
   * only catches throws from its *descendants*, and `{buildRow(item)}` runs in
   * the parent's render, so the throw would sail straight past. Passing the
   * function lets us invoke it inside a child component instead.
   */
  render?: () => ReactNode;
  /** Compact/custom fallback. Receives the error and a retry callback. */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  /**
   * Clears a caught error whenever this value changes, so navigating away from
   * (or re-keying) the broken content recovers without a relaunch.
   */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
}

/** Anything can be thrown in JS; normalize so the fallback always has a message. */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new Error(typeof thrown === 'string' ? thrown : JSON.stringify(thrown) ?? 'Unknown error');
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(thrown: unknown): State {
    return { error: toError(thrown) };
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    // Never let reporting throw — that would re-enter the boundary.
    try {
      logError(`Render error in ${this.props.scope}`, thrown, {
        scope: this.props.scope,
        componentStack: info?.componentStack ?? undefined,
      });
    } catch {
      /* reporting is best-effort */
    }
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.retry);
      return <AppErrorFallback error={error} scope={this.props.scope} onRetry={this.retry} />;
    }
    if (this.props.render) return <RenderSlot render={this.props.render} />;
    return this.props.children;
  }
}

/**
 * Module-scope so its identity is stable across renders (a component defined
 * inline would remount its subtree every time). Exists purely to move a
 * `render()` call into the boundary's child subtree, where throws are caught.
 */
function RenderSlot({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

/**
 * Default full-screen fallback. Deliberately reads the OS scheme directly
 * rather than `useTheme()`: the boundary must still render if the thing that
 * threw was a context provider.
 */
function AppErrorFallback({ error, scope, onRetry }: { error: Error; scope: string; onRetry: () => void }) {
  const c = getColors(Appearance.getColorScheme?.() ?? 'light');
  const [copyStatus, setCopyStatus] = useState('');
  const copyError = async () => {
    try {
      const copied = await Clipboard.setStringAsync(
        `OpenChat error (${scope})\n${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}`,
      );
      setCopyStatus(copied === false ? 'Could not copy. Select the error text to copy it.' : 'Error copied.');
    } catch {
      setCopyStatus('Could not copy. Select the error text to copy it.');
    }
  };
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.screen}>
      <Text style={[styles.title, { color: c.textPrimary }]}>Something went wrong</Text>
      <Text style={[styles.body, { color: c.textMetadata }]}>
        OpenChat hit an unexpected error and stopped drawing this screen. Your messages are
        safe — the problem has been reported.
      </Text>
      <Text selectable style={[styles.detail, { color: c.textMetadata }]}>
        {error.message}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Copy error"
        accessibilityHint="Copies the error message and technical details to the clipboard."
        onPress={() => { void copyError(); }}
        style={[styles.button, { backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}
      >
        <Text style={[styles.buttonLabel, { color: c.textPrimary }]}>Copy error</Text>
      </TouchableOpacity>
      {!!copyStatus && <Text accessibilityLiveRegion="polite" style={[styles.body, { color: c.textMetadata }]}>{copyStatus}</Text>}
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onRetry}
        style={[styles.button, { backgroundColor: c.primary }]}
      >
        <Text style={[styles.buttonLabel, { color: c.onPrimary }]}>Try again</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: space[8], gap: space[3] },
  title: { ...type.heading },
  body: { ...type.body, textAlign: 'center' },
  detail: { ...type.meta, textAlign: 'center' },
  button: { minHeight: touchTarget, justifyContent: 'center', marginTop: space[2], paddingHorizontal: space[5], paddingVertical: space[3], borderRadius: radius.md },
  buttonLabel: { ...type.bodyStrong },
});
