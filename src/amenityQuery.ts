import { isValidBoundingBox, type BoundingBox } from './bbox.js';

export interface ParsedAmenityQuery {
  amenity: string;
  bbox: BoundingBox;
  output: 'json' | 'xml';
}

const numberPattern = /-?\d+(?:\.\d+)?/g;
const setCommandPattern =
  /\b(node|way|relation)\s*\[\s*(?:"amenity"|'amenity'|amenity)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]"';\s]+))\s*\]\s*\(([^()]*)\)/gi;
const directivePattern = /\[\s*(out|timeout|bbox|range|maxdate|mindate|adiff)\s*:[^\]]*\]\s*;?/gi;
const outForms = new Set(['body', 'skel', 'tags', 'geom']);

const normaliseTuple = (tuple: string): BoundingBox | null => {
  const trimmed = tuple.trim();
  const value = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
  if (!/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(value)) {
    return null;
  }
  const matches = value.match(numberPattern);
  if (!matches || matches.length !== 4) return null;
  const [south, west, north, east] = matches.map(Number);
  return isValidBoundingBox(south, west, north, east) ? { south, west, north, east } : null;
};

const parseOutClauseCount = (query: string): number | null => {
  const clauses: string[] = [];
  const outPattern = /\bout\s*(?:body|skel|tags|geom)?(?:\s+(?:meta|qt))*\s*(?=[;)\n\r]|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = outPattern.exec(query)) !== null) {
    clauses.push(match[0]);
    const tokens = match[0].toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => !['out', ...outForms, 'meta', 'qt'].includes(token))) return null;
  }
  if (/\bout\s+(?!body|skel|tags|geom|meta|qt\s|;\s|$)[a-z]+/i.test(query)) return null;
  return clauses.length;
};

/** Parse only the QL subset accepted by the AmenityOverpass server. */
export const parseAmenityQuery = (query: string): ParsedAmenityQuery | null => {
  const cleaned = query.replace(/\/\*.*?\*\//gs, '').trim();
  if (!cleaned) return null;

  const directives = [...cleaned.matchAll(/\[\s*([a-z]+)\s*:\s*([^\]]*)\]/gi)];
  if (directives.some(([, rawName, rawValue]) => {
    const name = rawName.toLowerCase();
    const value = rawValue.trim().toLowerCase();
    return name === 'out' ? !['json', 'xml'].includes(value) : name !== 'timeout' || !/^\d+$/.test(value);
  })) return null;

  const output = /\bout\s*:\s*json/i.test(cleaned) ? 'json' : 'xml';
  const withoutDirectives = cleaned.replace(directivePattern, ' ');
  const amenities = new Set<string>();
  const boxes = new Set<string>();
  const matches: Array<{ start: number; end: number }> = [];
  setCommandPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = setCommandPattern.exec(withoutDirectives)) !== null) {
    const amenity = (match[2] ?? match[3] ?? match[4] ?? '').trim().toLowerCase();
    const bbox = normaliseTuple(match[5]);
    if (!amenity || !bbox) return null;
    amenities.add(amenity);
    boxes.add(`${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  if (!matches.length || amenities.size !== 1 || boxes.size !== 1) return null;

  const withoutAmenityFilters = withoutDirectives
    .replace(/\[\s*(?:"amenity"|'amenity'|amenity)\s*=\s*(?:"[^"]*"|'[^']*'|[^\]"';\s]+)\s*\]/gi, '')
    .replace(/\[\s*(?:"amenity"|'amenity'|amenity)\s*\]/gi, '');
  if (/\[\s*["']?[a-zA-Z_][\w:]*["']?\s*[=~]/.test(withoutAmenityFilters)) return null;

  const clauseCount = parseOutClauseCount(cleaned);
  if (clauseCount === null) return null;
  const includeMembers = /(^|;)\s*>\s*;/m.test(cleaned);
  if (clauseCount !== (includeMembers ? 2 : 1)) return null;
  if ((cleaned.match(/\s*>\s*;/g) ?? []).length !== (includeMembers ? 1 : 0)) return null;

  const outMatches = [...withoutDirectives.matchAll(/\bout\s*(?:body|skel|tags|geom)?(?:\s+(?:meta|qt))*\s*;/gi)];
  const firstSet = Math.min(...matches.map(({ start }) => start));
  const lastSet = Math.max(...matches.map(({ end }) => end));
  if (outMatches.length !== clauseCount || outMatches[0].index === undefined || lastSet > outMatches[0].index) return null;
  const prefix = withoutDirectives.slice(0, firstSet);
  const selectorTail = withoutDirectives.slice(lastSet, outMatches[0].index);
  const wrapped = /^\s*\(\s*$/.test(prefix) && /^\s*;?\s*\)\s*;?\s*$/.test(selectorTail);
  if (!/^\s*(?:\(\s*)?$/.test(prefix) || !/^\s*;?\s*\)?\s*;?\s*$/.test(selectorTail)) return null;
  if (matches.length > 1 && !wrapped) return null;
  const firstOutEnd = outMatches[0].index + outMatches[0][0].length;
  if (includeMembers) {
    const secondOutStart = outMatches[1]?.index;
    if (secondOutStart === undefined || !/^\s*>\s*;\s*$/.test(withoutDirectives.slice(firstOutEnd, secondOutStart))) return null;
  } else if (!/^\s*$/.test(withoutDirectives.slice(firstOutEnd))) {
    return null;
  }

  const remainder = withoutDirectives
    .replace(setCommandPattern, ' ')
    .replace(/\bout\s*(?:body|skel|tags|geom)?(?:\s+(?:meta|qt))*\s*;/gi, ' ')
    .replace(/\s*>\s*;/g, ' ')
    .replace(/[();\s]+/g, '');
  if (remainder.length) return null;

  const bboxDirective = cleaned.match(/\[\s*bbox\s*:\s*([^\]]+)\]/i);
  const bbox = normaliseTuple(bboxDirective?.[1] ?? `(${[...boxes][0]})`);
  if (!bbox) return null;
  return { amenity: [...amenities][0], bbox, output };
};
