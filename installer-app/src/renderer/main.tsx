import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MainApp } from './MainApp';
import './styles.css';

// Detect which UI to render. The main process either loads the URL with
// `?route=dashboard` or just index.html (wizard default). Additional args
// via additionalArguments also land on process.argv, but the renderer
// can't read those — URL search is the canonical channel.
const url = new URL(window.location.href);
const route = url.searchParams.get('route') ?? 'wizard';

if (route === 'dashboard') {
  document.body.classList.add('route-dashboard');
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      {route === 'dashboard' ? <MainApp /> : <App />}
    </React.StrictMode>,
  );
}
