import { useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

type DestinationId = 'stream' | 'maya' | 'product' | 'research';
type LensId = 'stream' | 'maya' | 'product';

type Destination = {
  id: DestinationId;
  label: string;
  kind: 'Personal' | 'Direct message' | 'Group' | 'Channel';
  consequence: string;
  accent: string;
  initials: string;
};

type Thought = {
  id: string;
  body: string;
  time: string;
  tags: string[];
  source?: string;
  sourceLens?: Exclude<LensId, 'stream'>;
};

type Message = {
  id: string;
  author: string;
  initials: string;
  body: string;
  time: string;
  mine?: boolean;
  savedThoughtId?: string;
};

const DESTINATIONS: Destination[] = [
  {
    id: 'stream',
    label: 'My Stream',
    kind: 'Personal',
    consequence: 'Only you',
    accent: '#C64B35',
    initials: 'ME',
  },
  {
    id: 'maya',
    label: 'Maya Chen',
    kind: 'Direct message',
    consequence: 'Private · 2 people',
    accent: '#315C78',
    initials: 'MC',
  },
  {
    id: 'product',
    label: 'Product Circle',
    kind: 'Group',
    consequence: '5 members',
    accent: '#58745F',
    initials: 'PC',
  },
  {
    id: 'research',
    label: '# research',
    kind: 'Channel',
    consequence: '12 members',
    accent: '#986F2E',
    initials: '#',
  },
];

const INITIAL_THOUGHTS: Thought[] = [
  {
    id: 'thought-focus',
    body: 'The stream should feel like a place to think, not another inbox to clear.',
    time: '9:42 AM',
    tags: ['product', 'principle'],
  },
  {
    id: 'thought-maya',
    body: 'Destinations are lenses on one shared context, not separate mental rooms.',
    time: 'Yesterday',
    tags: ['idea'],
    source: 'Saved from a message by Maya',
    sourceLens: 'maya',
  },
  {
    id: 'thought-circle',
    body: 'Test destination language with five real collaboration scenarios.',
    time: 'Mon',
    tags: ['next'],
    source: 'Saved from Product Circle',
    sourceLens: 'product',
  },
];

const INITIAL_MESSAGES: Record<Exclude<LensId, 'stream'>, Message[]> = {
  maya: [
    {
      id: 'maya-1',
      author: 'Maya Chen',
      initials: 'MC',
      body: 'I keep wanting chat to be a temporary view into the bigger thread of thought.',
      time: '9:18 AM',
    },
    {
      id: 'maya-2',
      author: 'You',
      initials: 'JC',
      body: 'Yes. Destinations are lenses on one shared context, not separate mental rooms. #idea',
      time: '9:21 AM',
      mine: true,
      savedThoughtId: 'thought-maya',
    },
    {
      id: 'maya-3',
      author: 'Maya Chen',
      initials: 'MC',
      body: 'That framing makes the audience picker much more important. It should say who can actually see the next thing.',
      time: '9:24 AM',
    },
  ],
  product: [
    {
      id: 'product-1',
      author: 'Nora',
      initials: 'NO',
      body: 'The group lens can hold the working conversation without flooding everyone’s personal stream.',
      time: 'Yesterday',
    },
    {
      id: 'product-2',
      author: 'You',
      initials: 'JC',
      body: 'I’ll test destination language with five real collaboration scenarios.',
      time: 'Yesterday',
      mine: true,
      savedThoughtId: 'thought-circle',
    },
    {
      id: 'product-3',
      author: 'Sam',
      initials: 'SA',
      body: 'The important distinction: useful chat can stay chat. Saving should be an intentional promotion.',
      time: 'Yesterday',
    },
  ],
};

function destinationFor(id: DestinationId) {
  return DESTINATIONS.find((destination) => destination.id === id) ?? DESTINATIONS[0];
}

function Avatar({ initials, color, size = 32 }: { initials: string; color: string; size?: number }) {
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size < 30 ? 9 : 11 }]}>{initials}</Text>
    </View>
  );
}

function LensButton({
  destination,
  active,
  count,
  onPress,
}: {
  destination: Destination;
  active: boolean;
  count?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.lensButton,
        active && styles.lensButtonActive,
        pressed && styles.pressed,
      ]}
    >
      <Avatar initials={destination.initials} color={destination.accent} size={28} />
      <View style={styles.lensCopy}>
        <Text style={[styles.lensLabel, active && styles.lensLabelActive]} numberOfLines={1}>
          {destination.label}
        </Text>
        <Text style={styles.lensMeta} numberOfLines={1}>
          {destination.kind}
        </Text>
      </View>
      {count ? <Text style={styles.lensCount}>{count}</Text> : null}
    </Pressable>
  );
}

function Sidebar({ activeLens, onSelect }: { activeLens: LensId; onSelect: (id: LensId) => void }) {
  return (
    <View style={styles.sidebar}>
      <View style={styles.brandRow}>
        <Image source={require('../../assets/icon.png')} style={styles.brandIcon} />
        <View>
          <Text style={styles.brand}>OpenChat</Text>
          <Text style={styles.prototypeLabel}>THOUGHT STREAM · 0.1</Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => onSelect('stream')}
        style={({ pressed }) => [styles.newThoughtButton, pressed && styles.pressed]}
      >
        <Text style={styles.newThoughtPlus}>+</Text>
        <Text style={styles.newThoughtText}>New thought</Text>
      </Pressable>

      <Text style={styles.sidebarHeading}>ROOT</Text>
      <LensButton
        destination={destinationFor('stream')}
        active={activeLens === 'stream'}
        count="3"
        onPress={() => onSelect('stream')}
      />

      <Text style={styles.sidebarHeading}>LENSES</Text>
      <LensButton
        destination={destinationFor('maya')}
        active={activeLens === 'maya'}
        onPress={() => onSelect('maya')}
      />
      <LensButton
        destination={destinationFor('product')}
        active={activeLens === 'product'}
        count="2"
        onPress={() => onSelect('product')}
      />

      <View style={styles.sidebarSpacer} />
      <View style={styles.identityRow}>
        <Avatar initials="JC" color="#6A5A48" size={30} />
        <View>
          <Text style={styles.identityName}>Jacob</Text>
          <Text style={styles.identityMeta}>Personal workspace</Text>
        </View>
      </View>
    </View>
  );
}

function CompactLensNav({ activeLens, onSelect }: { activeLens: LensId; onSelect: (id: LensId) => void }) {
  return (
    <View style={styles.compactNav}>
      <View style={styles.compactBrand}>
        <Image source={require('../../assets/icon.png')} style={styles.compactBrandIcon} />
        <Text style={styles.compactBrandText}>OpenChat</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.compactTabs}>
        {(['stream', 'maya', 'product'] as LensId[]).map((id) => {
          const destination = destinationFor(id);
          const active = activeLens === id;
          return (
            <Pressable
              key={id}
              onPress={() => onSelect(id)}
              style={[styles.compactTab, active && styles.compactTabActive]}
            >
              <Text style={[styles.compactTabText, active && styles.compactTabTextActive]}>
                {id === 'stream' ? 'My Stream' : destination.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function DestinationPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: DestinationId;
  onSelect: (id: DestinationId) => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.picker}>
      <View style={styles.pickerHeader}>
        <View>
          <Text style={styles.pickerEyebrow}>CHOOSE DESTINATION</Text>
          <Text style={styles.pickerTitle}>Who should receive this?</Text>
        </View>
        <Pressable accessibilityLabel="Close destination picker" onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>×</Text>
        </Pressable>
      </View>
      {DESTINATIONS.map((destination) => {
        const active = selected === destination.id;
        return (
          <Pressable
            key={destination.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            onPress={() => onSelect(destination.id)}
            style={({ pressed }) => [
              styles.pickerOption,
              active && styles.pickerOptionActive,
              pressed && styles.pressed,
            ]}
          >
            <Avatar initials={destination.initials} color={destination.accent} />
            <View style={styles.pickerOptionCopy}>
              <Text style={styles.pickerOptionLabel}>{destination.label}</Text>
              <Text style={styles.pickerOptionKind}>{destination.kind}</Text>
            </View>
            <View style={[styles.audiencePill, active && styles.audiencePillActive]}>
              <Text style={[styles.audiencePillText, active && styles.audiencePillTextActive]}>
                {destination.consequence}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function Composer({
  destinationId,
  value,
  pickerOpen,
  onChange,
  onTogglePicker,
  onSelectDestination,
  onSend,
}: {
  destinationId: DestinationId;
  value: string;
  pickerOpen: boolean;
  onChange: (text: string) => void;
  onTogglePicker: () => void;
  onSelectDestination: (id: DestinationId) => void;
  onSend: () => void;
}) {
  const destination = destinationFor(destinationId);
  const personal = destinationId === 'stream';

  return (
    <View style={styles.composerWrap}>
      {pickerOpen ? (
        <DestinationPicker
          selected={destinationId}
          onSelect={onSelectDestination}
          onClose={onTogglePicker}
        />
      ) : null}
      <View style={styles.composer}>
        <View style={styles.composerTopRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose destination"
            onPress={onTogglePicker}
            style={({ pressed }) => [styles.destinationButton, pressed && styles.pressed]}
          >
            <Avatar initials={destination.initials} color={destination.accent} size={26} />
            <Text style={styles.destinationTo}>To:</Text>
            <Text style={styles.destinationName}>{destination.label}</Text>
            <Text style={styles.destinationChevron}>⌄</Text>
          </Pressable>
          <View style={styles.consequenceWrap}>
            <View style={[styles.consequenceDot, { backgroundColor: destination.accent }]} />
            <Text style={styles.consequenceText}>{destination.consequence}</Text>
          </View>
        </View>
        <TextInput
          multiline
          value={value}
          onChangeText={onChange}
          placeholder={personal ? 'Capture what you are thinking…' : `Message ${destination.label}…`}
          placeholderTextColor="#8F8C84"
          style={styles.composerInput}
          textAlignVertical="top"
        />
        <View style={styles.composerFooter}>
          <View>
            <Text style={styles.composerHint}>
              {personal ? 'A thought in your root stream' : 'Add #idea to also save a thought'}
            </Text>
            {value.length > 0 ? <Text style={styles.draftStatus}>Draft kept for this destination</Text> : null}
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!value.trim()}
            onPress={onSend}
            style={({ pressed }) => [
              styles.sendButton,
              !value.trim() && styles.sendButtonDisabled,
              pressed && value.trim() ? styles.sendButtonPressed : null,
            ]}
          >
            <Text style={styles.sendButtonText}>{personal ? 'Add thought' : 'Send'}</Text>
            <Text style={styles.sendArrow}>→</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ThoughtCard({ thought, onOpenLens }: { thought: Thought; onOpenLens: (lens: LensId) => void }) {
  return (
    <View style={styles.thoughtCard}>
      <View style={styles.thoughtRail} />
      <View style={styles.thoughtContent}>
        <View style={styles.thoughtMetaRow}>
          <Text style={styles.thoughtTime}>{thought.time}</Text>
          {thought.source ? (
            <Pressable
              disabled={!thought.sourceLens}
              onPress={() => thought.sourceLens && onOpenLens(thought.sourceLens)}
              style={styles.sourceLink}
            >
              <Text style={styles.sourceLinkIcon}>↗</Text>
              <Text style={styles.sourceLinkText}>{thought.source}</Text>
            </Pressable>
          ) : (
            <Text style={styles.privateMeta}>Only you</Text>
          )}
        </View>
        <Text style={styles.thoughtBody}>{thought.body}</Text>
        <View style={styles.tagRow}>
          {thought.tags.map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>#{tag}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ThoughtStream({ thoughts, onOpenLens }: { thoughts: Thought[]; onOpenLens: (lens: LensId) => void }) {
  return (
    <>
      <View style={styles.pageHeader}>
        <Text style={styles.eyebrow}>YOUR ROOT</Text>
        <Text style={styles.pageTitle}>Thought Stream</Text>
        <Text style={styles.pageSubtitle}>Ideas, decisions, and saved moments from every conversation.</Text>
        <View style={styles.filterRow}>
          <View style={[styles.filterChip, styles.filterChipActive]}>
            <Text style={[styles.filterText, styles.filterTextActive]}>Everything</Text>
          </View>
          <View style={styles.filterChip}><Text style={styles.filterText}>Mine</Text></View>
          <View style={styles.filterChip}><Text style={styles.filterText}>Saved from chat</Text></View>
        </View>
      </View>
      <View style={styles.feedSection}>
        <View style={styles.feedLabelRow}>
          <Text style={styles.feedDate}>TODAY</Text>
          <View style={styles.feedRule} />
        </View>
        {thoughts.map((thought) => (
          <ThoughtCard key={thought.id} thought={thought} onOpenLens={onOpenLens} />
        ))}
      </View>
    </>
  );
}

function MessageRow({
  message,
  destination,
  onSave,
  onOpenThought,
}: {
  message: Message;
  destination: Destination;
  onSave: () => void;
  onOpenThought: () => void;
}) {
  return (
    <View style={[styles.messageRow, message.mine && styles.messageRowMine]}>
      {!message.mine ? <Avatar initials={message.initials} color={destination.accent} size={30} /> : null}
      <View style={[styles.messageColumn, message.mine && styles.messageColumnMine]}>
        <View style={styles.messageMetaRow}>
          <Text style={styles.messageAuthor}>{message.author}</Text>
          <Text style={styles.messageTime}>{message.time}</Text>
        </View>
        <View style={[styles.messageBubble, message.mine && styles.messageBubbleMine]}>
          <Text style={[styles.messageBody, message.mine && styles.messageBodyMine]}>{message.body}</Text>
        </View>
        {message.savedThoughtId ? (
          <Pressable onPress={onOpenThought} style={styles.savedThoughtLink}>
            <View style={styles.savedThoughtMark} />
            <Text style={styles.savedThoughtText}>Saved to My Stream</Text>
            <Text style={styles.savedThoughtArrow}>→</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onSave} style={styles.saveMessageButton}>
            <Text style={styles.saveMessagePlus}>+</Text>
            <Text style={styles.saveMessageText}>Save as thought</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ConversationLens({
  lens,
  messages,
  onSave,
  onOpenThought,
}: {
  lens: Exclude<LensId, 'stream'>;
  messages: Message[];
  onSave: (message: Message) => void;
  onOpenThought: () => void;
}) {
  const destination = destinationFor(lens);
  const group = lens === 'product';
  return (
    <>
      <View style={styles.conversationHeader}>
        <Avatar initials={destination.initials} color={destination.accent} size={42} />
        <View style={styles.conversationHeaderCopy}>
          <Text style={styles.eyebrow}>{group ? 'GROUP LENS' : 'DIRECT LENS'}</Text>
          <Text style={styles.conversationTitle}>{destination.label}</Text>
          <Text style={styles.conversationSubtitle}>
            {group ? '5 members · Product decisions and working notes' : 'Private · Just you and Maya'}
          </Text>
        </View>
        <View style={styles.lensRelation}>
          <View style={styles.lensRelationDot} />
          <Text style={styles.lensRelationText}>Lens on My Stream</Text>
        </View>
      </View>
      <View style={styles.chatDayRow}>
        <View style={styles.chatDayRule} />
        <Text style={styles.chatDayText}>RECENT</Text>
        <View style={styles.chatDayRule} />
      </View>
      <View style={styles.messageList}>
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            destination={destination}
            onSave={() => onSave(message)}
            onOpenThought={onOpenThought}
          />
        ))}
      </View>
    </>
  );
}

function ContextPanel({ activeLens, thoughts }: { activeLens: LensId; thoughts: Thought[] }) {
  const linked = thoughts.filter((thought) => thought.sourceLens === activeLens);
  return (
    <View style={styles.contextPanel}>
      <Text style={styles.contextEyebrow}>CONTEXT</Text>
      <Text style={styles.contextTitle}>{activeLens === 'stream' ? 'One stream, many lenses' : 'What this lens remembers'}</Text>
      <Text style={styles.contextBody}>
        {activeLens === 'stream'
          ? 'Your stream is the durable layer. Conversations stay lightweight until a moment is intentionally saved.'
          : `${linked.length} saved ${linked.length === 1 ? 'thought' : 'thoughts'} connect this conversation back to your root.`}
      </Text>

      <View style={styles.mapBlock}>
        <View style={styles.mapRoot}>
          <View style={styles.mapRootDot} />
          <View>
            <Text style={styles.mapRootTitle}>My Stream</Text>
            <Text style={styles.mapRootMeta}>{thoughts.length} thoughts</Text>
          </View>
        </View>
        <View style={styles.mapLine} />
        <View style={styles.mapLenses}>
          {(['maya', 'product'] as const).map((id) => {
            const destination = destinationFor(id);
            const active = activeLens === id;
            return (
              <View key={id} style={[styles.mapLens, active && styles.mapLensActive]}>
                <View style={[styles.mapLensDot, { backgroundColor: destination.accent }]} />
                <Text style={[styles.mapLensText, active && styles.mapLensTextActive]}>{destination.label}</Text>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.contextDivider} />
      <Text style={styles.contextEyebrow}>SAVED CONNECTIONS</Text>
      {(activeLens === 'stream' ? thoughts.filter((thought) => thought.source) : linked).slice(0, 2).map((thought) => (
        <View key={thought.id} style={styles.contextThought}>
          <View style={styles.contextThoughtMark} />
          <View style={styles.contextThoughtCopy}>
            <Text style={styles.contextThoughtBody} numberOfLines={3}>{thought.body}</Text>
            <Text style={styles.contextThoughtSource}>{thought.source}</Text>
          </View>
        </View>
      ))}
      {activeLens !== 'stream' && linked.length === 0 ? (
        <Text style={styles.contextEmpty}>No moments from this conversation have been saved yet.</Text>
      ) : null}
    </View>
  );
}

export function ThoughtStreamPrototype() {
  const { width } = useWindowDimensions();
  const showSidebar = width >= 820;
  const showContext = width >= 1180;
  const [activeLens, setActiveLens] = useState<LensId>('stream');
  const [destinationId, setDestinationId] = useState<DestinationId>('stream');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<DestinationId, string>>({
    stream: '',
    maya: '',
    product: '',
    research: '',
  });
  const [thoughts, setThoughts] = useState<Thought[]>(INITIAL_THOUGHTS);
  const [messages, setMessages] = useState(INITIAL_MESSAGES);

  const activeMessages = useMemo(
    () => (activeLens === 'stream' ? [] : messages[activeLens]),
    [activeLens, messages]
  );

  const selectLens = (lens: LensId) => {
    setActiveLens(lens);
    setDestinationId(lens);
    setPickerOpen(false);
  };

  const selectDestination = (id: DestinationId) => {
    setDestinationId(id);
    setPickerOpen(false);
  };

  const publish = () => {
    const body = drafts[destinationId].trim();
    if (!body) return;
    const now = 'Just now';

    if (destinationId === 'stream') {
      setThoughts((current) => [
        { id: `thought-${Date.now()}`, body, time: now, tags: body.includes('#idea') ? ['idea'] : ['note'] },
        ...current,
      ]);
      setActiveLens('stream');
    } else if (destinationId === 'maya' || destinationId === 'product') {
      const messageId = `message-${Date.now()}`;
      const savesThought = /(^|\s)#idea\b/i.test(body);
      const thoughtId = savesThought ? `thought-${Date.now()}` : undefined;
      const message: Message = {
        id: messageId,
        author: 'You',
        initials: 'JC',
        body,
        time: now,
        mine: true,
        savedThoughtId: thoughtId,
      };
      setMessages((current) => ({ ...current, [destinationId]: [...current[destinationId], message] }));
      if (savesThought && thoughtId) {
        setThoughts((current) => [
          {
            id: thoughtId,
            body: body.replace(/(^|\s)#idea\b/gi, '').trim(),
            time: now,
            tags: ['idea'],
            source: `Saved from ${destinationFor(destinationId).label}`,
            sourceLens: destinationId,
          },
          ...current,
        ]);
      }
      setActiveLens(destinationId);
    }

    setDrafts((current) => ({ ...current, [destinationId]: '' }));
  };

  const saveMessage = (lens: Exclude<LensId, 'stream'>, message: Message) => {
    const thoughtId = `thought-${Date.now()}`;
    setMessages((current) => ({
      ...current,
      [lens]: current[lens].map((item) => item.id === message.id ? { ...item, savedThoughtId: thoughtId } : item),
    }));
    setThoughts((current) => [
      {
        id: thoughtId,
        body: message.body.replace(/(^|\s)#idea\b/gi, '').trim(),
        time: 'Just now',
        tags: ['saved'],
        source: `Saved from ${destinationFor(lens).label}`,
        sourceLens: lens,
      },
      ...current,
    ]);
  };

  return (
    <View style={styles.root}>
      {showSidebar ? <Sidebar activeLens={activeLens} onSelect={selectLens} /> : null}
      <View style={styles.workspace}>
        {!showSidebar ? <CompactLensNav activeLens={activeLens} onSelect={selectLens} /> : null}
        <View style={styles.mainRow}>
          <View style={styles.centerPane}>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[styles.scrollContent, width < 700 && styles.scrollContentNarrow]}
              showsVerticalScrollIndicator={false}
            >
              {activeLens === 'stream' ? (
                <ThoughtStream thoughts={thoughts} onOpenLens={selectLens} />
              ) : (
                <ConversationLens
                  lens={activeLens}
                  messages={activeMessages}
                  onSave={(message) => saveMessage(activeLens, message)}
                  onOpenThought={() => selectLens('stream')}
                />
              )}
            </ScrollView>
            <Composer
              destinationId={destinationId}
              value={drafts[destinationId]}
              pickerOpen={pickerOpen}
              onChange={(text) => setDrafts((current) => ({ ...current, [destinationId]: text }))}
              onTogglePicker={() => setPickerOpen((open) => !open)}
              onSelectDestination={selectDestination}
              onSend={publish}
            />
          </View>
          {showContext ? <ContextPanel activeLens={activeLens} thoughts={thoughts} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#F4F2EC' },
  workspace: { flex: 1, minWidth: 0 },
  mainRow: { flex: 1, flexDirection: 'row', minHeight: 0 },
  centerPane: { flex: 1, minWidth: 0, backgroundColor: '#FBFAF7' },
  scroll: { flex: 1 },
  scrollContent: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 46, paddingTop: 48, paddingBottom: 36 },
  scrollContentNarrow: { paddingHorizontal: 20, paddingTop: 30 },
  pressed: { opacity: 0.72 },

  sidebar: { width: 260, backgroundColor: '#202522', paddingHorizontal: 17, paddingTop: 24, paddingBottom: 18, borderRightWidth: 1, borderRightColor: '#343A35' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 7, marginBottom: 26 },
  brandIcon: { width: 35, height: 35, borderRadius: 8 },
  brand: { color: '#F7F3E9', fontFamily: 'Georgia', fontSize: 20, fontWeight: '700' },
  prototypeLabel: { color: '#8F9B92', fontFamily: 'Avenir Next', fontSize: 8, fontWeight: '700', marginTop: 2 },
  newThoughtButton: { height: 42, borderRadius: 6, backgroundColor: '#C64B35', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 26 },
  newThoughtPlus: { color: '#FFF9F0', fontSize: 23, lineHeight: 23, fontWeight: '300' },
  newThoughtText: { color: '#FFF9F0', fontFamily: 'Avenir Next', fontSize: 13, fontWeight: '700' },
  sidebarHeading: { color: '#748078', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '700', marginHorizontal: 8, marginTop: 8, marginBottom: 6 },
  lensButton: { minHeight: 52, borderRadius: 6, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 3, borderWidth: 1, borderColor: 'transparent' },
  lensButtonActive: { backgroundColor: '#303732', borderColor: '#465048' },
  lensCopy: { flex: 1, minWidth: 0 },
  lensLabel: { color: '#C1C8C2', fontFamily: 'Avenir Next', fontSize: 12, fontWeight: '600' },
  lensLabelActive: { color: '#FFFDF7' },
  lensMeta: { color: '#78837B', fontFamily: 'Avenir Next', fontSize: 10, marginTop: 2 },
  lensCount: { color: '#A8B0AA', fontFamily: 'Avenir Next', fontSize: 10, minWidth: 18, textAlign: 'right' },
  sidebarSpacer: { flex: 1 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: '#343A35', paddingTop: 16, paddingHorizontal: 7 },
  identityName: { color: '#ECE9E1', fontFamily: 'Avenir Next', fontSize: 12, fontWeight: '600' },
  identityMeta: { color: '#78837B', fontFamily: 'Avenir Next', fontSize: 9, marginTop: 2 },

  compactNav: { backgroundColor: '#202522', paddingTop: 12, borderBottomWidth: 1, borderBottomColor: '#343A35' },
  compactBrand: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingBottom: 10 },
  compactBrandIcon: { width: 26, height: 26, borderRadius: 6 },
  compactBrandText: { color: '#F7F3E9', fontFamily: 'Georgia', fontSize: 18, fontWeight: '700' },
  compactTabs: { paddingHorizontal: 12, gap: 4 },
  compactTab: { paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  compactTabActive: { borderBottomColor: '#D76047' },
  compactTabText: { color: '#8F9B92', fontFamily: 'Avenir Next', fontSize: 11, fontWeight: '600' },
  compactTabTextActive: { color: '#FFFDF7' },

  avatar: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { color: '#FFFFFF', fontFamily: 'Avenir Next', fontWeight: '800' },

  pageHeader: { marginBottom: 38 },
  eyebrow: { color: '#A14735', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '800', marginBottom: 8 },
  pageTitle: { color: '#252724', fontFamily: 'Georgia', fontSize: 37, lineHeight: 43, fontWeight: '700' },
  pageSubtitle: { color: '#74736D', fontFamily: 'Avenir Next', fontSize: 13, lineHeight: 20, marginTop: 9, maxWidth: 560 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 22 },
  filterChip: { borderWidth: 1, borderColor: '#D9D6CE', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#FBFAF7' },
  filterChipActive: { backgroundColor: '#2B312D', borderColor: '#2B312D' },
  filterText: { color: '#6C6A64', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '600' },
  filterTextActive: { color: '#FFFDF7' },
  feedSection: { paddingBottom: 16 },
  feedLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 2 },
  feedDate: { color: '#9B968C', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '800' },
  feedRule: { flex: 1, height: 1, backgroundColor: '#E1DED6' },
  thoughtCard: { flexDirection: 'row', paddingVertical: 22, borderBottomWidth: 1, borderBottomColor: '#E7E3DA' },
  thoughtRail: { width: 3, borderRadius: 2, backgroundColor: '#C64B35', marginRight: 18 },
  thoughtContent: { flex: 1, minWidth: 0 },
  thoughtMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 9 },
  thoughtTime: { color: '#9B968C', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '600' },
  privateMeta: { color: '#9B968C', fontFamily: 'Avenir Next', fontSize: 9 },
  sourceLink: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '78%' },
  sourceLinkIcon: { color: '#58745F', fontSize: 11 },
  sourceLinkText: { color: '#58745F', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '600' },
  thoughtBody: { color: '#2B2C29', fontFamily: 'Georgia', fontSize: 18, lineHeight: 27 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 13 },
  tag: { backgroundColor: '#ECE9E1', borderRadius: 3, paddingHorizontal: 7, paddingVertical: 4 },
  tagText: { color: '#66645E', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '600' },

  conversationHeader: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: '#E1DED6', flexWrap: 'wrap' },
  conversationHeaderCopy: { flex: 1, minWidth: 180 },
  conversationTitle: { color: '#252724', fontFamily: 'Georgia', fontSize: 29, lineHeight: 34, fontWeight: '700' },
  conversationSubtitle: { color: '#7D7A73', fontFamily: 'Avenir Next', fontSize: 11, marginTop: 4 },
  lensRelation: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#D8D4CB', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  lensRelationDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#C64B35' },
  lensRelationText: { color: '#6E6B64', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '600' },
  chatDayRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 28 },
  chatDayRule: { flex: 1, height: 1, backgroundColor: '#E3E0D8' },
  chatDayText: { color: '#AAA59A', fontFamily: 'Avenir Next', fontSize: 8, fontWeight: '800' },
  messageList: { gap: 25, paddingBottom: 20 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, maxWidth: '82%' },
  messageRowMine: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
  messageColumn: { flexShrink: 1, minWidth: 0, alignItems: 'flex-start' },
  messageColumnMine: { alignItems: 'flex-end' },
  messageMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 5, paddingHorizontal: 2 },
  messageAuthor: { color: '#55564F', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '700' },
  messageTime: { color: '#A09C92', fontFamily: 'Avenir Next', fontSize: 9 },
  messageBubble: { backgroundColor: '#E9E6DE', borderRadius: 6, borderTopLeftRadius: 2, paddingHorizontal: 14, paddingVertical: 11 },
  messageBubbleMine: { backgroundColor: '#345B4A', borderTopLeftRadius: 6, borderTopRightRadius: 2 },
  messageBody: { color: '#353631', fontFamily: 'Avenir Next', fontSize: 12, lineHeight: 19 },
  messageBodyMine: { color: '#F9F8F3' },
  saveMessageButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7, paddingHorizontal: 2, paddingVertical: 3 },
  saveMessagePlus: { color: '#89867F', fontSize: 14, lineHeight: 14 },
  saveMessageText: { color: '#89867F', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '600' },
  savedThoughtLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7, backgroundColor: '#F0E7DC', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 5 },
  savedThoughtMark: { width: 3, height: 12, borderRadius: 2, backgroundColor: '#C64B35' },
  savedThoughtText: { color: '#8A4B3E', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '700' },
  savedThoughtArrow: { color: '#8A4B3E', fontSize: 11 },

  composerWrap: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 38, paddingBottom: 20, position: 'relative' },
  composer: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D8D4CA', borderRadius: 7, padding: 13, shadowColor: '#25221D', shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 6 } },
  composerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  destinationButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 7, minHeight: 30 },
  destinationTo: { color: '#8D8980', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '600' },
  destinationName: { color: '#30312D', fontFamily: 'Avenir Next', fontSize: 11, fontWeight: '800' },
  destinationChevron: { color: '#79766E', fontSize: 14, marginLeft: 1 },
  consequenceWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F2F0EA', borderRadius: 14, paddingHorizontal: 9, paddingVertical: 6 },
  consequenceDot: { width: 6, height: 6, borderRadius: 3 },
  consequenceText: { color: '#5D5B55', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '700' },
  composerInput: { minHeight: 58, maxHeight: 120, color: '#292A27', fontFamily: 'Georgia', fontSize: 15, lineHeight: 22, paddingHorizontal: 3, paddingTop: 11, paddingBottom: 8, outlineStyle: 'none' } as any,
  composerFooter: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderTopColor: '#EEECE6', paddingTop: 10 },
  composerHint: { color: '#969188', fontFamily: 'Avenir Next', fontSize: 9 },
  draftStatus: { color: '#58745F', fontFamily: 'Avenir Next', fontSize: 8, marginTop: 3 },
  sendButton: { minHeight: 34, borderRadius: 4, backgroundColor: '#C64B35', paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  sendButtonDisabled: { backgroundColor: '#CBC8C0' },
  sendButtonPressed: { backgroundColor: '#9E3827' },
  sendButtonText: { color: '#FFFFFF', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '800' },
  sendArrow: { color: '#FFFFFF', fontSize: 14 },

  picker: { position: 'absolute', left: 38, bottom: 155, width: 430, maxWidth: '92%', zIndex: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D1CDC2', borderRadius: 7, padding: 10, shadowColor: '#201D18', shadowOpacity: 0.16, shadowRadius: 28, shadowOffset: { width: 0, height: 10 } },
  pickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 10 },
  pickerEyebrow: { color: '#A14735', fontFamily: 'Avenir Next', fontSize: 8, fontWeight: '800' },
  pickerTitle: { color: '#292A27', fontFamily: 'Georgia', fontSize: 17, fontWeight: '700', marginTop: 3 },
  closeButton: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  closeButtonText: { color: '#716E67', fontSize: 22, lineHeight: 24 },
  pickerOption: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 8, borderRadius: 5, borderWidth: 1, borderColor: 'transparent' },
  pickerOptionActive: { backgroundColor: '#F3F0E9', borderColor: '#E1DDD3' },
  pickerOptionCopy: { flex: 1, minWidth: 0 },
  pickerOptionLabel: { color: '#30312D', fontFamily: 'Avenir Next', fontSize: 11, fontWeight: '700' },
  pickerOptionKind: { color: '#969188', fontFamily: 'Avenir Next', fontSize: 9, marginTop: 2 },
  audiencePill: { borderWidth: 1, borderColor: '#DDD9D0', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 },
  audiencePillActive: { backgroundColor: '#FFFFFF', borderColor: '#BFB9AD' },
  audiencePillText: { color: '#87837B', fontFamily: 'Avenir Next', fontSize: 8, fontWeight: '600' },
  audiencePillTextActive: { color: '#454641' },

  contextPanel: { width: 290, backgroundColor: '#F0EEE7', borderLeftWidth: 1, borderLeftColor: '#DEDAD0', paddingHorizontal: 24, paddingTop: 50, paddingBottom: 24 },
  contextEyebrow: { color: '#9B594B', fontFamily: 'Avenir Next', fontSize: 8, fontWeight: '800', marginBottom: 8 },
  contextTitle: { color: '#30312D', fontFamily: 'Georgia', fontSize: 19, lineHeight: 25, fontWeight: '700' },
  contextBody: { color: '#74716A', fontFamily: 'Avenir Next', fontSize: 10, lineHeight: 17, marginTop: 9 },
  mapBlock: { marginTop: 28, paddingLeft: 5 },
  mapRoot: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mapRootDot: { width: 13, height: 13, borderRadius: 7, borderWidth: 3, borderColor: '#C64B35', backgroundColor: '#F0EEE7' },
  mapRootTitle: { color: '#363733', fontFamily: 'Avenir Next', fontSize: 10, fontWeight: '800' },
  mapRootMeta: { color: '#99958C', fontFamily: 'Avenir Next', fontSize: 8, marginTop: 2 },
  mapLine: { width: 1, height: 26, backgroundColor: '#BDB9AF', marginLeft: 6 },
  mapLenses: { gap: 8 },
  mapLens: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 1, opacity: 0.62 },
  mapLensActive: { opacity: 1 },
  mapLensDot: { width: 11, height: 11, borderRadius: 6 },
  mapLensText: { color: '#74716A', fontFamily: 'Avenir Next', fontSize: 9, fontWeight: '600' },
  mapLensTextActive: { color: '#333430', fontWeight: '800' },
  contextDivider: { height: 1, backgroundColor: '#D8D4CA', marginVertical: 27 },
  contextThought: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 18 },
  contextThoughtMark: { width: 3, height: 31, borderRadius: 2, backgroundColor: '#C64B35' },
  contextThoughtCopy: { flex: 1 },
  contextThoughtBody: { color: '#55564F', fontFamily: 'Georgia', fontSize: 11, lineHeight: 17 },
  contextThoughtSource: { color: '#969188', fontFamily: 'Avenir Next', fontSize: 8, marginTop: 5 },
  contextEmpty: { color: '#969188', fontFamily: 'Avenir Next', fontSize: 10, lineHeight: 16 },
});
