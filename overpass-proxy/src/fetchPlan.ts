import type { BoundingBox } from './bbox.js';
import type { TileInfo } from './tiling.js';

export interface TileFetchGroup {
  bounds: BoundingBox;
  tiles: TileInfo[];
}

const unionBounds = (tiles: TileInfo[]): BoundingBox => {
  const first = tiles[0];
  if (!first) {
    throw new Error('Cannot compute bounds for empty tile set');
  }

  let { south, west, north, east } = first.bounds;

  for (let index = 1; index < tiles.length; index += 1) {
    const bounds = tiles[index]?.bounds;
    if (!bounds) {
      continue;
    }

    if (bounds.south < south) south = bounds.south;
    if (bounds.west < west) west = bounds.west;
    if (bounds.north > north) north = bounds.north;
    if (bounds.east > east) east = bounds.east;
  }

  return { south, west, north, east };
};

const area = (bounds: BoundingBox): number => {
  const width = Math.max(0, bounds.east - bounds.west);
  const height = Math.max(0, bounds.north - bounds.south);
  return width * height;
};

const mergeGroups = (groups: TileFetchGroup[], targetCount: number): TileFetchGroup[] => {
  if (groups.length <= targetCount) {
    return groups;
  }

  const working = [...groups];

  while (working.length > targetCount) {
    let bestPair: [number, number] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const groupA = working[i];
        const groupB = working[j];
        if (!groupA || !groupB) {
          continue;
        }

        const combinedTiles = [...groupA.tiles, ...groupB.tiles];
        const combinedBounds = unionBounds(combinedTiles);
        const areaIncrease = area(combinedBounds) - area(groupA.bounds) - area(groupB.bounds);
        const totalTiles = combinedTiles.length;
        const score = areaIncrease / Math.max(1, totalTiles);

        if (score < bestScore) {
          bestScore = score;
          bestPair = [i, j];
        }
      }
    }

    if (!bestPair) {
      break;
    }

    const [indexA, indexB] = bestPair;
    const groupA = working[indexA];
    const groupB = working[indexB];
    if (!groupA || !groupB) {
      break;
    }

    const mergedTiles = [...groupA.tiles, ...groupB.tiles];
    const mergedBounds = unionBounds(mergedTiles);
    const merged: TileFetchGroup = { bounds: mergedBounds, tiles: mergedTiles };

    if (indexA > indexB) {
      working.splice(indexA, 1);
      working.splice(indexB, 1);
    } else {
      working.splice(indexB, 1);
      working.splice(indexA, 1);
    }

    working.push(merged);
  }

  return working;
};

const sortGroups = (groups: TileFetchGroup[]): TileFetchGroup[] => {
  return [...groups].sort((a, b) => {
    if (a.bounds.south !== b.bounds.south) {
      return a.bounds.south - b.bounds.south;
    }
    if (a.bounds.west !== b.bounds.west) {
      return a.bounds.west - b.bounds.west;
    }
    if (a.bounds.north !== b.bounds.north) {
      return a.bounds.north - b.bounds.north;
    }
    return a.bounds.east - b.bounds.east;
  });
};

interface PlanOptions {
  coarsePrecision: number;
  finePrecision: number;
  targetTilesPerRequest?: number;
}

const clampTargetTiles = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 16;
  }
  return Math.min(256, Math.max(8, Math.floor(value)));
};

export const planTileFetches = (tiles: TileInfo[], options: PlanOptions): TileFetchGroup[] => {
  if (tiles.length === 0) {
    return [];
  }

  const diff = Math.max(0, options.finePrecision - options.coarsePrecision);
  const estimatedChildren = Math.pow(32, diff);
  const defaultTarget = clampTargetTiles(estimatedChildren / 8);
  const desiredTilesPerRequest = options.targetTilesPerRequest
    ? clampTargetTiles(options.targetTilesPerRequest)
    : defaultTarget;

  const byCoarse = new Map<string, TileInfo[]>();
  for (const tile of tiles) {
    const precision = Math.min(options.coarsePrecision, tile.hash.length);
    const prefix = tile.hash.slice(0, precision);
    const existing = byCoarse.get(prefix);
    if (existing) {
      existing.push(tile);
    } else {
      byCoarse.set(prefix, [tile]);
    }
  }

  const groups: TileFetchGroup[] = [];

  for (const coarseTiles of byCoarse.values()) {
    if (coarseTiles.length === 0) {
      continue;
    }

    const initialGroups: TileFetchGroup[] = coarseTiles.map((tile) => ({
      bounds: tile.bounds,
      tiles: [tile]
    }));

    const targetCount = Math.max(1, Math.ceil(coarseTiles.length / desiredTilesPerRequest));
    const merged = mergeGroups(initialGroups, targetCount);
    groups.push(...merged);
  }

  return sortGroups(groups);
};
