export const CLIENT_AUTH_HEADER = 'x-overpass-proxy-token';
export const CLIENT_AUTH_HEADER_NAME = 'X-Overpass-Proxy-Token';

const REDACTED = '[REDACTED]';
const SENSITIVE_HEADERS = new Set([
  'authorization',
  CLIENT_AUTH_HEADER,
  'proxy-authorization'
]);

const toHeaderRecord = (headers: Record<string, unknown> | undefined): Record<string, unknown> =>
  headers ? { ...headers } : {};

export const readHeaderValue = (
  headers: Record<string, unknown> | undefined,
  headerName: string
): string | null => {
  const normalisedName = headerName.toLowerCase();

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== normalisedName) {
      continue;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string') {
          continue;
        }
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
};

export const readClientAuthToken = (headers: Record<string, unknown> | undefined): string | null =>
  readHeaderValue(headers, CLIENT_AUTH_HEADER);

export const sanitiseHeadersForLogs = (
  headers: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const sanitised = toHeaderRecord(headers);

  for (const key of Object.keys(sanitised)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      sanitised[key] = REDACTED;
    }
  }

  return sanitised;
};

export const stripHeader = (
  headers: Record<string, string | string[] | undefined>,
  headerName: string
): Record<string, string | string[] | undefined> => {
  const normalisedName = headerName.toLowerCase();
  const stripped: Record<string, string | string[] | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalisedName) {
      continue;
    }
    stripped[key] = value;
  }

  return stripped;
};

export const isApiRequestPath = (url: string): boolean => {
  const pathname = url.split('?', 1)[0] ?? url;
  return pathname === '/api' || pathname.startsWith('/api/');
};
