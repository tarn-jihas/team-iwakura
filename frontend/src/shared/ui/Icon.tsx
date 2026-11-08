/** Same stroke icons as the original workspace (static, trusted SVG path data). */
const PATHS = {
  logo: '<path d="M5 4h9v4H5zM10 16h9v4h-9zM5 8v8h5M14 8h5v8M8 12h8"/>',
  cases: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16M8 14h8m-8 3h5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  flask: '<path d="M9 3h6m-5 0v7L4 20h16l-6-10V3M7 16h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  money: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  duplicate: '<rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/>',
  missing: '<path d="M7 3h10v18H7V3ZM3 12h18"/>',
  link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 7M4 12l2 7a8 8 0 0 0 13-2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName | string; size?: number }) {
  const path = PATHS[name as IconName] ?? PATHS.cases;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: path }} />
  );
}
