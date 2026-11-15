type Handler = (event: KeyboardEvent) => void;

// The shell owns the only document listener. A focused split layout may
// handle its local menus/selection before the shell's route fallback.
const handlers = new Set<Handler>();

export function registerDesktopKeyboardHandler(handler: Handler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function dispatchDesktopKeyboardHandler(event: KeyboardEvent): boolean {
  const handler = [...handlers].at(-1);
  if (!handler) return false;
  handler(event);
  return true;
}
