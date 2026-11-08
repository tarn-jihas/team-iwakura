// Public surface of the shared kernel. Feature modules import only from here.
export { money, pretty, h } from './lib/format';
export { download } from './lib/download';
export { createClient, fetchText, ApiError } from './api/client';
export type { RequestOptions } from './api/client';
export { Icon } from './ui/Icon';
export type { IconName } from './ui/Icon';
export { Badge, MockBadge, Button, Heading, Currencies, JsonBlock, BusyContext } from './ui/primitives';
export type { Tone } from './ui/primitives';
export { ToastProvider, useToast } from './ui/toast';
export { Drawer, useFocusReturn } from './ui/Drawer';
export { useAsyncRunner } from './lib/runner';
