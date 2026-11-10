import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TOP_TAGS = [
  "MILF",
  "Full Color",
  "Harem",
  "Sin Censura",
  "3D CGI",
  "Anal",
  "Manhwa",
  "Doujinshi",
  "Parodias",
  "Cosplay",
  "Casadas",
  "Superheroes",
  "Western Comic",
  "POV",
  "Amateur",
  "Tetonas",
];

export async function GET() {
  return NextResponse.json({
    tags: TOP_TAGS,
    total: TOP_TAGS.length,
  });
}
