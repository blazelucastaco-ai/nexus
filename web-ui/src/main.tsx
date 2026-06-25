import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// No StrictMode: this app holds long-lived stateful resources (a WebSocket, an
// AudioContext, a WebGL render loop). StrictMode's intentional double-mount in
// dev would churn them. Prod renders once anyway.
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

// Fade the boot splash once React has mounted and the orb has had a beat to
// start drawing — a smooth handoff instead of a black flash.
const splash = document.getElementById('boot-splash');
if (splash) {
  setTimeout(() => {
    splash.style.transition = 'opacity 0.6s ease';
    splash.style.opacity = '0';
    setTimeout(() => splash.remove(), 650);
  }, 450);
}
