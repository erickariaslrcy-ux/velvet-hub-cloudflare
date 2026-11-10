export function imgSrc(id: number, page = 0, chapter?: number) {
  const p = new URLSearchParams({ i: String(id), p: String(page) });
  if (chapter !== undefined) p.set("c", String(chapter));
  return `/api/img?${p.toString()}`;
}
