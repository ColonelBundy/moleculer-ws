/**
 * Moleculer-ws
 * Copyright (c) 2018 ColonelBundy (https://github.com/colonelbundy/moleculer-ws)
 * MIT Licensed
 */

export class SocketNotOpen extends Error {
  constructor(message = 'Socket not open') {
    super(message);
  }
}

export class NotAuthorized extends Error {
  constructor(message = 'UnAuthorized') {
    super(message);
  }
}

export class RouteNotFound extends Error {
  constructor(message = 'Route not found') {
    super(message);
  }
}

export class EncodeError extends Error {
  constructor(message?) {
    super('Unable to encode packet' + (message ? ' - ' + message : ''));
  }
}

export class DecodeError extends Error {
  constructor(message?) {
    super('Unable to decode packet' + (message ? ' - ' + message : ''));
  }
}

export class ServiceNotAvailable extends Error {
  constructor(message = 'Service is currently not available') {
    super(message);
  }
}

export class EndpointNotAvailable extends Error {
  constructor(message = 'Endpoint is currently not available') {
    super(message);
  }
}

export class StraightError extends Error {
  constructor(message) {
    super(message);
  }
}

export class ClientError extends Error {
  constructor(message) {
    super(message);
  }
}
