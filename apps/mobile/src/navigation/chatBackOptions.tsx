import { Platform, Text, View } from 'react-native';
import type { NativeStackNavigationOptions, NativeStackNavigationProp } from '@react-navigation/native-stack';
import { HeaderBarButton } from '../components/HeaderBarButton';
import { AppIcon } from '../components/AppIcon';
import type { RootStackParamList } from './types';

type ChatNavigation = Pick<NativeStackNavigationProp<RootStackParamList>, 'getState' | 'goBack' | 'navigate'>;

/** Web modals have no swipe-to-dismiss or automatic native back control. */
export function chatBackOptions(routeName: string, navigation: ChatNavigation, color: string): NativeStackNavigationOptions {
  if (Platform.OS !== 'web' || routeName === 'Conversations') return {};
  return {
    headerBackVisible: false,
    headerLeft: () => (
      <HeaderBarButton
        accessibilityLabel="Back"
        onPress={() => {
          // Stay inside this chat stack, even if a secondary screen was its
          // first route. Never send an embedded inbox back to login/the host.
          if (navigation.getState().index > 0) navigation.goBack();
          else navigation.navigate('Conversations');
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <AppIcon name="chevron-left" color={color} size={19} />
          <Text style={{ color, fontSize: 14, fontWeight: '600' }}>Back</Text>
        </View>
      </HeaderBarButton>
    ),
  };
}
