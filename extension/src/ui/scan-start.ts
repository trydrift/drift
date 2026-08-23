export class OperationGate {
  private pending: Promise<void> | null = null;

  get active(): boolean {
    return this.pending !== null;
  }

  async run(task: () => Promise<void>): Promise<'started' | 'busy'> {
    if (this.pending) return 'busy';

    this.pending = task();
    try {
      await this.pending;
      return 'started';
    } finally {
      this.pending = null;
    }
  }
}
