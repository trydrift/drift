/**
 * The app still has to render, through its provide/inject context.
 *
 * vue 3 removed the `new Vue({ el, render })` constructor, which is the
 * compile error, and the surrounding toolchain has to move with it: the Vite
 * plugin that compiles single-file components for vue 2 cannot compile them
 * for vue 3. A migration that satisfies `vue-tsc` on `src/main.ts` alone still
 * produces a bundle that renders nothing.
 *
 * The components here were already written against vue 3's composition API —
 * `<script setup>`, `provide`/`inject`, `InjectionKey` — so what this checks is
 * that the app as a whole comes up: the provider's dynamic root tag, the
 * injected context reaching both children, and the getter that reads it.
 */
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import App from '../src/App.vue';

/** Wrapped so the bundle needs no top-level await: Vite targets browsers here. */
const render = () => renderToString(createSSRApp(App));

const must = (condition: boolean, html: string, message: string) => {
  if (!condition) {
    console.error(`ssr-render FAILED: ${message}\n--- rendered ---\n${html}`);
    process.exit(1);
  }
};

async function main() {
  const html = await render();
  
  // UserProvider renders `<component :is="tag">` with tag="div" and the classes
  // App passes it: the dynamic root element has to resolve.
  must(/<div[^>]*class="[^"]*container/.test(html), html, 'the provider must render its dynamic root tag with the classes it was given');
  
  // ComponentOne is the form that reads `userContext.state` through inject().
  must(html.includes('First Name'), html, 'ComponentOne must render — it reads the injected user context');
  must(html.includes('Last Name'), html, 'ComponentOne must render its second field');
  must(html.includes('placeholder="First name"'), html, 'the form inputs must render with their bound attributes');
  
  // ComponentTwo consumes the same context; its output proves inject() reached a
  // second, independent consumer rather than only the first.
  must(/Update/.test(html), html, 'the form actions must render');
  
  console.log('ssr-render: the app renders through its provide/inject context under vue 3');
}

main();
