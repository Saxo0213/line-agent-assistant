import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import './virtual.css';
import './theme.css';
import './line-media.css';
import './permissions.css';
import './chat-resources.css';
import { install as installScrollbarVisibility } from './scrollbar-visibility.js';

installScrollbarVisibility();

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
let lastFailureReportedAt = -Infinity;
const reportFailure = () => {
  const now = Date.now();
  if (now - lastFailureReportedAt < 30_000) return;
  lastFailureReportedAt = now;
  void window.lineAgent?.reportRendererFailure?.().catch(() => undefined);
};
createRoot(root, { onUncaughtError: reportFailure, onCaughtError: reportFailure, onRecoverableError: reportFailure })
  .render(<React.StrictMode><App /></React.StrictMode>);
