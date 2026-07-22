import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import './base.css';
import './components/reader_components/reader.css';
import { theme } from './theme';
import App from './App';

/* Zamrożenie safe-area: na Androidzie (edge-to-edge) env(safe-area-inset-*)
   zmienia się przy chowaniu/pokazywaniu pasków przeglądarki, co zmienia
   padding czytnika i wywołuje reflow paginacji. Mierzymy raz (i po obrocie)
   i nadpisujemy dynamiczne env() z base.css stałymi wartościami px. */
function freezeSafeArea() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
    'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const root = document.documentElement.style;
  root.setProperty('--safe-top', cs.paddingTop);
  root.setProperty('--safe-right', cs.paddingRight);
  root.setProperty('--safe-bottom', cs.paddingBottom);
  root.setProperty('--safe-left', cs.paddingLeft);
  probe.remove();
}
freezeSafeArea();
window.addEventListener('orientationchange', () => setTimeout(freezeSafeArea, 250));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <App />
    </MantineProvider>
  </StrictMode>
);
