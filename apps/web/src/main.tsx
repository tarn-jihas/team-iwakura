import { render } from 'preact';
import { App } from './App';
import { MockWorkspace } from './MockWorkspace';
import { AccessWorkspace } from './AccessWorkspace';
import { RecoveryConsole } from './RecoveryConsole';
import { LegacyLab } from './LegacyLab';
import { resolveRoute } from './routes';
import '../../../Reconcile/dist/styles.css';
import '../../../Reconcile/dist/monitor.css';
import '../../../Reconcile/dist/mock.css';
import '../../../Reconcile/dist/access.css';
import '../../../Reconcile/dist/recovery.css';

const root = document.querySelector('#app');
const route = resolveRoute(window.location.pathname);
const page = route === 'analytics' ? <MockWorkspace />
  : route === 'access' ? <AccessWorkspace />
    : route === 'recovery' ? <RecoveryConsole />
      : route === 'legacy' ? <LegacyLab />
        : <App />;
if (root) render(page, root);
