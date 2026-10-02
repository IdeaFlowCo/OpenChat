/**
 * Asks on a contact's profile — what this person is asking for, limited to the
 * Stories they chose to share with the viewer. It is the Stories feed narrowed
 * to one author, so audience, blocks and expiry are the server's rules, not
 * this component's. Stories are additive: a failed load shows nothing.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, type FeedStory } from '../api/client';
import { useSocialExperience } from '../contexts/SocialExperienceContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { capsLabel } from '../theme/typography';

export function askTimeLeft(expiresAt: string, now = Date.now()): string {
  const hours = Math.ceil(Math.max(0, Date.parse(expiresAt) - now) / 3_600_000);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`;
  const days = Math.ceil(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

export function ProfileAsks({ userId, onOpenStory }: { userId: string; onOpenStory: (story: FeedStory) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { enhanced } = useSocialExperience();
  const [stories, setStories] = useState<FeedStory[] | null>(null);

  useEffect(() => {
    if (!enhanced) return;
    let active = true;
    api.listStoryFeed(userId)
      // The server already narrows to this author; the filter guards an older server that ignores `author`.
      .then(result => { if (active) setStories(result.filter(story => story.author.id === userId)); })
      .catch(() => { if (active) setStories(null); });
    return () => { active = false; };
  }, [enhanced, userId]);

  if (!enhanced || stories === null) return null;
  return (
    <View style={styles.root}>
      <Text style={[styles.label, { color: c.textMetadata }]}>
        {stories.length ? `Asks · ${stories.length} shared with you` : 'Asks'}
      </Text>
      {stories.length === 0 ? (
        <Text style={[styles.empty, { color: c.textMetadata }]}>Nothing shared with you right now.</Text>
      ) : (
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          {stories.map((story, index) => (
            <View key={story.id} style={[styles.ask, index > 0 && { borderTopColor: c.divider, borderTopWidth: StyleSheet.hairlineWidth }]}>
              <Text style={{ color: c.textPrimary, fontSize: 15, lineHeight: 21 }} numberOfLines={5}>{story.text}</Text>
              <View style={styles.askFooter}>
                <Text style={{ color: c.textMetadata, fontSize: 12 }}>{askTimeLeft(story.storyExpiresAt)}</Text>
                <TouchableOpacity
                  onPress={() => onOpenStory(story)}
                  accessibilityRole="button"
                  style={[styles.respond, { borderColor: c.border, backgroundColor: c.surfaceElevated }]}
                >
                  <Text style={{ color: c.textPrimary, fontWeight: '700', fontSize: 14 }}>Respond</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginTop: 16, gap: 6 },
  label: { ...capsLabel, marginHorizontal: 2 },
  empty: { fontSize: 13, marginHorizontal: 2 },
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  ask: { paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  askFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  respond: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
});
