import type { BoundingBox } from './bbox.js';
import type { TileInfo } from './tiling.js';

export interface TileFetchGroup {
  bounds: BoundingBox;
  tiles: TileInfo[];
}

const area = (bounds: BoundingBox): number => {
  const width = Math.max(0, bounds.east - bounds.west);
  const height = Math.max(0, bounds.north - bounds.south);
  return width * height;
};

const expandBounds = (current: BoundingBox, addition: BoundingBox): BoundingBox => {
  return {
    south: Math.min(current.south, addition.south),
    west: Math.min(current.west, addition.west),
    north: Math.max(current.north, addition.north),
    east: Math.max(current.east, addition.east)
  };
};

const groupCoarseTiles = (tiles: TileInfo[], targetSize: number): TileFetchGroup[] => {
  if (tiles.length === 0) {
    return [];
  }

  const sorted = [...tiles].sort((a, b) => a.hash.localeCompare(b.hash));
  const groups: TileFetchGroup[] = [];

  let currentTiles: TileInfo[] = [];
  let currentBounds: BoundingBox | null = null;
  let referenceArea = 0;

  for (const tile of sorted) {
    const tileArea = area(tile.bounds);

    if (!currentBounds) {
      currentBounds = { ...tile.bounds };
      currentTiles = [tile];
      referenceArea = tileArea;
      continue;
    }

    if (currentTiles.length >= targetSize) {
      groups.push({ bounds: currentBounds, tiles: [...currentTiles] });
      currentBounds = { ...tile.bounds };
      currentTiles = [tile];
      referenceArea = tileArea;
      continue;
    }

    const nextBounds = expandBounds(currentBounds, tile.bounds);
    const nextArea = area(nextBounds);
    const nextReferenceArea = Math.max(referenceArea, tileArea);
    const areaLimit = nextReferenceArea * targetSize;

    if (areaLimit > 0 && nextArea > areaLimit) {
      groups.push({ bounds: currentBounds, tiles: [...currentTiles] });
      currentBounds = { ...tile.bounds };
      currentTiles = [tile];
      referenceArea = tileArea;
      continue;
    }

    currentBounds = nextBounds;
    currentTiles.push(tile);
    referenceArea = nextReferenceArea;
  }

  if (currentBounds && currentTiles.length > 0) {
    groups.push({ bounds: currentBounds, tiles: [...currentTiles] });
  }

  return groups;
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

    const grouped = groupCoarseTiles(coarseTiles, desiredTilesPerRequest);
    groups.push(...grouped);
  }

  return sortGroups(groups);
};
