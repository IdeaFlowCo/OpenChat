import { useAppStamp } from '../hooks/useAppStamp';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { type } from '../theme/tokens';

export function AppStamp() {
  const { version, time, detail, label, exact, toggle } = useAppStamp();
  const { scheme } = useTheme();
  return <div style={{ textAlign: 'center', padding: 8, color: getColors(scheme).textMetadata, fontFamily: 'system-ui, sans-serif', fontSize: type.meta.fontSize, lineHeight: `${type.meta.lineHeight}px`, fontVariantNumeric: 'tabular-nums' }}>
    v{version}{time && <> · <button type="button" onClick={toggle} aria-pressed={exact} aria-label={`${label}. Show ${exact ? 'relative' : 'exact'} update time`} style={{ color: 'inherit', font: 'inherit', background: 'none', border: 0, padding: 0, cursor: 'pointer', fontVariantNumeric: 'inherit' }}><time dateTime={time} title={detail ?? undefined}>{label}</time></button></>}
  </div>;
}
