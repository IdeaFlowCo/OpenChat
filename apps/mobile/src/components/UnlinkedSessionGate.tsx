import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useChat } from '../contexts/ChatContext';
import { setSession } from '../api/client';
import { getSocket } from '../api/socket';
import { isEmbedSessionMessage, UNLINKED_ORIGIN } from '../services/unlinkedEmbed';

/** Credentials travel by an origin- and window-bound handshake, never in URLs. */
export function UnlinkedSessionGate({ active = false }: { active?: boolean }) {
  const { bootstrapIfAuthed, signOut, currentUser } = useChat();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false, busy = false;
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-');
    const timeout = setTimeout(() => { if (!active) setFailed(true); }, 15000);
    const receive = async (event: MessageEvent) => {
      if (event.origin === UNLINKED_ORIGIN && event.source === window.parent && event.data?.nonce === nonce && event.data?.type === 'unlinked:unavailable') {
        if (active) await signOut({ explicit: false });
        setFailed(true); return;
      }
      if (!isEmbedSessionMessage(event, nonce) || disposed || busy) return;
      if (active && currentUser?.userId !== event.data.user.userId) { window.location.reload(); return; }
      busy = true;
      try {
        await setSession(event.data.token, event.data.user);
        if (!active) await bootstrapIfAuthed();
        else {
          // A backgrounded tab may resume after its old socket token expired.
          // Reuse the context-owned socket; its auth callback reads this token.
          const socket = getSocket();
          if (socket && !socket.connected) socket.connect();
        }
        clearTimeout(timeout);
        if (!disposed) setFailed(false);
        window.parent.postMessage({ type: 'openchat:connected', nonce }, UNLINKED_ORIGIN);
      } catch { if (!disposed) setFailed(true); }
      finally { busy = false; }
    };
    const request = () => window.parent.postMessage({ type: 'openchat:ready', nonce }, UNLINKED_ORIGIN);
    window.addEventListener('message', receive);
    request();
    const refresh = setInterval(request, 4 * 60000);
    return () => { disposed = true; clearTimeout(timeout); clearInterval(refresh); window.removeEventListener('message', receive); };
  }, [active, attempt, bootstrapIfAuthed, signOut, currentUser?.userId]);
  if (active) return null;
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: '#f5f6fc', padding: 24 }}>
    {!failed && <ActivityIndicator color="#4349c4" />}
    <Text accessibilityRole="header" style={{ fontSize: 18, color: '#16181d', fontWeight: '600' }}>{failed ? 'Messages couldn’t connect' : 'Opening your inbox…'}</Text>
    {failed && <Pressable accessibilityRole="button" onPress={() => { setFailed(false); setAttempt(value => value + 1); }} style={{ padding: 12 }}><Text style={{ color: '#4349c4' }}>Try again</Text></Pressable>}
  </View>;
}
