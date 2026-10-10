/**
 * Asks on a contact's profile — what this person is asking for, limited to the
 * Stories they chose to share with the viewer. It is the Stories feed narrowed
 * to one author, so audience, blocks and expiry are the server's rules, not
 * this component's. Stories are additive: a failed load or an empty list shows
 * nothing. It sits in their layer on the profile, above the private card.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, type FeedStory } from '../api/client';
import { useSocialExperience } from '../contexts/SocialExperienceContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { roles, space, type } from '../theme/tokens';
import { Button, Card, SectionLabel } from './ui';

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

  if (!enhanced || !stories?.length) return null;
  const r = roles(c);
  return (
    <View>
      <SectionLabel>{`Shared with you · ${stories.length}`}</SectionLabel>
      <Card padding="none">
        {stories.map((story, index) => (
          <View key={story.id} style={[styles.ask, index > 0 && { borderTopColor: r.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
            <Text style={[type.body, { color: r.text }]} numberOfLines={5}>{story.text}</Text>
            <View style={styles.askFooter}>
              <Text style={[type.meta, { color: r.textMeta }]}>{askTimeLeft(story.storyExpiresAt)}</Text>
              <Button size="sm" label="Respond" onPress={() => onOpenStory(story)} />
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  ask: { paddingHorizontal: space[4], paddingVertical: space[3], gap: space[2] },
  askFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
