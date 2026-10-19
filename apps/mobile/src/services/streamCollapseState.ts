export class StreamCollapseState {
  private viewers = new Map<string, Map<string, boolean>>();

  private onChange: () => void;

  constructor(onChange: () => void = () => undefined) { this.onChange = onChange; }

  read(viewer: string, id: string, fallback: boolean | undefined): boolean {
    return this.viewers.get(viewer)?.get(id) ?? fallback === true;
  }

  set(viewer: string, id: string, value: boolean): void {
    let entries = this.viewers.get(viewer);
    if (!entries) { entries = new Map(); this.viewers.set(viewer, entries); }
    if (entries.get(id) === value) return;
    entries.set(id, value);
    this.onChange();
  }

  ingest(viewer: string, items: readonly { id: string; collapsed?: boolean }[]): void {
    for (const item of items) {
      if (item.collapsed !== undefined) this.set(viewer, item.id, item.collapsed);
    }
  }
}
