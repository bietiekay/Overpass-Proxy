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

  it('uses the last duplicate while retaining the key first-seen position', () => {
    const first = { type: 'node' as const, id: 10, lat: 1, lon: 1, tags: { source: 'first' } };
    const middle = { type: 'node' as const, id: 11, lat: 1, lon: 1 };
    const replacement = { type: 'node' as const, id: 10, lat: 2, lon: 2, tags: { source: 'last' } };
    Object.assign(replacement, { timestamp: '2026-10-25T00:00:00Z' });
    const response = combineResponses([
      { version: 0.6, generator: 'first response', osm3s: { timestamp_osm_base: 'first' }, elements: [first, middle] },
      { version: 0.7, generator: 'second response', osm3s: { timestamp_osm_base: 'second' }, elements: [replacement] }
    ], { south: 0, west: 0, north: 3, east: 3 });

    expect(response.elements.map((element) => element.id)).toEqual([10, 11]);
    expect(response.elements[0]).toEqual(replacement);
    expect((response.elements[0] as typeof replacement & { timestamp: string }).timestamp).toBe('2026-10-25T00:00:00Z');
    expect(response.version).toBe(0.6);
    expect(response.generator).toBe('first response');
    expect(response.osm3s).toEqual({ timestamp_osm_base: 'first' });
  });

  it('clones only surviving members and isolates nested member objects', () => {
    let overwrittenMembersReads = 0;
    let winningMembersReads = 0;
    const overwritten = { type: 'relation' as const, id: 20, members: [{ type: 'node', ref: 1, role: 'old' }] };
    const winner = { type: 'relation' as const, id: 20, members: [{ type: 'node', ref: 1, role: 'new' }] };
    const winningMember = { type: 'node', ref: 1, role: 'new' };
    Object.defineProperty(overwritten, 'members', { get: () => { overwrittenMembersReads++; return [{ type: 'node', ref: 1, role: 'old' }]; } });
    Object.defineProperty(winner, 'members', { get: () => { winningMembersReads++; return [winningMember]; } });

    const output = combineResponses([
      { elements: [{ type: 'node', id: 1, lat: 0.5, lon: 0.5 }, overwritten] },
      { elements: [{ type: 'node', id: 1, lat: 0.5, lon: 0.5 }, winner] }
    ], { south: 0, west: 0, north: 1, east: 1 });
    expect(overwrittenMembersReads).toBe(1); // Used by bbox filtering only.
    expect(winningMembersReads).toBe(3); // Filtering plus spread and one nested clone read.
    const member = output.elements.find((element) => element.type === 'relation')?.members?.[0];
    expect(member).toEqual({ type: 'node', ref: 1, role: 'new' });
    expect(member).not.toBe(winningMember);
    if (member) member.role = 'mutated';
    expect(winningMember.role).toBe('new');
  });
});
