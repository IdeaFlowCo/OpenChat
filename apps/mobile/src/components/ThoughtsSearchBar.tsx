import React, { useState } from 'react';
import { Keyboard, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { AppIcon } from './AppIcon';
import { StreamTextInput } from './StreamEditor';

export interface ThoughtsSearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
  testID?: string;
  conversationId?: string;
  onCreate?: (text: string) => void;
}

/**
 * ThoughtsSearchBar — shared search bar for ThoughtsScreen and ConversationThoughtsScreen.
 * Screens own search debounce; StreamTextInput owns advisory tag suggestions.
 */
export function ThoughtsSearchBar({
  value,
  onChangeText,
  placeholder = 'Search or create a Stream entry',
  onClear,
  testID,
  conversationId,
  onCreate,
}: ThoughtsSearchBarProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [focused, setFocused] = useState(false);

  const handleClear = () => {
    onChangeText('');
    onClear?.();
  };

  // iOS search-bar convention: Cancel clears the query and ends editing.
  const handleCancel = () => {
    handleClear();
    Keyboard.dismiss();
  };

  return (
    <View style={[styles.searchWrap, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.row}>
        <View style={styles.inputContainer}>
          <StreamTextInput
            conversationId={conversationId}
            testID={testID}
            style={[
              styles.searchInput,
              {
                backgroundColor: c.surfaceElevated,
                color: c.textPrimary,
                borderColor: c.border,
                paddingRight: value ? 34 : 12,
              },
            ]}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            accessibilityLabel={placeholder}
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {value.length > 0 && (
            <TouchableOpacity
              onPress={handleClear}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={styles.clearBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <AppIcon name="x" color={c.textMuted} size={15} />
            </TouchableOpacity>
          )}
        </View>
        {focused && Platform.OS !== 'web' && (
          <TouchableOpacity
            onPress={handleCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel search"
            style={styles.cancelBtn}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
          >
            <Text style={{ color: c.primary, fontSize: 15 }}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
      {onCreate && <TouchableOpacity onPress={() => onCreate(value.trim())} accessibilityRole="button" style={{ paddingTop: 10, paddingBottom: 4 }}>
        <Text style={{ color: c.primary, fontWeight: '600' }}>{value.trim() ? `Create “${value.trim()}”` : 'Create entry'}</Text>
      </TouchableOpacity>}
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputContainer: {
    flex: 1,
    position: 'relative',
    justifyContent: 'center',
  },
  searchInput: {
    height: 38,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12,
    fontSize: 14,
  },
  cancelBtn: {
    paddingLeft: 12,
    height: 38,
    justifyContent: 'center',
  },
  clearBtn: {
    position: 'absolute',
    right: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
