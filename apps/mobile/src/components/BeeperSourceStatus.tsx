import { useCallback, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import { api, type BeeperReadConnection, type BeeperReadJob } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useImportedRoles } from './ImportedChatParts';
import { Button } from './ui';
import { beeperConnectionState, beeperFailure } from '../utils/beeperStatus';
import { space, type } from '../theme/tokens';
import type { NavProp, RootStackParamList } from '../navigation/types';

type Source = NonNullable<RootStackParamList['ImportedChat']['beeper']>;
export function BeeperSourceStatus({ source }: { source: Source }) {
  const { currentUser, isIdentityVerified } = useChat();
  const scope = isIdentityVerified && currentUser?.userId ? JSON.stringify([currentUser.userId, source.connectionId, source.chatKey, source.jobId]) : undefined;
  const live = useRef(scope); live.current = scope;
  return scope ? <SourceSession key={scope} source={source} isCurrent={() => live.current === scope} /> : null;
}
function SourceSession({ source, isCurrent }: { source: Source; isCurrent: () => boolean }) {
  const r = useImportedRoles(), navigation = useNavigation<NavProp<'ImportedChat'>>();
  const scope = useRef(isCurrent); scope.current = isCurrent;
  const [status, setStatus] = useState<{ connection: BeeperReadConnection; job?: BeeperReadJob } | null>(null), [error, setError] = useState('');
  useFocusEffect(useCallback(() => {
    let active = true;
    void (async () => {
      try {
        const connections = await api.listBeeperConnections();
        if (!active || !scope.current()) return;
        const connection = connections.find(item => item.id === source.connectionId);
        if (!connection) throw new Error('connection_not_available');
        const job = source.jobId ? await api.getBeeperReadJob(source.connectionId, source.jobId) : undefined;
        if (active && scope.current()) { setStatus({ connection, job }); setError(''); }
      } catch (e) { if (active && scope.current()) { setStatus(null); setError(beeperFailure(e)); } }
    })();
    return () => { active = false; };
  }, [source.connectionId, source.jobId]));
  const canRequest = status?.connection.state === 'active' && Date.parse(status.connection.expiresAt) > Date.now();
  return <View style={{ padding: space[3], gap: space[2], borderBottomWidth: 1, borderBottomColor: r.line }}>
    <Text style={[type.meta, { color: r.textMeta }]}>{status?.job?.state === 'done' && status.job.completedAt
      ? `Source read completed ${new Date(status.job.completedAt).toLocaleString()}. Saved snapshot; coverage may be partial and it may now be stale.`
      : 'Saved copy · may be partial or stale. No completed source refresh is confirmed here.'}</Text>
    {status && <Text style={[type.meta, { color: r.textMeta }]}>{beeperConnectionState(status.connection)}</Text>}
    {!!error && <Text accessibilityRole="alert" style={[type.meta, { color: r.danger }]}>{error}</Text>}
    <Button label="Refresh from Beeper" size="sm" disabled={!canRequest} onPress={() => {
      if (scope.current()) navigation.navigate('BeeperRead', { connectionId: source.connectionId, chatKey: source.chatKey, kind: 'refresh', requestRevision: Crypto.randomUUID() });
    }} accessibilityHint="Requests a new source read on your Mac, with device authorization. Reloading this saved copy does not refresh the source." />
  </View>;
}
