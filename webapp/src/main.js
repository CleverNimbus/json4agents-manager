import { createApp } from './lib/vue.esm-browser.prod.js';
import App from './App.js';
import { initStore } from './store.js';

initStore()
  .then(() => {
    createApp(App).mount('#app');
  })
  .catch((err) => {
    console.error(err);
    const el = document.getElementById('app');
    if (el) el.textContent = 'Failed to start: ' + err.message;
  });
