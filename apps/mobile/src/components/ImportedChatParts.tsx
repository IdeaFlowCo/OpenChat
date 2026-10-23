/**
 * Shared pieces of the imported chat mirror screens (OpenChat-061g): the
 * provenance strip every mirror leads with, a cited source message, and an
 * evidenced ask with the owner's own status control.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ImportedAsk, ImportedCoverage, ImportedParticipantRef, ImportedSourceExcerpt } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, type } from '../theme/tokens';
import { ASK_STATUS_LABEL, coverageLine, mirrorLabel, OWNER_ASK_STATUSES, shortDate } from '../utils/importedChats';
import { AppIcon } from './AppIcon';
import { Button, Card, Chip } from './ui';

export function useImportedRoles() {
  const { scheme } = useTheme();
  return roles(getColors(scheme));
}

/** Where this copy came from and how much of it is here. */
export function ProvenanceStrip({ network, coverage }: { network: string; coverage: ImportedCoverage }) {
  const r = useImportedRoles();
  return (
    <View style={[styles.strip, { borderBottomColor: r.line, backgroundColor: r.card }]} accessibilityRole="summary" testID="imported-provenance">
      <View style={styles.stripTop}>
        <AppIcon name="lock" color={r.textMeta} size={12} />
        <Text style={[type.eyebrow, { color: r.textMeta }]}>Private to you · {mirrorLabel(network)}</Text>
      </View>
      <Text style={[type.meta, { color: r.textSecondary }]}>{coverageLine(coverage)}</Text>
      {coverage.note ? <Text style={[type.meta, { color: r.textMeta }]}>{coverage.note}</Text> : null}
    </View>
  );
}

export function participantName(ref: ImportedParticipantRef | null, fallback = 'Unknown participant'): string {
  if (!ref) return fallback;
  return ref.isOwner ? `${ref.label} (you)` : ref.label;
}

/** A source message quoted as evidence, or an honest gap when it is no longer stored. */
export function SourceQuote({ source, onOpenPerson }: { source: ImportedSourceExcerpt; onOpenPerson?: (participantId: string) => void }) {
  const r = useImportedRoles();
  const who = source.sender;
  return (
    <View style={[styles.quote, { borderLeftColor: r.line }]} accessibilityLabel={`Source message${who ? ` from ${who.label}` : ''}`}>
      <View style={styles.quoteHead}>
        {who && onOpenPerson
          ? <TouchableOpacity accessibilityRole="button" onPress={() => onOpenPerson(who.participantId)}><Text style={[type.label, { color: r.text }]}>{participantName(who)}</Text></TouchableOpacity>
          : <Text style={[type.label, { color: r.text }]}>{who ? participantName(who) : 'Source message'}</Text>}
        {source.sentAt ? <Text style={[type.meta, { color: r.textMeta }]}>{shortDate(source.sentAt)}</Text> : null}
      </View>
      <Text style={[type.body, { color: source.text ? r.textSecondary : r.textMeta }]} numberOfLines={4}>
        {source.available ? (source.text ?? 'No text (deleted or media)') : 'Source message not in this copy'}
      </Text>
    </View>
  );
}

/** One ask: whose need it is, who said it, the messages that say it, and the owner's status. */
export function AskCard({ ask, onOpenPerson, onSetStatus, busy }: {
  ask: ImportedAsk;
  onOpenPerson: (participantId: string) => void;
  onSetStatus: (status: ImportedAsk['ownerStatus']) => void;
  busy?: boolean;
}) {
  const r = useImportedRoles();
  const subject = ask.subject;
  const reporterIsSubject = !!subject && ask.reporter?.participantId === subject.participantId;
  return (
    <Card style={styles.ask} testID={`imported-ask-${ask.id}`}>
      <View style={styles.askHead}>
        <Text style={[type.eyebrow, { color: ask.status === 'open' ? r.ask : r.textMeta }]}>{ASK_STATUS_LABEL[ask.status]}</Text>
        {ask.stale ? <Chip label="Not in latest import" /> : null}
      </View>
      <Text style={[type.bodyStrong, { color: r.text }]}>{ask.text}</Text>
      <View style={styles.attribution}>
        <Text style={[type.meta, { color: r.textMeta }]}>For </Text>
        {subject
          ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open ${subject.label}`} onPress={() => onOpenPerson(subject.participantId)}><Text style={[type.meta, styles.link, { color: r.accent }]}>{participantName(subject)}</Text></TouchableOpacity>
          : <Text style={[type.meta, { color: r.textSecondary }]}>{ask.subjectLabel ?? 'someone unnamed'} · not in this chat</Text>}
        {!reporterIsSubject && ask.reporter ? <>
          <Text style={[type.meta, { color: r.textMeta }]}> · said by </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open ${ask.reporter.label}`} onPress={() => onOpenPerson(ask.reporter!.participantId)}><Text style={[type.meta, styles.link, { color: r.accent }]}>{participantName(ask.reporter)}</Text></TouchableOpacity>
        </> : null}
      </View>
      {ask.sources.map(source => <SourceQuote key={source.sourceMessageId} source={source} onOpenPerson={onOpenPerson} />)}
      {ask.statusSources.length ? <>
        <Text style={[type.meta, { color: r.textMeta }]}>Status evidence</Text>
        {ask.statusSources.map(source => <SourceQuote key={`status-${source.sourceMessageId}`} source={source} onOpenPerson={onOpenPerson} />)}
      </> : null}
      <View style={styles.statusRow} accessibilityRole="radiogroup" accessibilityLabel="Your status for this ask">
        {OWNER_ASK_STATUSES.map(status => (
          <Chip key={status} label={ASK_STATUS_LABEL[status]} accessibilityRole="radio" selected={ask.status === status} disabled={busy}
            onPress={() => onSetStatus(status)} />
        ))}
      </View>
      {ask.ownerStatus ? (
        <View style={styles.askHead}>
          <Text style={[type.meta, { color: r.textMeta }]}>You set this. The source shows {ASK_STATUS_LABEL[ask.sourceStatus].toLowerCase()}.</Text>
          <Button label="Use source status" size="sm" variant="ghost" disabled={busy} onPress={() => onSetStatus(null)} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: space[4], paddingVertical: space[2], gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  stripTop: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  quote: { borderLeftWidth: 2, paddingLeft: space[3], gap: 2, borderRadius: radius.sm },
  quoteHead: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  ask: { gap: space[2] },
  askHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2], flexWrap: 'wrap' },
  attribution: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  link: { fontWeight: '600' },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
});
