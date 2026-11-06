import { ScrollView } from 'react-native';
import { PublishedAsks } from '../components/PublishedAsks';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
export function SharedAsksScreen() { return <ScrollView style={{ backgroundColor: getColors(useTheme().scheme).background }}><PublishedAsks /></ScrollView>; }
