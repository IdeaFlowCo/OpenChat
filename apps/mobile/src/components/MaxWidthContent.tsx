/**
 * MaxWidthContent — reusable layout wrapper that caps content width and
 * centers it horizontally within its parent. Used in the wide /app/ layout
 * so chat bubbles, composers, and similar content don't stretch edge-to-
 * edge on wide monitors (1920+ px). On narrower screens (mobile/tablet),
 * the maxWidth never binds and behavior is identical to a plain View.
 *
 * The standard chat-app pattern (Slack, Discord, iMessage on macOS, etc.)
 * is to bound the message column to ~700-760px wide. We use 720 — wide
 * enough that most messages flow naturally, narrow enough that long lines
 * remain comfortably readable on a 27" 1920px monitor.
 */

import { StyleProp, View, ViewStyle } from 'react-native';
import { ReactNode } from 'react';

export const MAX_CONTENT_WIDTH = 720;

interface Props {
  children: ReactNode;
  /** Optional extra style applied to the wrapper. */
  style?: StyleProp<ViewStyle>;
}

export function MaxWidthContent({ children, style }: Props) {
  return (
    <View style={[{ maxWidth: MAX_CONTENT_WIDTH, width: '100%', alignSelf: 'center' }, style]}>
      {children}
    </View>
  );
}
