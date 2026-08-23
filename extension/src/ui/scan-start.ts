export class ScanStartGate {
  private pending: Promise<void> | null = null;

  get active(): boolean {
    return this.pending !== null;
  }

  async run(task: () => Promise<void>): Promise<'started' | 'already-starting'> {
    if (this.pending) return 'already-starting';

    this.pending = task();
    try {
      await this.pending;
      return 'started';
    } finally {
      this.pending = null;
    }
  }
}
