export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const numberPattern = /-?\d+(?:\.\d+)?/g;

const normaliseTuple = (tuple: string): BoundingBox | null => {
  const matches = tuple.match(numberPattern);
  if (!matches || matches.length !== 4) {
    return null;
  }

  const [south, west, north, east] = matches.map((value) => Number(value));
  if ([south, west, north, east].some((value) => Number.isNaN(value))) {
    return null;
  }

  return { south, west, north, east };
};

const stripComments = (query: string): string =>
  query.replace(/\/[/*].*?\*\//gs, '').replace(/--.*$/gm, '').replace(/#/gm, '');

export const extractBoundingBox = (query: string): BoundingBox | null => {
  const cleaned = stripComments(query);

  const bboxDirective = cleaned.match(/\[\s*bbox\s*:\s*([^\]]+)\]/i);
  if (bboxDirective) {
    const candidate = normaliseTuple(bboxDirective[1]);
    if (candidate) {
      return candidate;
    }
  }

  const tupleMatches = cleaned.match(/\(([^()]*?-?\d[^()]*)\)/g);
  if (tupleMatches) {
    for (const tuple of tupleMatches) {
      const candidate = normaliseTuple(tuple);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
};

export const hasJsonOutput = (query: string): boolean => /out\s*:\s*json/i.test(query);

export const hasAmenityFilter = (query: string): boolean => /\[\s*(?:"amenity"|'amenity'|amenity)/i.test(query);

export const extractAmenityValue = (query: string): string | null => {
  const cleaned = stripComments(query);
  const match = cleaned.match(
    /\[\s*(?:"amenity"|'amenity'|amenity)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]"';\s]+))\s*\]/i
  );

  if (!match) {
    return null;
  }

  const value = match[1] ?? match[2] ?? match[3] ?? '';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};
