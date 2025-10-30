import type { BoundingBox } from './bbox.js';
import type { OverpassElement, OverpassResponse } from './store.js';

const cloneElement = (element: OverpassElement): OverpassElement => {
  const cloned: OverpassElement = { ...element };
  if (element.tags) {
    cloned.tags = { ...element.tags };
  }
  if (element.nodes) {
    cloned.nodes = [...element.nodes];
  }
  if (element.members) {
    cloned.members = element.members.map((member) => ({ ...member }));
  }
  return cloned;
};

export const combineResponses = (responses: OverpassResponse[], _bbox: BoundingBox): OverpassResponse => {
  const metadata = responses.map((response) => ({
    version: response.version,
    generator: response.generator,
    osm3s: response.osm3s
  }));

  const elements = new Map<string, OverpassElement>();

  for (const response of responses) {
    for (const element of response.elements) {
      const key = `${element.type}:${element.id}`;
      elements.set(key, cloneElement(element));
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
