import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../Reconcile/dist/styles.css';
import '../../../Reconcile/dist/mock.css';
import '../../../Reconcile/dist/access.css';
import { AccessApp } from '../modules/access';
import { ToastProvider } from '../shared';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ToastProvider duration={6500} withIcon={false}>
      <AccessApp />
    </ToastProvider>
  </StrictMode>,
);
