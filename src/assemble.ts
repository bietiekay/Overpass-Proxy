import type { BoundingBox } from './bbox.js';
import { filterElementsByBbox, type OverpassElement, type OverpassResponse } from './store.js';

const cloneElement = (element: OverpassElement): OverpassElement => {
  // Preserve runtime Overpass fields beyond the proxy's narrowed TS type.
  const cloned: OverpassElement = { ...element };
  const tags = element.tags;
  if (tags) {
    cloned.tags = { ...tags };
  }
  const nodes = element.nodes;
  if (nodes) {
    cloned.nodes = [...nodes];
  }
  const members = element.members;
  if (members) {
    cloned.members = members.map((member) => ({ ...member }));
  }
  return cloned;
};

export const combineResponses = (responses: OverpassResponse[], bbox: BoundingBox): OverpassResponse => {
  const metadata = responses.map((response) => ({
    version: response.version,
    generator: response.generator,
    osm3s: response.osm3s
  }));

  const elements = new Map<string, OverpassElement>();

  for (const response of responses) {
    const filteredElements = filterElementsByBbox(response.elements, bbox);

    for (const element of filteredElements) {
      const key = `${element.type}:${element.id}`;
      // Keep references while resolving duplicate precedence. Only the final
      // survivor for each key needs to be cloned into the assembled response.
      elements.set(key, element);
    }
  }

  const [firstMeta] = metadata;

  return {
    version: firstMeta?.version,
    generator: firstMeta?.generator,
    osm3s: firstMeta?.osm3s,
    elements: Array.from(elements.values(), cloneElement)
  };
};
