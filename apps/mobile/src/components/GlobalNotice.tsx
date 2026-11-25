import { useNotice } from '../services/notice';
import { ToastMessage } from './ToastMessage';

/** Mounted once in App.tsx; announces itself politely to screen readers. */
export function GlobalNotice() {
  const notice = useNotice();
  return <ToastMessage key={notice?.id ?? 0} visible={!!notice} message={notice?.message ?? ''} duration={3000} />;
}
