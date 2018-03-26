/**
 * Moleculer-ws
 * Copyright (c) 2018 ColonelBundy (https://github.com/colonelbundy/moleculer-ws)
 * MIT Licensed
 */

import http = require('http');
import https = require('https');
import moleculer = require('moleculer');
import uws = require('uws'); // Maybe add support for turbo-ws as well? (once it has reached 1.0) https://github.com/hugmanrique/turbo-ws
import timer = require('nanotimer');
import _ = require('lodash');
import nanomatch = require('nanomatch');
import shortid = require('shortid');
import Bluebird = require('bluebird');
import {
  Service,
  Action,
  Event,
  Method,
  BaseSchema
} from 'moleculer-decorators';
import { EventEmitter2 } from 'eventemitter2';
import {
  SocketNotOpen,
  NotAuthorized,
  RouteNotFound,
  ClientError,
  EncodeError,
  DecodeError,
  EndpointNotAvailable,
  ServiceNotAvailable
} from './errors';

interface Flags {
  binary: boolean;
  masked: boolean;
}

export enum PacketType {
  EVENT,
  ACTION,
  RESPONSE,
  PROPS
}

export interface Packet {
  ack?: number; // Should be set by client if he wants a response
  type: PacketType;
  payload: ActionPacket | EventPacket | ResponsePacket | object;
}

export interface ActionPacket {
  name: string;
  action: string;
  data: any;
}

export interface EventPacket {
  event: string;
  data: any;
}

interface ResponsePacket {
  id: number;
  data: any;
}

export interface Settings {
  port: number;
  ip?: string;
  externalAuth?: {
    enabled: boolean;
    endpoint: string; // eg: 'users.auth' where 'users' is the service and 'auth' the action
  };
  heartbeat?: {
    enabled: boolean;
    interval?: number;
  };
  eventEmitter?: {
    wildcard: boolean;
    maxListeners: number;
  };
  perMessageDeflate?: boolean;
  encryption?: 'Binary' | 'JSON' | encryption;
  decryption?: decryption;
  path: string;
  routes?: route[];
  https?: {
    key: string;
    cert: string;
  };
}

interface external_client_payload {
  id: string;
  props: moleculer.GenericObject;
}

interface external_client_send {
  id: string;
  packet: EventPacket;
}

// @TODO
// * Convert to class
// * add functions that when called gets executed on node where the client lives, eg: .emit/.call
interface external_client extends external_client_payload {
  nodeID: string;
}

export interface callOptions {
  timeout: number;
  retryCount: number;
  fallbackResponse(ctx, err): void;
}

export interface aliases {
  [name: string]: string;
}

export interface Request {
  action: string;
  sender: {
    id: string;
    props: moleculer.GenericObject;
  };
  params: moleculer.ActionParams;
}

export interface route {
  name: string;
  aliases?: aliases;
  whitelist?: string[];
  authorization?: boolean;
  mappingPolicy?: 'strict' | 'all';
  onAfterCall?(
    ctx: moleculer.Context,
    req: Request,
    res: any
  ): Bluebird<moleculer.Context | moleculer.GenericObject>;
  onBeforeCall?(
    ctx: moleculer.Context,
    req: Request
  ): Bluebird<moleculer.Context | moleculer.GenericObject>;
  callOptions?: callOptions;
  onError?(req, res, err): void;
}

type encryption = (packet: Packet) => Bluebird<Buffer | string | any>;
type decryption = (message: Buffer | string | any) => Bluebird<Packet>;

class Client {
  private readonly server: WSGateway;
  private logger: moleculer.LoggerInstance;
  public readonly id: string = shortid.generate();
  public readonly socket: uws;
  public authorized: boolean = false;
  public props: moleculer.GenericObject = {}; // Store for username etc..
  public alive: boolean = true;
  public ack_id: 0;

  /**
   * Creates an instance of Client.
   * @param {uws} _socket
   * @param {WSGateway} _server
   * @memberof Client
   */
  constructor(_socket: uws, _server: WSGateway) {
    this.socket = _socket;
    this.server = _server;
    this.logger = this.server.broker.logger;

    // Sync prop updates to all nodes, if you were to modify the object,
    this.props = new Proxy(
      {},
      {
        set: (obj, prop, value) => {
          obj[prop] = value;

          this.server.broker.broadcast(
            'ws.client.update',
            {
              id: this.id,
              props: obj
            },
            'ws'
          );

          // Send update to client as well.
          if (this.socket.readyState === this.socket.OPEN) {
            this.server
              .EncodePacket({
                payload: obj,
                type: PacketType.PROPS
              })
              .then(payload => this.socket.send(payload));
          }

          return true;
        }
      }
    );

    this.socket.on('message', this.messageHandler.bind(this));
    this.socket.on('pong', () => (this.alive = true));
  }

  /**
   * Close client connection
   *
   * @memberof Client
   */
  public Close(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.close();
  }

  /**
   * Send to client
   *
   * @param {string} event
   * @param {object} data
   * @returns {Bluebird<{}>}
   * @memberof Client
   */
  public emit(event: string, data: object): Bluebird<{}> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new SocketNotOpen());
      }

      this.server
        .EncodePacket({
          payload: { event, data },
          type: PacketType.EVENT
        })
        .then(result => {
          this.socket.send(result);
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Handler to allow a response to an event
   *
   * @public
   * @param {any} data
   * @param {any} [ack]
   * @returns {(err: any, data: any) => void}
   * @memberof Client
   */
  public ResponseCallback(data, ack?): (err: any, data?: any) => void {
    const _self = this;
    return function(err, data?) {
      if (_.isNil(ack)) {
        // No need to send back a response if the clien't doesn't want one.
        return;
      }

      if (err) {
        _self
          .SendResponse(new ClientError(err), ack)
          .catch(e => _self.logger.error(e));
      } else {
        _self.SendResponse(data, ack).catch(e => _self.logger.error(e));
      }
    };
  }

  /**
   * Handle incomming packets
   *
   * @private
   * @param {(Buffer | string)} packet
   * @memberof Client
   */
  private messageHandler(packet: Buffer | string): void {
    let _ack: number; // To respend if client want a response;

    this.logger.debug('Incoming message', packet);
    this.server
      .DecodePacket(packet)
      .then(result => {
        _ack = result.ack;

        this.logger.info('ACK: ', _ack);

        if (result.type === PacketType.ACTION) {
          const { name, action, data } = <ActionPacket>result.payload;

          this.logger.debug('Action packet');
          if (name === 'internal' && action === 'auth') {
            this.logger.debug('Auth action');
            if (!this.authorized) {
              if (
                this.server.settings.externalAuth &&
                this.server.settings.externalAuth.enabled
              ) {
                this.logger.debug('External auth action');

                const endpoint = this.server.settings.externalAuth.endpoint.split(
                  '.'
                );

                return this.server
                  .CallAction(this, endpoint[0], endpoint[1], data)
                  .then(resp => {
                    this.authorized = true;
                    return Bluebird.resolve(resp);
                  });
              }

              this.logger.debug('Internal auth action');
              return Bluebird.Promise.method(this.server.authorize)
                .call(this, this, data)
                .then(resp => {
                  this.authorized = true;
                  return Bluebird.resolve(resp);
                })
                .catch(e => {
                  return Bluebird.reject(new ClientError(e));
                });
            } else {
              return Bluebird.Promise.reject(
                new ClientError('Already authenticated')
              );
            }
          } else {
            this.logger.debug('User defined system action');
            return this.server.CallAction(this, name, action, data);
          }
        } else if (result.type === PacketType.EVENT) {
          const { event, data } = <EventPacket>result.payload;

          // Server listener
          /* Works as: 
              this.on('action_name', (data, client, respond) => {
                respond(error, data_to_respond_with) // to respond to this particular request.
                client.emit(....) // to send anything else to the client.
                this.emit(...) // to send to everyone on this node
                this.broadcast(...) // to send to everyone on all nodes
                this.send(id, ...) // to send to a client with id (id exists in client.id) (will still send to the client if he's on another node)
              });
            */
          this.server.Emitter.emit(
            event,
            data,
            this,
            this.ResponseCallback(data, _ack)
          ); // Add a callback function so we can allow a response
          return Bluebird.Promise.resolve();
        } else {
          return Bluebird.Promise.reject(new ClientError('Malformed packet')); // Should never reach here unless type is undefined
        }
      })
      .then(response => {
        if (_ack > -1 && response) {
          return this.SendResponse(response, _ack);
        }
      })
      .catch(e => {
        this.logger.error(e);
        let error = new ClientError('Unexpected error');

        if (e instanceof RouteNotFound) {
          error = new ClientError('Route not found');
        } else if (e instanceof EndpointNotAvailable) {
          error = new ClientError('Service currently not available');
        } else if (e instanceof DecodeError) {
          error = new ClientError('Malformed packet');
        } else if (e instanceof EncodeError) {
          error = new ClientError('Internal Server Error');
        } else if (e instanceof ClientError) {
          error = e;
        }

        return this.SendResponse(error, _ack);
      })
      .catch(e => {
        this.logger.error('Failed to send response', e);
      });
  }

  /**
   * Send response
   *
   * @private
   * @param {moleculer.GenericObject} data
   * @param {number} ack
   * @returns {Bluebird<{}>}
   * @memberof Client
   */
  private SendResponse(
    data: moleculer.GenericObject,
    ack: number
  ): Bluebird<{}> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new SocketNotOpen());
      }

      this.server
        .EncodePacket({
          type: PacketType.RESPONSE,
          payload: { id: ack, data: data }
        })
        .then(result => {
          this.socket.send(result);
          resolve();
        })
        .catch(reject);
    });
  }
}

// Only for type support
export class BaseClass extends BaseSchema {
  public on: (
    event: string,
    callback: (
      data: any,
      client: Client,
      respond: (error: string, data?: any) => void
    ) => void
  ) => void;
  public once: (
    event: string,
    callback: (
      data: any,
      client: Client,
      respond: (error: string, data: any) => void
    ) => void
  ) => void;
  public many: (
    event: string,
    timesTolisten: number,
    callback: (
      data: any,
      client: Client,
      respond: (error: string, data: any) => void
    ) => void
  ) => void;
  public removeListener: WSGateway['removeListener'];
  public removeAllListeners: WSGateway['removeAllListeners'];
  public setMaxListeners: WSGateway['setMaxListeners'];
  public send: WSGateway['send'];
  public emit: WSGateway['emit'];
  public broadcast: WSGateway['broadcast'];
  public clients: WSGateway['clients'];
  public clients_external: WSGateway['clients_external'];
  public settings: Settings;
}

@Service()
export class WSGateway {
  // begin hacks (these will be "stripped")
  private name: string;
  public broker: moleculer.ServiceBroker;
  public methods: any;
  public logger: moleculer.LoggerInstance;
  public authorize = (client: Client, data: moleculer.GenericObject) => {};
  // end hacks

  public settings: Settings = {
    port: parseInt(process.env.PORT) || 3000,
    ip: process.env.IP || '0.0.0.0',
    perMessageDeflate: false,
    path: '/',
    encryption: 'Binary',
    routes: [],
    heartbeat: {
      enabled: true,
      interval: 30000
    }
  };

  public Emitter: EventEmitter2;
  public on: EventEmitter2['on'];
  public once: EventEmitter2['once'];
  public onAny: EventEmitter2['onAny'];
  public many: EventEmitter2['many'];
  public addListener: EventEmitter2['addListener'];
  public removeListener: EventEmitter2['removeListener'];
  public removeAllListeners: EventEmitter2['removeAllListeners'];
  public setMaxListeners: EventEmitter2['setMaxListeners'];

  public clients: Client[] = []; // List of clients connected to this node
  public clients_external: external_client[] = []; // Replicated list of clients on other nodes
  private isHTTPS: boolean = false;
  private server: uws.Server;
  private webServer: http.Server | https.Server;
  private heartbeatEnabled: boolean = false;
  private heartbeatTimer: timer;

  /**
   * Setup http or https server
   * Setup websocket server
   * @memberof WSGateway
   */
  created() {
    //#region ugly stuff
    this.Emitter = new EventEmitter2(
      _.extend(
        {
          wildcard: true,
          newListener: false // Prevent wildcard catching this.
        },
        this.settings.eventEmitter
      )
    );
    this.on = this.Emitter.on.bind(this.Emitter);
    this.once = this.Emitter.on.bind(this.Emitter);
    this.onAny = this.Emitter.onAny.bind(this.Emitter);
    this.many = this.Emitter.many.bind(this.Emitter);
    this.addListener = this.Emitter.addListener.bind(this.Emitter);
    this.removeListener = this.Emitter.removeListener.bind(this.Emitter);
    this.removeAllListeners = this.Emitter.removeAllListeners.bind(
      this.Emitter
    );
    this.setMaxListeners = this.Emitter.setMaxListeners.bind(this.Emitter);
    //#endregion

    if (
      this.settings.https &&
      this.settings.https.key &&
      this.settings.https.cert
    ) {
      this.webServer = https.createServer(
        this.settings.https,
        this.httphandler
      );
      this.isHTTPS = true;
    } else {
      this.webServer = http.createServer(this.httphandler);
    }

    this.server = new uws.Server({
      server: this.webServer,
      path: this.settings.path,
      host: this.settings.ip,
      port: this.settings.port,
      perMessageDeflate: this.settings.perMessageDeflate
    });

    if (_.isArray(this.settings.routes)) {
      this.settings.routes = this.settings.routes.map(route =>
        this.ProcessRoute(route)
      );
    }

    // Pre check
    if (this.settings.externalAuth && this.settings.externalAuth.enabled) {
      const endpoint = this.settings.externalAuth.endpoint.split('.');
      if (endpoint.length !== 1 || !endpoint[0] || !endpoint[1]) {
        this.logger.fatal('Externalauth endpoint is invalid!');
      }
    }

    shortid.worker(
      process.env.NODE_UNIQUE_ID || Math.floor(Math.random() * 17)
    ); // See https://www.npmjs.com/package/shortid for more info
  }

  /**
   * Started handler for moleculer
   * @memberof WSGateway
   */
  started() {
    this.webServer.listen(this.settings.port, this.settings.ip, err => {
      if (err) return this.logger.error('WS Gateway listen error!', err);

      const addr = this.webServer.address();
      this.logger.info(
        `WS Gateway listening on ${this.isHTTPS ? 'https' : 'http'}://${
          addr.address
        }:${addr.port}`
      );
    });

    if (this.settings.heartbeat.enabled && !this.heartbeatEnabled)
      this.StartHeartbeat();

    this.server.on('connection', this.ConnectionHandler.bind(this));
    this.server.on('error', this.logger.error.bind(this));
  }

  /**
   * Stopped handler for moleculer
   * @memberof WSGateway
   */
  stopped() {
    if (this.webServer.listening) {
      Bluebird.all([
        Bluebird.promisify(this.server.close),
        Bluebird.promisify(this.webServer.close)
      ])
        .then(() => {
          this.logger.info('WS Gateway stopped!');
        })
        .catch(e => this.logger.error('WS Gateway close error!', e));
    }
  }

  /**
   * UWS Httphandler
   *
   * @private
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @memberof WSGateway
   */
  private httphandler(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(204, {
      'Content-Length': '0'
    });
    res.end();
  }

  /**
   * Start heartbeat
   *
   * @public
   * @memberof WSGateway
   */
  @Method
  public StartHeartbeat(): void {
    if (!this.heartbeatEnabled) this.heartbeatTimer = new timer();

    this.heartbeatTimer.setInterval(
      this.PingClients,
      [],
      `${this.settings.heartbeat.interval | 30000}m`
    ); // defaults to 30 seconds
    this.heartbeatEnabled = true;
    this.logger.debug('Heartbeat started');
  }

  /**
   * Stop heartbeat
   *
   * @memberof WSGateway
   */
  @Method
  public StopHeartbeat(): void {
    if (this.heartbeatEnabled) this.heartbeatTimer.clearInterval();

    this.heartbeatEnabled = false;
    this.logger.debug('Heartbeat stopped');
  }

  /**
   * Send to a specific client with id
   *
   * @param {string} id
   * @param {string} event
   * @param {moleculer.GenericObject} data
   * @param {boolean} [isExternal] is only applied when its coming from an external node to prevent a race condition which shouldn't exist.
   * @memberof WSGateway
   */
  @Method
  public send(
    id: string,
    event: string,
    data: moleculer.GenericObject,
    isExternal?: boolean
  ): void {
    const client: Client = this.clients.find(c => c.id === id);

    if (!client && !isExternal) {
      const external = this.clients_external.find(c => c.id === id);

      if (external) {
        this.logger.debug(
          `Sending to a client with id: ${id} on node ${external.nodeID}`
        );
        this.broker.emit(
          'ws.client.send',
          <EventPacket>{
            event,
            data
          },
          external.nodeID
        );
      } else {
        this.logger.error(`Client ${id} not found`);
      }
    } else {
      this.logger.debug(`Sending to a client with id: ${id}`);
      client.emit(event, data);
    }
  }

  /**
   * Send to all clients on this node
   *
   * @param {string} event
   * @param {moleculer.GenericObject} data
   * @memberof WSGateway
   */
  @Method
  public emit(event: string, data: moleculer.GenericObject): void {
    this.logger.debug('Sending to all clients on this node');
    this.clients.map(u => u.emit(event, data)); // Map is faster than for loop
  }

  /**
   * Send to all clients on all nodes
   *
   * @param {string} event
   * @param {moleculer.GenericObject} data
   * @memberof WSGateway
   */
  @Method
  public broadcast(event: string, data: moleculer.GenericObject): void {
    this.logger.debug('Sending to all clients on all nodes');
    this.broker.broadcast(
      'ws.client.SendToAll',
      <EventPacket>{
        event,
        data
      },
      'ws'
    );

    this.emit(event, data);
  }

  /**
   * Ping clients
   *
   * @returns {void}
   * @memberof WSGateway
   */
  @Method
  private PingClients(): void {
    this.logger.debug('Pinging clients');
    this.clients = this.clients.filter(u => {
      if (!u.alive) {
        // Not alive since last ping
        u.Close(); // Close connection (if there's one)

        this.broker.broadcast(
          'ws.client.disconnected',
          <external_client>{
            // Let other nodes know user disconnected
            id: u.id,
            props: u.props
          },
          'ws'
        );

        return false;
      }

      u.alive = false;
      u.socket.ping(_.noop);

      return true;
    });
  }

  /**
   * Creates a new client
   *
   * @param {uws} socket
   * @memberof WSGateway
   */
  @Method
  private ConnectionHandler(socket: uws): void {
    const client = new Client(socket, this);

    socket.on('close', this.DisconnectHandler.bind(this, client));

    this.clients.push(client); // Add client

    this.logger.info(`Client: ${client.id} connected`);

    // Let other nodes know about this client
    this.broker.broadcast(
      'ws.client.connected',
      {
        id: client.id,
        props: client.props
      },
      'ws'
    );
  }

  /**
   * Handles client disconnect
   *
   * @param {Client} client
   * @memberof WSGateway
   */
  @Method
  private DisconnectHandler(client: Client): void {
    this.clients.splice(this.clients.findIndex(c => c.id === client.id)); // Remove client

    this.logger.info(`Client: ${client.id} disconnected`);

    // Let other nodes know this client has disconnected
    this.broker.broadcast(
      'ws.client.disconnected',
      {
        id: client.id,
        props: client.props
      },
      'ws'
    );
  }

  /**
   * Decode incoming packets
   *
   * @param {(Buffer | string | any)} message
   * @returns {Bluebird<Packet>}
   * @memberof WSGateway
   */
  @Method
  public DecodePacket(message: Buffer | string | any): Bluebird<Packet> {
    return new Bluebird.Promise((resolve, reject) => {
      try {
        if (
          _.isFunction(this.settings.encryption) &&
          _.isFunction(this.settings.decryption)
        ) {
          this.settings
            .decryption(message)
            .then(resolve)
            .catch(err => new DecodeError(err));
        } else {
          switch (this.settings.encryption) {
            case 'JSON':
              resolve(JSON.parse(message));
              break;

            default:
            case 'Binary':
              resolve(JSON.parse(Buffer.from(message).toString('utf8')));
              break;
          }
        }
      } catch (e) {
        this.logger.fatal(e);
        reject(new DecodeError());
      }
    });
  }

  /**
   * Encodes outgoing packets
   *
   * @param {Packet} packet
   * @returns {(Bluebird<Buffer | string>)}
   * @memberof WSGateway
   */
  @Method
  public EncodePacket(packet: Packet): Bluebird<Buffer | string> {
    return new Bluebird.Promise((resolve, reject) => {
      try {
        if (_.isFunction(this.settings.encryption)) {
          this.settings
            .encryption(packet)
            .then(resolve)
            .catch(err => new EncodeError(err));
        } else {
          switch (this.settings.encryption) {
            case 'JSON':
              resolve(JSON.stringify(packet));
              break;

            default:
            case 'Binary':
              resolve(new Buffer(JSON.stringify(packet)));
              break;
          }
        }
      } catch (e) {
        this.logger.fatal(e);

        if (e instanceof EncodeError || e instanceof DecodeError) {
          return reject(e);
        }

        return reject(new EncodeError());
      }
    });
  }

  /**
   * Check whitelist
   * Credits: Icebob
   *
   * @private
   * @param {route} route
   * @param {string} action
   * @returns {boolean}
   * @memberof WSGateway
   */
  @Method
  private checkWhitelist(route: route, action: string): boolean {
    return (
      route.whitelist.find((mask: string | RegExp) => {
        if (_.isString(mask)) {
          return nanomatch.isMatch(action, mask, { unixify: false });
        } else if (_.isRegExp(mask)) {
          return mask.test(action);
        }
      }) != null
    );
  }

  /**
   * Here we check if authorization method exists on the route and set the default mappingPolicy
   *
   * @private
   * @param {route} route
   * @returns {route}
   * @memberof WSGateway
   */
  @Method
  private ProcessRoute(route: route): route {
    // Check if we have a valid authorization method.
    if (route.authorization) {
      if (!_.isFunction(this.authorize)) {
        this.logger.warn(
          'No authorization method, please define one to use authorization. Route will now be unprotected.'
        );
        route.authorization = false;
      }
    }

    if (!route.mappingPolicy) route.mappingPolicy = 'all';

    return route;
  }

  /**
   * Find route by name & action
   *
   * @private
   * @param {string} name
   * @param {string} action
   * @returns {Bluebird<{ route: route, action: string }>}
   * @memberof WSGateway
   */
  @Method
  private FindRoute(
    name: string,
    action: string
  ): Bluebird<{ route: route; action: string }> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.settings.routes && this.settings.routes.length > 0) {
        for (let route of this.settings.routes) {
          if (route.name !== name) {
            continue; // continue on with next cycle.
          }

          // resolve alias
          if (route.aliases && _.keys(route.aliases).length > 0) {
            for (let alias in route.aliases) {
              if (alias.match(action)) {
                action = route.aliases[alias]; // apply correct action
              }
            }
          }

          // if whitelist exists, check if the name is there.
          if (
            route.whitelist &&
            route.whitelist.length > 0 &&
            route.mappingPolicy == 'strict'
          ) {
            if (!this.checkWhitelist(route, action)) continue;
          }

          return resolve({ route, action }); // must resolve action as it could be an alias.
        }

        return reject(new RouteNotFound());
      }
    });
  }

  /**
   * Call an action on the first available node
   * @Note: No native promises & async/await as it hurts performance, if you need another performance kick, consider converting all promises to callbacks.
   *
   * @param {Client} sender
   * @param {string} name
   * @param {string} _action
   * @param {moleculer.ActionParams} params
   * @returns {Bluebird<any>}
   * @memberof WSGateway
   */
  @Method
  public CallAction(
    sender: Client,
    name: string,
    _action: string,
    params: moleculer.ActionParams
  ): Bluebird<any> {
    return new Bluebird.Promise((resolve, reject) => {
      this.FindRoute(name, _action)
        .then(({ route, action }) => {
          // Sender needs to authorize
          if (route.authorization && !sender.authorized) {
            reject(new NotAuthorized());
          }

          this.logger.debug(`Finding endpoint for: ${action}`);
          const endpoint: any = this.broker.findNextActionEndpoint(action);

          if (endpoint instanceof moleculer.Errors.ServiceNotFoundError) {
            return reject(new EndpointNotAvailable());
          }

          // Credits Icebob
          // Action is not publishable
          if (endpoint.action && endpoint.action.publish === false) {
            return reject(new RouteNotFound());
          }

          let ctx: moleculer.Context = moleculer.Context.create(
            this.broker,
            { name: this.name, handler: _.noop },
            this.broker.nodeID,
            params,
            {}
          );
          (ctx as any)._metricStart(ctx.metrics);

          if (route.onBeforeCall) {
            // In beforecall you can modify the params, the context and client props.
            Bluebird.Promise.resolve(
              route.onBeforeCall.call(this, ctx, <Request>{
                action,
                sender: {
                  id: sender.id,
                  props: sender.props
                },
                params
              })
            )
              .then(result => {
                if (result) {
                  // Override anything if the beforeCall returns them.
                  if (result.ctx)
                    // Apply context
                    ctx = result.ctx;

                  if (result.params)
                    // Apply params
                    params = result.params;

                  if (result.props)
                    // Apply props
                    this.clients.find(c => c.id === sender.id).props = _.extend(
                      {},
                      sender.props,
                      result.props
                    );
                }
              })
              .catch(reject);
          }

          return ctx
            .call(endpoint, params)
            .then(res => {
              // In aftercall you can modify the result.
              if (route.onAfterCall) {
                Bluebird.Promise.resolve(
                  route.onAfterCall.call(
                    this,
                    ctx,
                    <Request>{
                      action,
                      sender: {
                        id: sender.id,
                        props: sender.props
                      },
                      params
                    },
                    res
                  )
                )
                  .then(result => {
                    if (result)
                      // Apply result
                      res = result;
                  })
                  .catch(reject);
              }

              (ctx as any)._metricFinish(null, ctx.metrics);
              resolve(res);
            })
            .catch(reject);
        })
        .catch(err => {
          if (!err) return;

          if (err.ctx) {
            err.ctx._metricFinish(null, err.ctx.metrics);
          }

          return reject(err);
        });
    });
  }

  /**
   * Client connected on another node
   *
   * @param {external_client_payload} payload
   * @param {any} sender
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.connected'(payload: external_client_payload, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }

    this.logger.debug(`Client: ${payload.id} connected on node: ${sender}`);

    const opts = { nodeID: sender, ...payload };
    this.clients_external.push(opts);

    this.Emitter.emit('connected_external', opts);
  }

  /**
   * Client disconnected on another node
   *
   * @param {external_client_payload} payload
   * @param {any} sender
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.disconnected'(payload: external_client_payload, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }
    this.logger.debug(`Client: ${payload.id} disconnected on node: ${sender}`);

    const opts = { nodeID: sender, ...payload };
    this.clients_external.splice(
      this.clients_external.findIndex(
        c => c.nodeID === sender && c.id === payload.id
      ),
      1
    );

    this.Emitter.emit('disconnected_external', opts);
  }

  /**
   * Let other nodes send to all clients on this server
   *
   * @public
   * @param {Packet} payload
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.SendToAll'(payload: EventPacket, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }
    this.logger.debug(`${sender} requested send to all`);
    return this.emit(payload.event, payload.data);
  }

  /**
   * Let other nodes send to a client on this server
   *
   * @private
   * @param {external_client_send} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.send'(payload: external_client_send, sender) {
    const id = payload.id,
      packet: EventPacket = payload.packet;

    this.logger.debug(`Sending to ${id} from node: ${sender}`);

    return this.send(id, packet.event, packet.data, true);
  }

  /**
   * Sync props
   *
   * @private
   * @param {external_client_payload} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.update'(payload: external_client_payload, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }
    this.logger.debug(`Client ${payload.id} updated props`);
    this.clients_external.find(c => c.id === payload.id).props = payload.props;
  }

  /**
   * Remove clients connected to the disconnected node
   *
   * @param {any} payload
   * @param {any} sender
   * @memberof WSGateway
   */
  @Event()
  private '$node.disconnected'(payload, sender) {
    // Remove clients connected to the disconnected node
    this.logger.debug(`Node: ${sender} disconnected`);
    this.clients_external = this.clients_external.filter(
      c => c.nodeID !== sender
    );
  }
}
