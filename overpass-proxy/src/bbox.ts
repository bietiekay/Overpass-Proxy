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

export const extractBoundingBox = (query: string): BoundingBox | null => {
  const cleaned = query
    .replace(/\/[/*].*?\*\//gs, '')
    .replace(/--.*$/gm, '')
    .replace(/#/gm, '');

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

export const hasAmenityFilter = (query: string): boolean => /\[\s*"amenity"/i.test(query);
