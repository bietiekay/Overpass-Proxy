import { describe, expect, it } from 'vitest';

import { combineResponses } from '../../assemble.js';

const sample = {
  version: 0.6,
  generator: 'test',
  osm3s: {},
  elements: [
    { type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'cafe' } },
    { type: 'node', id: 2, lat: 2, lon: 2, tags: { amenity: 'bar' } },
    { type: 'way', id: 3, nodes: [1] },
    { type: 'way', id: 4, nodes: [2, 99] },
    { type: 'relation', id: 5, members: [{ type: 'node', ref: 1, role: 'outer' }] },
    { type: 'relation', id: 6, members: [{ type: 'node', ref: 2, role: 'outer' }] }
  ]
};

describe('combineResponses', () => {
  it('deduplicates elements', () => {
    const result = combineResponses([sample, sample], { south: 0, west: 0, north: 2, east: 2 });
    expect(result.elements).toHaveLength(6);
  });

  it('filters elements outside of the requested bounding box, including ways and relations', () => {
    const result = combineResponses([sample], { south: 1.5, west: 1.5, north: 3, east: 3 });

    const ids = result.elements.map((element) => element.id);
    expect(ids).toEqual([2, 4, 6]);
  });

  it('returns cloned elements when within the bounding box', () => {
    const result = combineResponses([sample], { south: 0, west: 0, north: 2, east: 2 });
    const node = result.elements.find((element) => element.type === 'node');
    const way = result.elements.find((element) => element.type === 'way');

    expect(node).toEqual(sample.elements[0]);
    expect(node).not.toBe(sample.elements[0]);
    expect(node?.tags).not.toBe(sample.elements[0].tags);

    expect(way).toEqual(sample.elements[2]);
    expect(way?.nodes).not.toBe(sample.elements[2].nodes);
  });
});
