import { referenceBytes } from '../../../capture/subflowHandoff.js';
/** Fixed reference budget shared by seed and selector observations. Names only, no values retained. */
export class ReadPrefix {
  private readonly keys = new Set<string>();
  private items = 0;
  private chars = 0;
  exhausted = false;
  unavailable = false;
  read(key: string | undefined): void {
    if (key === undefined) {
      this.unavailable = true;
      return;
    }
    if (!this.keys.has(key) && this.spend(referenceBytes(key), 1)) this.keys.add(key);
  }

  spend(chars: number, items: number): boolean {
    if (this.chars + chars > 64 * 1024 || this.items + items > 4096) {
      this.exhausted = true;
      return false;
    }
    this.chars += chars;
    this.items += items;
    return true;
  }

  snapshot(): readonly string[] {
    return Object.freeze([...this.keys]);
  }
}
