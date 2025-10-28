import ngeohash from 'ngeohash';

import type { BoundingBox } from './bbox.js';

export interface TileInfo {
  hash: string;
  bounds: BoundingBox;
}

const decode = (hash: string): BoundingBox => {
  const [south, west, north, east] = ngeohash.decode_bbox(hash);
  return { south, west, north, east };
};

export const tilesForBoundingBox = (bbox: BoundingBox, precision: number): TileInfo[] => {
  const hashes = ngeohash.bboxes(bbox.south, bbox.west, bbox.north, bbox.east, precision);
  const unique = new Set(hashes);
  return Array.from(unique).map((hash) => ({ hash, bounds: decode(hash) }));
};

export const tileKey = (hash: string): string => `tile:${hash}`;
