import { renderCatalog } from './catalog-view.js';

const host = document.getElementById('app');

async function boot() {
  const response = await fetch('/api/items');
  renderCatalog(host, await response.json());
}

void boot();
