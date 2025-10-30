import { describe, expect, it } from 'vitest';

import { combineResponses } from '../../assemble.js';

const sample = {
  version: 0.6,
  generator: 'test',
  osm3s: {},
  elements: [
    { type: 'node', id: 1, lat: 1, lon: 1 },
    { type: 'way', id: 2, nodes: [1, 2] }
  ]
};

describe('combineResponses', () => {
  it('deduplicates elements', () => {
    const result = combineResponses([sample, sample], { south: 0, west: 0, north: 2, east: 2 });
    expect(result.elements).toHaveLength(2);
  });

  it('returns cloned elements without additional filtering', () => {
    const result = combineResponses([sample], { south: 1.5, west: 1.5, north: 3, east: 3 });
    const node = result.elements.find((element) => element.type === 'node');
    expect(node).toEqual(sample.elements[0]);
    expect(node).not.toBe(sample.elements[0]);
  });
});
