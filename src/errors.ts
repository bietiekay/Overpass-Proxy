export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class TooManyTilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyTilesError';
  }
}

export class UpstreamError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = statusCode;
  }
}
