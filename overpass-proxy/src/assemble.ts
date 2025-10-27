import mergeDeep from 'merge-deep';

import type { BoundingBox } from './bbox.js';
import type { OverpassElement, OverpassResponse } from './store.js';
import { filterElementsByBbox } from './store.js';

export const combineResponses = (responses: OverpassResponse[], bbox: BoundingBox): OverpassResponse => {
  const metadata = responses.map((response) => ({
    version: response.version,
    generator: response.generator,
    osm3s: response.osm3s
  }));

  const elements = new Map<string, OverpassElement>();

  for (const response of responses) {
    for (const element of filterElementsByBbox(response.elements, bbox)) {
      const key = `${element.type}:${element.id}`;
      elements.set(key, mergeDeep({}, element));
    }
  }

  const [firstMeta] = metadata;

  return {
    version: firstMeta?.version,
    generator: firstMeta?.generator,
    osm3s: firstMeta?.osm3s,
    elements: Array.from(elements.values())
  };
};
