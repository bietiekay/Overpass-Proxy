import ngeohash from 'ngeohash';

import type { BoundingBox } from './bbox.js';

export interface TileInfo {
  hash: string;
  bounds: BoundingBox;
}

const BASE32_SYMBOLS = 32;

export const mergeGeohashes = (hashes: Set<string>, minPrecision: number): Set<string> => {
  if (hashes.size === 0) {
    return hashes;
  }

  const byLength = new Map<number, Set<string>>();
  for (const hash of hashes) {
    const bucket = byLength.get(hash.length) ?? new Set<string>();
    bucket.add(hash);
    byLength.set(hash.length, bucket);
  }

  const maxPrecision = Math.max(...byLength.keys());

  for (let length = maxPrecision; length > minPrecision; length -= 1) {
    const current = byLength.get(length);
    if (!current || current.size === 0) {
      continue;
    }

    const parents = byLength.get(length - 1) ?? new Set<string>();
    const childrenByParent = new Map<string, Set<string>>();

    for (const hash of current) {
      const parent = hash.slice(0, length - 1);
      const children = childrenByParent.get(parent) ?? new Set<string>();
      children.add(hash);
      childrenByParent.set(parent, children);
    }

    for (const [parent, children] of childrenByParent) {
      if (children.size === BASE32_SYMBOLS) {
        parents.add(parent);
        for (const child of children) {
          current.delete(child);
        }
      }
    }

    if (parents.size > 0) {
      byLength.set(length - 1, parents);
    }
  }

  const merged = new Set<string>();
  for (const bucket of byLength.values()) {
    for (const hash of bucket) {
      merged.add(hash);
    }
  }

  return merged;
};

export const boundsForHash = (hash: string): BoundingBox => {
  const [south, west, north, east] = ngeohash.decode_bbox(hash);
  return { south, west, north, east };
};

export const tilesForBoundingBox = (bbox: BoundingBox, precision: number): TileInfo[] => {
  const hashes = ngeohash.bboxes(bbox.south, bbox.west, bbox.north, bbox.east, precision);
  const unique = new Set(hashes);
  // Keep the configured precision to avoid mixing fresh writes with stale child tiles in coverage stats.
  const merged = mergeGeohashes(unique, precision);
  return Array.from(merged).map((hash) => ({ hash, bounds: boundsForHash(hash) }));
};

export const tileKey = (hash: string, amenity: string): string => `tile:${amenity}:${hash}`;
