/**
 * OnboardingScreen — 4-step first-run experience (OpenChat-x2s + OpenChat-jmu).
 *
 * Steps:
 *   0  Welcome     — app icon + headline + subhead + "Let's go →"
 *   1  Set name    — editable name pre-filled from Google profile,
 *                    optional avatar photo pick + upload,
 *                    "Skip" + "Save & continue"
 *   2  Notifications — "Want notifications?" "Maybe later" / "Turn on" + "Next →"
 *   3  Agent-ready — OpenChat-jmu: what makes OpenChat different (agents via
 *                    MCP keys + the private Thoughts stream), pointing at
 *                    Settings → Copy agent setup / Agent keys and the Thoughts tab.
 *
 * On completion (any path):
 *   - Calls markOnboardingComplete() (AsyncStorage)
 *   - Calls PATCH /api/auth/me with onboardingComplete: true (server flag)
 *   - navigation.replace('Conversations')
 *
 * Uses a simple TouchableOpacity-based page nav with a 250ms slide animation
 * so there is no external dependency beyond what's already installed.
 */

import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { markOnboardingComplete } from '../services/onboarding';
import { registerForPushNotificationsAsync } from '../services/notifications';
import { api } from '../api/client';
import type { RootStackParamList } from '../navigation/types';

// ── AsyncStorage key shared with PushSoftAsk so we never double-prompt ────────
// (importing the const from PushSoftAsk would create a circular dep via the
// component tree, so we mirror the value here instead)
const PUSH_SOFTASKED_KEY = 'openchat_push_softasked';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_W } = Dimensions.get('window');
const TOTAL_STEPS = 4;
const SLIDE_MS = 250;

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Onboarding'>;

interface Props {
  navigation: NavProp;
}

export function OnboardingScreen({ navigation }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser, updateProfile } = useChat();

  // ── step state ───────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  const slideAnim = useRef(new Animated.Value(0)).current;

  // ── step 1 state ─────────────────────────────────────────────────────────
  const [name, setName] = useState(currentUser?.name ?? '');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarMime, setAvatarMime] = useState('image/jpeg');
  const [savingProfile, setSavingProfile] = useState(false);

  // ── step 2 state ─────────────────────────────────────────────────────────
  const [notifDone, setNotifDone] = useState(false);

  // ── helpers ───────────────────────────────────────────────────────────────

  const goToStep = useCallback((next: number) => {
    const from = step;
    const direction = next > from ? 1 : -1;
    // Slide current step out
    Animated.timing(slideAnim, {
      toValue: -direction * SCREEN_W,
      duration: SLIDE_MS,
      useNativeDriver: true,
    }).start(() => {
      // Jump to incoming position and slide in
      slideAnim.setValue(direction * SCREEN_W);
      setStep(next);
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: SLIDE_MS,
        useNativeDriver: true,
      }).start();
    });
  }, [step, slideAnim]);

  const finish = useCallback(async () => {
    await markOnboardingComplete();
    // Best-effort server flag — non-fatal
    try {
      await api.updateProfile({ onboardingComplete: true });
    } catch {
      /* non-fatal */
    }
    navigation.replace('Conversations');
  }, [navigation]);

  // ── avatar pick (step 1) ──────────────────────────────────────────────────

  const pickAvatar = useCallback(async () => {
    if (Platform.OS !== 'web') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      exif: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setAvatarUri(asset.uri);
    let mime = asset.mimeType || 'image/jpeg';
    if (mime === 'image/jpg') mime = 'image/jpeg';
    setAvatarMime(mime);
  }, []);

  // ── save profile (step 1) ─────────────────────────────────────────────────

  const saveProfile = useCallback(async () => {
    setSavingProfile(true);
    try {
      let avatarUrl: string | undefined;

      if (avatarUri) {
        try {
          const fileName = `avatar_${Date.now()}.jpg`;
          const fileSize = 1; // server cap will still protect; expo doesn't always give size for cropped
          const { putUrl, getUrl } = await api.presignAvatar({
            filename: fileName,
            mimeType: avatarMime,
            sizeBytes: fileSize,
          });

          if (Platform.OS === 'web') {
            const res = await fetch(avatarUri);
            const blob = await res.blob();
            const putRes = await fetch(putUrl, {
              method: 'PUT',
              headers: { 'Content-Type': avatarMime },
              body: blob,
            });
            if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
          } else {
            const uploadResult = await uploadAsync(putUrl, avatarUri, {
              httpMethod: 'PUT',
              uploadType: FileSystemUploadType.BINARY_CONTENT,
              headers: { 'Content-Type': avatarMime },
            });
            if (uploadResult.status < 200 || uploadResult.status >= 300) {
              throw new Error(`Upload failed: ${uploadResult.status}`);
            }
          }
          avatarUrl = getUrl;
        } catch (uploadErr) {
          console.warn('[OnboardingScreen] avatar upload failed:', uploadErr);
          // Non-fatal — continue without avatar
        }
      }

      const fields: { name?: string; avatarUrl?: string } = {};
      if (name.trim()) fields.name = name.trim();
      if (avatarUrl) fields.avatarUrl = avatarUrl;

      if (Object.keys(fields).length > 0) {
        await updateProfile(fields);
      }
    } catch (err) {
      console.warn('[OnboardingScreen] saveProfile error:', err);
    } finally {
      setSavingProfile(false);
    }
    goToStep(2);
  }, [avatarUri, avatarMime, name, updateProfile, goToStep]);

  // ── notifications (step 2) ────────────────────────────────────────────────

  const handleTurnOnNotifications = useCallback(async () => {
    setNotifDone(true);
    try {
      await AsyncStorage.setItem(PUSH_SOFTASKED_KEY, '1');
    } catch { /* ignore */ }
    try {
      await registerForPushNotificationsAsync();
    } catch { /* ignore */ }
  }, []);

  const handleMaybeLater = useCallback(async () => {
    setNotifDone(true);
    try {
      await AsyncStorage.setItem(PUSH_SOFTASKED_KEY, '1');
    } catch { /* ignore */ }
  }, []);

  // ── render ────────────────────────────────────────────────────────────────

  const renderStep = () => {
    switch (step) {
      case 0:
        return <WelcomeStep c={c} onNext={() => goToStep(1)} />;
      case 1:
        return (
          <NameStep
            c={c}
            name={name}
            onChangeName={setName}
            avatarUri={avatarUri}
            onPickAvatar={pickAvatar}
            saving={savingProfile}
            onSkip={() => goToStep(2)}
            onSave={saveProfile}
          />
        );
      case 2:
        return (
          <NotificationsStep
            c={c}
            done={notifDone}
            onMaybeLater={handleMaybeLater}
            onTurnOn={handleTurnOnNotifications}
            onDone={() => goToStep(3)}
          />
        );
      case 3:
        return <AgentReadyStep c={c} onDone={finish} />;
      default:
        return null;
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
    >
      {/* Progress dots */}
      <View style={styles.dots}>
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === step ? c.primary : c.border,
                width: i === step ? 20 : 8,
              },
            ]}
          />
        ))}
      </View>

      <Animated.View style={[styles.stepWrap, { transform: [{ translateX: slideAnim }] }]}>
        {renderStep()}
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

// ── Step 0: Welcome ────────────────────────────────────────────────────────────

interface WelcomeStepProps {
  c: ReturnType<typeof getColors>;
  onNext: () => void;
}

function WelcomeStep({ c, onNext }: WelcomeStepProps) {
  return (
    <View style={styles.stepContent}>
      {/* App icon placeholder — a simple branded circle */}
      <View style={[styles.appIconWrap, { backgroundColor: c.primary + '22', borderColor: c.primary + '44' }]}>
        <Text style={[styles.appIconText, { color: c.primary }]}>OC</Text>
      </View>

      <Text style={[styles.welcomeHeading, { color: c.textPrimary }]}>
        Welcome to OpenChat
      </Text>
      <Text style={[styles.welcomeSubhead, { color: c.textSecondary }]}>
        Real-time messaging powered by the Global Brain.{'\n'}
        Friends, groups, and AI assistants — all in one place.
      </Text>

      <TouchableOpacity
        style={[styles.ctaButton, { backgroundColor: c.primary }]}
        onPress={onNext}
        accessibilityLabel="Let's go"
      >
        <Text style={styles.ctaButtonText}>{"Let's go →"}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Step 1: Name + Avatar ──────────────────────────────────────────────────────

interface NameStepProps {
  c: ReturnType<typeof getColors>;
  name: string;
  onChangeName: (v: string) => void;
  avatarUri: string | null;
  onPickAvatar: () => void;
  saving: boolean;
  onSkip: () => void;
  onSave: () => void;
}

function NameStep({ c, name, onChangeName, avatarUri, onPickAvatar, saving, onSkip, onSave }: NameStepProps) {
  return (
    <View style={styles.stepContent}>
      <Text style={[styles.stepHeading, { color: c.textPrimary }]}>Set your name</Text>
      <Text style={[styles.stepSubhead, { color: c.textSecondary }]}>
        How should your friends see you?
      </Text>

      {/* Avatar picker */}
      <TouchableOpacity
        style={[styles.avatarPicker, { borderColor: c.border, backgroundColor: c.surfaceElevated }]}
        onPress={onPickAvatar}
        accessibilityLabel="Upload profile photo"
      >
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatarPlaceholder}>
            <Text style={[styles.avatarPlaceholderIcon, { color: c.textMuted }]}>+</Text>
            <Text style={[styles.avatarPlaceholderLabel, { color: c.textMuted }]}>Photo</Text>
          </View>
        )}
      </TouchableOpacity>

      <TextInput
        style={[
          styles.nameInput,
          {
            backgroundColor: c.surfaceElevated,
            borderColor: c.border,
            color: c.textPrimary,
          },
        ]}
        value={name}
        onChangeText={onChangeName}
        placeholder="Your name"
        placeholderTextColor={c.textMuted}
        autoCorrect={false}
        autoCapitalize="words"
        returnKeyType="done"
        editable={!saving}
      />

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.secondaryBtn, { borderColor: c.border }]}
          onPress={onSkip}
          disabled={saving}
          accessibilityLabel="Skip"
        >
          <Text style={{ color: c.textSecondary, fontWeight: '500' }}>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: c.primary, opacity: saving ? 0.6 : 1 }]}
          onPress={onSave}
          disabled={saving}
          accessibilityLabel="Save and continue"
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Save &amp; continue</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Step 2: Notifications ──────────────────────────────────────────────────────

interface NotificationsStepProps {
  c: ReturnType<typeof getColors>;
  done: boolean;
  onMaybeLater: () => void;
  onTurnOn: () => void;
  onDone: () => void;
}

function NotificationsStep({ c, done, onMaybeLater, onTurnOn, onDone }: NotificationsStepProps) {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.notifEmoji}>🔔</Text>
      <Text style={[styles.stepHeading, { color: c.textPrimary }]}>Stay in the loop</Text>
      <Text style={[styles.stepSubhead, { color: c.textSecondary }]}>
        Want notifications when friends message you?
      </Text>

      {!done && Platform.OS !== 'web' && (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: c.border }]}
            onPress={onMaybeLater}
            accessibilityLabel="Maybe later"
          >
            <Text style={{ color: c.textSecondary, fontWeight: '500' }}>Maybe later</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: c.primary }]}
            onPress={onTurnOn}
            accessibilityLabel="Turn on notifications"
          >
            <Text style={styles.primaryBtnText}>Turn on</Text>
          </TouchableOpacity>
        </View>
      )}

      {(done || Platform.OS === 'web') && (
        <Text style={[styles.notifConfirm, { color: c.textSecondary }]}>
          {Platform.OS === 'web' ? 'All set!' : 'Got it!'}
        </Text>
      )}

      <TouchableOpacity
        style={[styles.ctaButton, { backgroundColor: c.primary, marginTop: 24 }]}
        onPress={onDone}
        accessibilityLabel="Next"
      >
        <Text style={styles.ctaButtonText}>{"Next →"}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Step 3: Agent-ready (OpenChat-jmu) ─────────────────────────────────────────

interface AgentReadyStepProps {
  c: ReturnType<typeof getColors>;
  onDone: () => void;
}

function AgentReadyStep({ c, onDone }: AgentReadyStepProps) {
  return (
    <ScrollView
      style={styles.stepScroll}
      contentContainerStyle={styles.stepScrollContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.agentReadyContent}>
        <Text style={styles.notifEmoji}>🤖</Text>
        <Text style={[styles.stepHeading, { color: c.textPrimary }]}>Built for you and your AI</Text>
        <Text style={[styles.stepSubhead, { color: c.textSecondary }]}>
          OpenChat is agent-ready from day one.
        </Text>

        <View style={styles.agentBullets}>
          <View style={[styles.agentBullet, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
            <Text style={styles.agentBulletEmoji}>🔑</Text>
            <Text style={[styles.agentBulletText, { color: c.textSecondary }]}>
              <Text style={{ fontWeight: '600', color: c.textPrimary }}>Connect an agent.</Text>
              {' '}Mint a key in Settings so Claude, Cursor, or any MCP client can read and send messages as you.
            </Text>
          </View>
          <View style={[styles.agentBullet, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
            <Text style={styles.agentBulletEmoji}>💭</Text>
            <Text style={[styles.agentBulletText, { color: c.textSecondary }]}>
              <Text style={{ fontWeight: '600', color: c.textPrimary }}>Keep Thoughts.</Text>
              {' '}A private stream for facts, decisions, and reminders — memory your agents can build on.
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.ctaButton, { backgroundColor: c.primary, marginTop: 24 }]}
          onPress={onDone}
          accessibilityLabel="Start chatting"
        >
          <Text style={styles.ctaButtonText}>{'Start chatting →'}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginBottom: 32,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  stepWrap: {
    flex: 1,
    paddingHorizontal: 28,
  },
  stepContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 40,
  },
  stepScroll: {
    flex: 1,
  },
  stepScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: 40,
  },
  agentReadyContent: {
    alignItems: 'center',
  },

  // Welcome step
  appIconWrap: {
    width: 100,
    height: 100,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  appIconText: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
  },
  welcomeHeading: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 14,
  },
  welcomeSubhead: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    marginBottom: 40,
    maxWidth: 320,
  },

  // Shared step styles
  stepHeading: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 10,
  },
  stepSubhead: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 28,
    maxWidth: 300,
  },

  // Avatar picker (step 1)
  avatarPicker: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: 20,
  },
  avatarImage: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  avatarPlaceholder: {
    alignItems: 'center',
  },
  avatarPlaceholderIcon: {
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '300',
  },
  avatarPlaceholderLabel: {
    fontSize: 11,
    marginTop: 2,
  },

  // Name input (step 1)
  nameInput: {
    width: '100%',
    maxWidth: 320,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 17,
    marginBottom: 24,
  },

  // Notifications step
  notifEmoji: {
    fontSize: 52,
    marginBottom: 16,
  },
  notifConfirm: {
    fontSize: 15,
    marginTop: 16,
  },

  // Agent-ready step (step 3)
  agentBullets: {
    gap: 10,
    width: '100%',
    maxWidth: 340,
  },
  agentBullet: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'flex-start',
  },
  agentBulletEmoji: {
    fontSize: 20,
    lineHeight: 24,
  },
  agentBulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },

  // Action row (Skip / Save, Maybe later / Turn on)
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  secondaryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 120,
    minHeight: 46,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  // CTA button (Let's go / Done)
  ctaButton: {
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 14,
    alignItems: 'center',
    minWidth: 180,
  },
  ctaButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
});
