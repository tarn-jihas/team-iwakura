// Renders the real WorkspaceApp against API responses captured from the seeded server.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceApp } from '../../src/modules/analytics';
import { ToastProvider } from '../../src/shared';
import report from '../fixtures/report.json';
import manifest from '../fixtures/manifest.json';
import audit from '../fixtures/audit.json';
import history from '../fixtures/history.json';
import operations from '../fixtures/operations.json';
import samples from '../fixtures/samples.json';
import preview from '../fixtures/preview.json';
import accessReport from '../fixtures/access_report.json';

const ROUTES: Record<string, unknown> = {
  '/api/report': report, '/api/manifest': manifest, '/api/audit': audit, '/api/history': history,
  '/api/operations': operations, '/api/samples': samples, '/api/preview': preview, '/api/access/report': accessReport,
};

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="overlay-root"></div><div id="toast-root"></div>';
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const body = ROUTES[path];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body ?? { error: 'not found' } } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(<ToastProvider><WorkspaceApp /></ToastProvider>, { container: document.getElementById('app')! });
}

test('Cases overview shows both cases and the analytics gap per currency', async () => {
  mount();
  expect(await screen.findByRole('heading', { name: 'Cases' })).toBeInTheDocument();
  expect(screen.getByText('Paid access denied after renewal cancellation')).toBeInTheDocument();
  const money = document.querySelector('.case-money')!;
  expect(money).toHaveTextContent('+21.97 USD');
  expect(money).toHaveTextContent('+989.01 EUR');
});

test('The case page keeps the original markup: six finding groups and currency cards', async () => {
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole('button', { name: 'Open analytics case' }));
  expect(document.querySelectorAll('article.mock-group')).toHaveLength(6);
  expect(document.querySelectorAll('.currency-card')).toHaveLength(2);
  expect(document.querySelector('.currency-card .currency-gap')).toHaveTextContent('+21.97');
});

test('Approval gating: Approve needs a group and the acknowledgement; Apply needs a saved approval', async () => {
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole('button', { name: 'Open analytics case' }));
  await user.click(screen.getAllByRole('button', { name: 'Review & preview' })[0]);
  const dialog = await screen.findByRole('dialog');
  const approve = within(dialog).getByRole('button', { name: 'Approve selected groups' });
  const apply = within(dialog).getByRole('button', { name: 'Apply approved selection' });
  expect(approve).toBeDisabled();
  expect(apply).toBeDisabled();
  await user.click(dialog.querySelector('input[data-select]') as HTMLInputElement);
  expect(approve).toBeDisabled();
  await user.click(within(dialog).getByRole('checkbox', { name: /I reviewed the evidence/ }));
  expect(approve).toBeEnabled();
  expect(apply).toBeDisabled();
  expect(document.getElementById('app')!.inert).toBe(true);
});

test('Escape closes the dialog and the app is interactive again', async () => {
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole('button', { name: 'Open analytics case' }));
  await user.click(screen.getAllByRole('button', { name: 'Review & preview' })[0]);
  await screen.findByRole('dialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(document.getElementById('app')!.inert).toBe(false);
});
