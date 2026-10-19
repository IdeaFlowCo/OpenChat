export class StreamCollapseState {
  private viewers = new Map<string, Map<string, { base?: boolean; value: boolean }>>();

  read(viewer: string, id: string, server: boolean | undefined): boolean {
    const entries = this.viewers.get(viewer);
    const entry = entries?.get(id);
    if (!entry) return server === true;
    if (entry.base === undefined) entry.base = server;
    if (server !== undefined && entry.base !== server) {
      entries?.delete(id);
      return server;
    }
    return entry.value;
  }

  set(viewer: string, id: string, value: boolean, base?: boolean): void {
    let entries = this.viewers.get(viewer);
    if (!entries) { entries = new Map(); this.viewers.set(viewer, entries); }
    entries.set(id, { base: entries.get(id)?.base ?? base, value });
  }
}
