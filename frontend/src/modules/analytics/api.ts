import { createClient } from '../../shared';

/** The analytics workspace may call the analytics API and the Adapty/Mixpanel mocks. */
export const api = createClient(['/api/', '/mock/'], 'Local server');
