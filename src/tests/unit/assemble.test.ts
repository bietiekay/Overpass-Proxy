import { describe, expect, it } from 'vitest';

import { combineResponses } from '../../assemble.js';

const sample = {
  version: 0.6,
  generator: 'test',
  osm3s: {},
  elements: [
    { type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'cafe' } },
    { type: 'way', id: 2, nodes: [1, 2] }
  ]
};

describe('combineResponses', () => {
  it('deduplicates elements', () => {
    const result = combineResponses([sample, sample], { south: 0, west: 0, north: 2, east: 2 });
    expect(result.elements).toHaveLength(2);
  });

  it('filters nodes outside of the requested bounding box', () => {
    const result = combineResponses([sample], { south: 1.5, west: 1.5, north: 3, east: 3 });

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toEqual(sample.elements[1]);
  });

  it('returns cloned elements when within the bounding box', () => {
    const result = combineResponses([sample], { south: 0, west: 0, north: 2, east: 2 });
    const node = result.elements.find((element) => element.type === 'node');
    const way = result.elements.find((element) => element.type === 'way');

    expect(node).toEqual(sample.elements[0]);
    expect(node).not.toBe(sample.elements[0]);
    expect(node?.tags).not.toBe(sample.elements[0].tags);

    expect(way).toEqual(sample.elements[1]);
    expect(way?.nodes).not.toBe(sample.elements[1].nodes);
  });
});
