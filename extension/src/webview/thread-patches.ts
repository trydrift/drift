export interface TranscriptScrollAdjustmentArgs {
  atBottom: boolean;
  threadTop: number;
  threadBottom: number;
  previousTop: number;
  previousBottom: number;
  previousHeight: number;
  nextHeight: number;
}

export function transcriptScrollAdjustment(args: TranscriptScrollAdjustmentArgs): 'bottom' | number | null {
  if (args.atBottom) return 'bottom';
  if (args.previousBottom <= args.threadTop) return args.nextHeight - args.previousHeight;
  if (args.previousTop >= args.threadBottom) return null;
  return null;
}
