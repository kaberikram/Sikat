import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary, installGlobalErrorHandlers} from './ui/error-boundary';
import {preloadXrUiFonts} from './scene/xr/xr-ui-chrome';
import './index.css';

installGlobalErrorHandlers();

// Start fetching Baloo 2 now so XR canvas textures rasterize the real font.
preloadXrUiFonts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
