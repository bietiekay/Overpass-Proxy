import { describe, expect, it } from 'vitest';

import { extractBoundingBox, hasAmenityFilter, hasJsonOutput } from '../../bbox.js';

describe('extractBoundingBox', () => {
  it('extracts bbox from tuple syntax', () => {
    const query = `node(1.0,2.0,3.0,4.0);out:json;`;
    expect(extractBoundingBox(query)).toEqual({ south: 1, west: 2, north: 3, east: 4 });
  });

  it('extracts bbox from directive syntax', () => {
    const query = `[bbox:1.1,2.2,3.3,4.4];node;out:json;`;
    expect(extractBoundingBox(query)).toEqual({ south: 1.1, west: 2.2, north: 3.3, east: 4.4 });
  });

  it('ignores malformed tuples', () => {
    const query = `node(1,2,3);out:json;`;
    expect(extractBoundingBox(query)).toBeNull();
  });

  it('strips comments', () => {
    const query = `/* comment */ node(1,2,3,4); // inline\nout:json;`;
    expect(extractBoundingBox(query)).toEqual({ south: 1, west: 2, north: 3, east: 4 });
  });
});

describe('hasJsonOutput', () => {
  it('detects json output', () => {
    expect(hasJsonOutput('out:json;')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(hasJsonOutput('OUT:JSON;')).toBe(true);
  });

  it('returns false when not json', () => {
    expect(hasJsonOutput('out:xml;')).toBe(false);
  });
});

describe('hasAmenityFilter', () => {
  it('detects amenity filter with value', () => {
    expect(hasAmenityFilter('node["amenity"="toilets"];')).toBe(true);
  });

  it('detects amenity existence filter', () => {
    expect(hasAmenityFilter('node["amenity"];')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(hasAmenityFilter('node["AMENITY"];')).toBe(true);
  });

  it('returns false when amenity absent', () => {
    expect(hasAmenityFilter('node["shop"];')).toBe(false);
  });
});
