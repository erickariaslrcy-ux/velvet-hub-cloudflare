export type Page = { index: number; image_url: string; referer?: string | null };
export type Chapter = { id: string; number: string; title: string; url: string; pages: Page[] };

// Fila completa (solo admin y servidor).
export type Item = {
  id: number;
  source: string;
  source_id: string;
  url: string;
  media_type: string;
  title: string;
  cover_url: string;
  language: string;
  tags: string[];
  artists: string[];
  page_count: number;
  pages: Page[];
  chapters: Chapter[];
  video_sources?: { quality?: string; url: string; referer?: string }[];
  status: string;
};

// Lo que ve un usuario normal (vista public.catalog).
export type CatalogItem = {
  id: number;
  source_label: string | null;
  media_type: string;
  title: string;
  language: string;
  tags: string[];
  artists: string[];
  page_count: number;
  page_total: number;
  chapters: { number: string; title: string; pages: number }[];
  video_sources?: { quality?: string; url: string; referer?: string }[];
  has_cover: boolean;
};

export const CARD_COLUMNS = "id,source_label,media_type,title,tags,page_count,has_cover";
export type CardItem = Pick<CatalogItem, "id" | "source_label" | "media_type" | "title" | "tags" | "page_count" | "has_cover">;
