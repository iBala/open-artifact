/** Boots the app. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { ThemeProvider } from './theme.jsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('the page is missing its root element');

// The theme sits outside everything, including the signed-in/signed-out split:
// somebody reading a public artifact with no account chose dark for a reason,
// and signing in or out is not a reason to change it.
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
