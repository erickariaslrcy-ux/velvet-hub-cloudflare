export function normalize(q: string) {
  return q
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Escapa los comodines de LIKE para que el texto se busque literal.
export function likeTerm(q: string) {
  return `%${normalize(q).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

/**
 * Valida estrictamente que un cómic coincida con todos los términos de búsqueda.
 * Evita que se muestren cómics no relacionados al buscar.
 */
export function itemMatchesQuery(
  item: { title?: string; tags?: string[]; artists?: string[]; search_text?: string },
  query: string
): boolean {
  const normQ = normalize(query);
  const words = normQ.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const normTitle = normalize(item.title || "");
  const normTags = (item.tags || []).map(normalize).join(" ");
  const normArtists = (item.artists || []).map(normalize).join(" ");
  const normSearchText = normalize(item.search_text || "");
  const fullText = `${normTitle} ${normTags} ${normArtists} ${normSearchText}`;

  return words.every((word) => fullText.includes(word));
}
