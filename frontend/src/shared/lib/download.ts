export function download(value: unknown, filename: string, type = 'application/json'): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
