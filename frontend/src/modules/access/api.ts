import { createClient } from '../../shared';

/** The access module may call only the recovery API and the Lumen client simulator. */
export const request = createClient(['/api/access/', '/mock/lumen/'], 'Recovery server');
