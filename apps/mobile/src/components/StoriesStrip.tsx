import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, type FeedStory } from '../api/client';
import { useSocialExperience } from '../contexts/SocialExperienceContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { capsLabel } from '../theme/typography';
import { radius, space, type } from '../theme/tokens';
import { AppIcon } from './AppIcon';
import { Avatar } from './Avatar';

interface StoriesStripProps {
  compact?: boolean;
  onCreate: () => void;
  onOpenStory: (story: FeedStory) => void;
  onOpenReview: () => void;
}

function timeLeft(expiresAt: string): string {
  const milliseconds = Math.max(0, Date.parse(expiresAt) - Date.now());
  const hours = Math.ceil(milliseconds / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

export function StoriesStrip({ compact, onCreate, onOpenStory, onOpenReview }: StoriesStripProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const {
    enhanced,
    storiesCollapsed,
    setStoriesCollapsed,
  } = useSocialExperience();
  const [stories, setStories] = useState<FeedStory[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!enhanced || compact) return;
    setLoading(true);
    try {
      setStories(await api.listStoryFeed());
    } catch {
      // Stories are additive. A feed outage should never block ordinary chat.
      setStories([]);
    } finally {
      setLoading(false);
    }
  }, [compact, enhanced]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (!enhanced || compact) return null;

  return (
    <View style={[styles.shell, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" style={[type.eyebrow, styles.heading, { color: c.textMetadata }]}>Stories</Text>
        <TouchableOpacity
          onPress={() => void setStoriesCollapsed(!storiesCollapsed)}
          accessibilityRole="button"
          accessibilityState={{ expanded: !storiesCollapsed }}
          accessibilityLabel={storiesCollapsed ? 'Show Stories' : 'Hide Stories'}
          style={styles.collapseButton}
        >
          <Text style={[type.label, { color: c.textSecondary, fontWeight: '600' }]}>{storiesCollapsed ? 'Show' : 'Hide'}</Text>
        </TouchableOpacity>
      </View>

      {!storiesCollapsed && (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rail}
            accessibilityRole="list"
          >
            <TouchableOpacity
              onPress={onCreate}
              accessibilityLabel="Share a new Story"
              style={styles.tile}
            >
              <View style={[styles.newCircle, { borderColor: c.primary, backgroundColor: c.surfaceElevated }]}>
                <AppIcon name="plus" color={c.primary} size={22} />
              </View>
              <Text numberOfLines={1} style={[styles.tileLabel, { color: c.textPrimary }]}>Share</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onOpenReview}
              accessibilityLabel="Open agent Review"
              style={styles.tile}
            >
              <View style={[styles.agentCircle, { backgroundColor: c.primaryMuted }]}>
                <AppIcon name="sparkle" color={c.primary} size={22} />
              </View>
              <Text numberOfLines={1} style={[styles.tileLabel, { color: c.primary }]}>Review</Text>
            </TouchableOpacity>

            {loading && <ActivityIndicator color={c.primary} style={{ marginHorizontal: 18 }} />}
            {!loading && stories.map(story => (
              <TouchableOpacity
                key={story.id}
                onPress={() => onOpenStory(story)}
                accessibilityLabel={`${story.author.name || 'A friend'}'s Story, expires in ${timeLeft(story.storyExpiresAt)}`}
                style={styles.tile}
              >
                <View style={[styles.storyCircle, { borderColor: c.primary }]}>
                  <Avatar name={story.author.name || 'A friend'} size={48} />
                </View>
                <Text numberOfLines={1} style={[styles.tileLabel, { color: c.textPrimary }]}>{story.author.name || 'A friend'}</Text>
                <Text style={[styles.expiry, { color: c.textMetadata }]}>{timeLeft(story.storyExpiresAt)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: space[2] },
  headingRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[4], gap: space[2] },
  heading: { flex: 1 },
  collapseButton: { minWidth: 60, minHeight: 36, alignItems: 'flex-end', justifyContent: 'center' },
  rail: { alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingTop: space[1], paddingBottom: 2 },
  tile: { width: 68, minHeight: 78, alignItems: 'center' },
  newCircle: { width: 54, height: 54, borderRadius: 27, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  agentCircle: { width: 54, height: 54, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  storyCircle: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { ...capsLabel, width: 68, textAlign: 'center', marginTop: 5, textTransform: 'none', letterSpacing: 0, fontSize: 11 },
  expiry: { fontSize: 9, marginTop: 1 },
});
