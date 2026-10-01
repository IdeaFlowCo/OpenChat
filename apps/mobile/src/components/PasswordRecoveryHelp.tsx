import { useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { getColors } from '../theme/colors';

export const GOOGLE_ACCOUNT_RECOVERY_URL = 'https://accounts.google.com/signin/recovery';
export const APPLE_ACCOUNT_RECOVERY_URL = 'https://iforgot.apple.com/';

export function PasswordRecoveryHelp({ colors, providerResetUrl = null }: {
  colors: ReturnType<typeof getColors>;
  providerResetUrl?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const openRecovery = async (url: string) => {
    setLinkError(false);
    try {
      await Linking.openURL(url);
    } catch {
      setLinkError(true);
    }
  };
  const linkStyle = { color: colors.primary, fontWeight: '600' as const, fontSize: 14 };
  const textStyle = { color: colors.textSecondary, fontSize: 14, lineHeight: 21 };
  return (
    <View style={{ marginTop: 12 }}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Forgot password?"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
        style={{ alignSelf: 'center', paddingVertical: 10 }}
      >
        <Text style={linkStyle}>Forgot password?</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={{ gap: 12 }}>
          <Text style={textStyle}>
            Used Google? Choose Continue with Google. A Google-only account has no OpenChat password to reset.
          </Text>
          <TouchableOpacity accessibilityRole="link" onPress={() => void openRecovery(GOOGLE_ACCOUNT_RECOVERY_URL)}>
            <Text style={linkStyle}>Recover your Google account</Text>
          </TouchableOpacity>
          <Text style={textStyle}>
            Used Apple? Choose Sign in with Apple in the iPhone app. An Apple-only account has no OpenChat password to reset.
          </Text>
          <TouchableOpacity accessibilityRole="link" onPress={() => void openRecovery(APPLE_ACCOUNT_RECOVERY_URL)}>
            <Text style={linkStyle}>Recover your Apple account</Text>
          </TouchableOpacity>
          <Text style={textStyle}>
            The email and password fields here use your existing Noos account. Password recovery for that account is not available in OpenChat yet.
          </Text>
          <Text style={textStyle}>
            {providerResetUrl
              ? 'For an Ideaflow ID password account only, reset your password with Ideaflow ID. This does not reset a Noos password or link accounts.'
              : 'Ideaflow ID password recovery is not available from OpenChat yet. If you used Google with Ideaflow ID, continue with Google there.'}
          </Text>
          {providerResetUrl && (
            <TouchableOpacity accessibilityRole="link" onPress={() => void openRecovery(providerResetUrl)}>
              <Text style={linkStyle}>Reset Ideaflow ID password</Text>
            </TouchableOpacity>
          )}
          {linkError && <Text accessibilityRole="alert" style={textStyle}>Could not open account recovery. Please try again.</Text>}
        </View>
      )}
    </View>
  );
}
