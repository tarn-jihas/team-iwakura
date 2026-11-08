import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../Reconcile/dist/styles.css';
import '../../../Reconcile/dist/mock.css';
import { WorkspaceApp } from '../modules/analytics';
import { ToastProvider } from '../shared';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ToastProvider duration={6000}>
      <WorkspaceApp />
    </ToastProvider>
  </StrictMode>,
);
