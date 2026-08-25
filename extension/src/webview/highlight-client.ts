import { HighlightClient } from './highlight-client-core.js';

const client = new HighlightClient();

declare global {
  interface Window {
    DriftHighlight?: {
      mount(root: ParentNode): void;
      reset(root: ParentNode): void;
      dispose(): void;
    };
  }
}

window.DriftHighlight = {
  mount: (root) => client.mount(root),
  reset: (root) => client.reset(root),
  dispose: () => client.dispose(),
};
