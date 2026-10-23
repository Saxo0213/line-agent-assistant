import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import './virtual.css';
import './theme.css';
import './line-media.css';
import './permissions.css';
import { install as installScrollbarVisibility } from './scrollbar-visibility.js';

installScrollbarVisibility();

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
