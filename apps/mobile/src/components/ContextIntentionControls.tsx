import React, { useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { nanoid } from 'nanoid/non-secure';
import { api, type ContextIntention, type ContextPost, type IntentionLifecycleState } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

/** One intention identity, even when shown in several conversations and Stories. */
export function IntentionLifecycleControls({ intention, onChange }: { intention: Pick<ContextIntention, 'intentId'|'revision'|'lifecycleState'>; onChange: () => void }) {
  const c = getColors(useTheme().scheme);
  const [review, setReview] = useState<{ current: ContextIntention; target: IntentionLifecycleState }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef(false);
  const prepare = async (target: IntentionLifecycleState) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { const current = (await api.getContextIntentions()).intentions.find(item => item.intentId === intention.intentId); if (!current) throw new Error('This intention is unavailable. Refresh before trying again.'); setReview({ current, target }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not review this change.'); }
    finally { pending.current = false; setBusy(false); }
  };
  const commit = async () => {
    if (!review || pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await api.updateContextIntention(review.current.intentId, { expectedRevision: review.current.revision, lifecycleState: review.target }); setReview(undefined); onChange(); }
    catch (e) { setReview(undefined); setError(e instanceof Error ? e.message : 'Could not update intention. Review again before retrying.'); }
    finally { pending.current = false; setBusy(false); }
  };
  const button = (label: string, action: () => void) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={action} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: c.primary }}>{label}</Text></TouchableOpacity>;
  return <View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{intention.lifecycleState === 'open' ? <>{button('Mark fulfilled', () => void prepare('fulfilled'))}{button('Withdraw intention', () => void prepare('withdrawn'))}</> : button('Reopen intention', () => void prepare('open'))}</View>
    {review && <View style={{ padding: 12, backgroundColor: c.background, borderColor: c.border, borderWidth: 1, borderRadius: 8 }}>
      <Text style={{ color: c.textPrimary, fontWeight: '600' }}>{review.target === 'open' ? 'Reopen this intention?' : review.target === 'fulfilled' ? 'Mark this intention fulfilled?' : 'Withdraw this intention?'}</Text>
      <Text style={{ color: c.textMetadata, marginTop: 8 }}>Applies to this same intention across {review.current.contextPosts.length} linked Context post{review.current.contextPosts.length === 1 ? '' : 's'} and {review.current.stories.length} Story projection{review.current.stories.length === 1 ? '' : 's'}.</Text>
      <Text style={{ color: c.textMetadata, marginTop: 8 }}>{review.target === 'open' ? 'Only intention tracking reopens. Matching stays paused; Stories stay withdrawn. This does not broaden the audience or restart a search.' : 'Closes linked Context asks and offers, stops matching, and withdraws linked Stories. Existing shared text stays in its conversations.'}</Text>
      {button('Confirm intention change', () => void commit())}{button('Cancel intention change', () => setReview(undefined))}
    </View>}
    {error ? <Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text> : null}
  </View>;
}
export function ContextIntentionControls({ post, conversationId, onChange }: { post: ContextPost; conversationId: string; onChange: () => void }) {
  const c = getColors(useTheme().scheme), { currentUser } = useChat();
  const [choices, setChoices] = useState<ContextIntention[]>(), [selected, setSelected] = useState<ContextIntention>();
  const [choiceRevision, setChoiceRevision] = useState<number>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef(false), retry = useRef<{ key: string; id: string } | undefined>(undefined);
  const own = post.authorId === currentUser?.userId;
  const run = async (fn: () => Promise<void>) => { if (pending.current) return; pending.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not track intention.'); } finally { pending.current = false; setBusy(false); } };
  const track = (existing?: ContextIntention) => void run(async () => {
    if (existing && choiceRevision !== post.revision) throw new Error('Context post changed. Cancel linking and review it again.');
    const key = `${post.id}:${post.revision}:${existing?.intentId || 'new'}`;
    if (retry.current?.key !== key) retry.current = { key, id: nanoid() };
    await api.trackContextIntention(conversationId, post.id, { sourceRevision: post.revision, clientRequestId: retry.current.id, ...(existing ? { intentId: existing.intentId } : {}) });
    setChoices(undefined); setSelected(undefined); onChange();
  });
  const button = (label: string, action: () => void) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={action} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: c.primary }}>{label}</Text></TouchableOpacity>;
  if (!['ask', 'offer'].includes(post.kind)) return null;
  return <View>
    {post.intention ? <><Text style={{ color: c.textMetadata, fontSize: 13 }}>Tracked {post.kind} · {post.intention.lifecycleState}{post.intention.sourceChanged ? ' · Source edited since linking' : ''}</Text>{own && <IntentionLifecycleControls intention={{ ...post.intention }} onChange={onChange} />}</> : own ? <>
      <Text style={{ color: c.textMetadata, fontSize: 13 }}>Track this shared {post.kind} without starting a wider agent search.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{button(`Track ${post.kind}`, () => track())}{button('Link existing intention', () => void run(async () => { const revision = post.revision; setChoices((await api.getContextIntentions()).intentions); setChoiceRevision(revision); }))}</View>
      {choices && <View style={{ padding: 8, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
        <Text style={{ color: c.textMetadata }}>Your private inventory · choosing an intention does not copy its private details into this chat.</Text>
        {choices.length ? choices.map(item => <React.Fragment key={item.intentId}>{button(`${item.kind === 'offer' ? 'Offer' : 'Ask'}: ${item.goal || item.seeks[0] || item.brings[0] || 'Intention'}`, () => setSelected(item))}</React.Fragment>) : <Text style={{ color: c.textMetadata }}>No existing intentions. Track this post to create one.</Text>}
        {selected && <><Text style={{ color: c.textPrimary }}>Link to “{selected.goal}”? The post keeps its current shared text; search permissions stay unchanged. Its public status will become {selected.lifecycleState}.</Text>{button('Confirm intention link', () => track(selected))}</>}
        {button('Cancel linking', () => { setChoices(undefined); setSelected(undefined); })}
      </View>}
    </> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text> : null}
  </View>;
}
