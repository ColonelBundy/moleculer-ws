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
import * as Errors from './errors';
export { Errors };

interface Flags {
  binary: boolean;
  masked: boolean;
}

export enum PacketType {
  EVENT,
  ACTION,
  RESPONSE,
  SYNC
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

export interface ResponsePacket {
  id: number;
  data: any;
}

export interface Settings {
  port: number;
  ip?: string;
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

export interface syncPacket {
  id: string;
  authorized: boolean;
  props: moleculer.GenericObject;
}

export interface externalSendPacket {
  id: string;
  packet: EventPacket;
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
  name: string;
  action: string;
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

export type encryption = (packet: Packet) => Bluebird<Buffer | string | any>;
export type decryption = (message: Buffer | string | any) => Bluebird<Packet>;

export class ExternalClient {
  private readonly broker: moleculer.ServiceBroker;
  public readonly id: string;
  public readonly nodeID: string;
  private _authorized: boolean = false;
  private _props: moleculer.GenericObject = {};

  constructor(
    opts: syncPacket,
    _nodeID: string,
    _broker: moleculer.ServiceBroker
  ) {
    this.id = opts.id;
    this._props = opts.props; // initial props
    this._authorized = opts.authorized;
    this.broker = _broker;
    this.nodeID = _nodeID;
  }

  /**
   * Set both props and authorized in one go.
   *
   * @param {moleculer.GenericObject} props
   * @param {boolean} authorized
   * @memberof Client
   */
  public SetProperties(props: moleculer.GenericObject, authorized: boolean) {
    this._props = props;
    this._authorized = authorized;
    this.Sync();
  }

  /**
   * Set authorized
   *
   * @memberof ExternalClient
   */
  public set authorized(value: boolean) {
    this._authorized = value;
    this.Sync();
  }

  /**
   * Get authorized
   *
   * @type {boolean}
   * @memberof ExternalClient
   */
  public get authorized(): boolean {
    return this._authorized;
  }

  /**
   * Set props
   *
   * @memberof Client
   */
  public set props(value: moleculer.GenericObject) {
    this._props = value;
    this.Sync();
  }

  /**
   * Get Props
   *
   * @memberof Client
   */
  public get props(): moleculer.GenericObject {
    return this._props;
  }

  /**
   * Send to client on origin node
   *
   * @param {string} event
   * @param {moleculer.GenericObject} data
   * @memberof ExternalClient
   */
  public send(event: string, data: moleculer.GenericObject): void {
    this.broker.broadcast(
      'ws.client.origin.send',
      <externalSendPacket>{
        id: this.id,
        packet: {
          data,
          event
        }
      },
      'ws'
    );
  }

  /**
   * Emit on origin node (send to all except client)
   *
   * @memberof ExternalClient
   */
  public emit(event: string, data: moleculer.GenericObject): void {
    this.broker.broadcast(
      'ws.client.origin.emit',
      <externalSendPacket>{
        id: this.id,
        packet: {
          data,
          event
        }
      },
      'ws'
    );
  }

  /**
   * Broadcaast on origin node (send to all on all nodes except client)
   *
   * @param {string} event
   * @param {moleculer.GenericObject} data
   * @memberof ExternalClient
   */
  public broadcast(event: string, data: moleculer.GenericObject): void {
    this.broker.broadcast(
      'ws.client.origin.broadcast',
      <externalSendPacket>{
        id: this.id,
        packet: {
          data,
          event
        }
      },
      'ws'
    );
  }

  /**
   * Sync changes made here to origin
   *
   * @private
   * @memberof ExternalClient
   */
  private Sync() {
    this.broker.broadcast(
      'ws.client.origin.sync',
      <syncPacket>{
        id: this.id,
        props: this._props,
        authorized: this._authorized
      },
      'ws'
    );
  }
}

export class Client {
  private readonly server: WSGateway;
  private logger: moleculer.LoggerInstance;
  public readonly id: string = shortid.generate();
  public readonly socket: uws;
  public alive: boolean = true;
  private ack_id: number = 0;
  private _props: moleculer.GenericObject = {};
  private _authorized: boolean = false;

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
    this.socket.on('message', this.messageHandler.bind(this));
    this.socket.on('pong', () => (this.alive = true));
  }

  /**
   * Set both props and authorized in one go.
   *
   * @param {moleculer.GenericObject} props
   * @param {boolean} authorized
   * @memberof Client
   */
  public SetProperties(props: moleculer.GenericObject, authorized: boolean) {
    this._props = props;
    this._authorized = authorized;
    this.Sync();
  }

  /**
   * Set authorized
   *
   * @memberof Client
   */
  public set authorized(value: boolean) {
    this._authorized = value;
    this.Sync();
  }

  /**
   * Get authorized
   *
   * @type {boolean}
   * @memberof Client
   */
  public get authorized(): boolean {
    return this._authorized;
  }

  /**
   * Set props
   *
   * @memberof Client
   */
  public set props(value: moleculer.GenericObject) {
    this._props = value;
    this.Sync();
  }

  /**
   * Get Props
   *
   * @memberof Client
   */
  public get props(): moleculer.GenericObject {
    return this._props;
  }

  /**
   * Broadcast change to all other nodes
   *
   * @private
   * @memberof Client
   */
  private Sync() {
    const packet: syncPacket = {
      id: this.id,
      props: this._props,
      authorized: this._authorized
    };

    // Sync to client
    if (this.socket.readyState === this.socket.OPEN) {
      this.server
        .EncodePacket({
          payload: packet,
          type: PacketType.SYNC
        })
        .then(payload => this.socket.send(payload))
        .catch(e => this.logger.error(e));
    }

    // Sync to nodes
    this.server.broker.broadcast('ws.client.sync', packet, 'ws');
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
  public send(event: string, data: object): Bluebird<{}> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new Errors.SocketNotOpen());
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
   * Send to all clients except sender on this node
   *
   * @param {string} event
   * @param {object} data
   * @returns {Bluebird<{}>}
   * @memberof Client
   */
  public emit(event: string, data: object): Bluebird<{}> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new Errors.SocketNotOpen());
      }

      this.server
        .EncodePacket({
          payload: { event, data },
          type: PacketType.EVENT
        })
        .then(result => {
          this.server.clients
            .filter(c => c.id !== this.id)
            .map(c => c.socket.send(result));
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Send to all clients except sender on all nodes
   *
   * @param {string} event
   * @param {moleculer.GenericObject} data
   * @returns {Bluebird<{}>}
   * @memberof Client
   */
  public broadcast(event: string, data: moleculer.GenericObject): Bluebird<{}> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new Errors.SocketNotOpen());
      }

      this.server
        .EncodePacket({
          payload: { event, data },
          type: PacketType.EVENT
        })
        .then(result => {
          this.logger.debug('Sending to all clients on all nodes');
          this.server.broker.broadcast(
            'ws.client.SendToAll',
            <EventPacket>{
              event,
              data
            },
            'ws'
          );

          this.server.clients
            .filter(c => c.id !== this.id)
            .map(c => c.socket.send(result));
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
      // No need to send back a response if the clien't doesn't want one.
      if (_.isNil(ack)) {
        return;
      }

      if (err) {
        _self
          .SendResponse(new Errors.ClientError(err), ack)
          .catch(e => _self.logger.error(e));
        return;
      }

      _self.SendResponse(data, ack).catch(e => _self.logger.error(e));
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
        if (result.type === PacketType.ACTION) {
          const { name, action, data } = <ActionPacket>result.payload;

          this.logger.debug('Action packet');
          if (name === 'internal') {
            this.logger.debug('Internal action');

            if (action === 'auth') {
              if (!this.authorized) {
                this.logger.debug('Internal auth action');

                // Placeholder to allow changing of props
                let cProp = {
                  id: this.id,
                  props: this.props
                };

                return Bluebird.Promise.method(this.server.authorize)
                  .call(this, cProp, data)
                  .then(resp => {
                    this.authorized = true;
                    this.props = cProp.props;
                    return Bluebird.resolve(resp);
                  })
                  .catch(e => {
                    return Bluebird.Promise.reject(new Errors.StraightError(e));
                  });
              }

              return Bluebird.Promise.reject(
                new Errors.StraightError('Already authenticated')
              );
            } else if (action === 'deauth') {
              if (this.authorized) {
                this.logger.debug('Internal deauth action');

                // Placeholder to allow changing of props
                let cProp = {
                  id: this.id,
                  props: this.props
                };

                return Bluebird.Promise.method(this.server.deauthorize)
                  .call(this, cProp, data)
                  .then(resp => {
                    this.authorized = false;
                    this.props = cProp.props;
                    return Bluebird.resolve(resp);
                  })
                  .catch(e => {
                    return Bluebird.Promise.reject(new Errors.StraightError(e));
                  });
              }

              return Bluebird.Promise.reject(
                new Errors.StraightError('Not authenticated')
              );
            }

            return Bluebird.Promise.reject(new Errors.RouteNotFound());
          }

          this.logger.debug('User defined system action');
          return this.server.CallAction(this, name, action, data);
        } else if (result.type === PacketType.EVENT) {
          const { event, data } = <EventPacket>result.payload;

          // Server listener
          /* Works as: 
              this.on('action_name', (data, client, respond) => {
                respond(error, data_to_respond_with) // to respond to this particular request.
                this.emit(...) // to send to everyone on this node
                this.broadcast(...) // to send to everyone on all nodes
                this.send(client.id, ...) // to send to a client with id (will still send to the client if he's on another node)
              });
            */
          this.server.Emitter.emit(
            event,
            data,
            this,
            this.ResponseCallback(data, _ack)
          ); // Add a callback function so we can allow a response
          _ack = -1; // Need to reset here so we don't send multiple responses
          return Bluebird.Promise.resolve();
        }

        return Bluebird.Promise.reject(
          new Errors.StraightError('Malformed packet')
        ); // Should never reach here unless type is undefined
      })
      .then(response => {
        if (_ack > -1) {
          return this.SendResponse(response, _ack);
        }
      })
      .catch(e => {
        this.logger.error(e);
        if (_ack > -1) {
          let error = new Errors.ClientError('Unexpected error');

          if (e instanceof Errors.RouteNotFound) {
            error = new Errors.ClientError('Route not found');
          } else if (e instanceof Errors.EndpointNotAvailable) {
            error = new Errors.ClientError('Service currently not available');
          } else if (e instanceof Errors.DecodeError) {
            error = new Errors.ClientError('Malformed packet');
          } else if (e instanceof Errors.EncodeError) {
            error = new Errors.ClientError('Internal Server Error');
          } else if (e instanceof Errors.StraightError) {
            error = new Errors.ClientError(e.message);
          }

          return this.SendResponse(error, _ack);
        }
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
    data: moleculer.GenericObject = {},
    ack: number
  ): Bluebird<{}> {
    return new Bluebird.Promise((resolve, reject) => {
      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new Errors.SocketNotOpen());
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
  public deauthorize = (client: Client, data: moleculer.GenericObject) => {};
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
  public many: EventEmitter2['many'];
  public addListener: EventEmitter2['addListener'];
  public removeListener: EventEmitter2['removeListener'];
  public removeAllListeners: EventEmitter2['removeAllListeners'];
  public setMaxListeners: EventEmitter2['setMaxListeners'];

  public clients: Client[] = []; // List of clients connected to this node
  public clients_external: ExternalClient[] = []; // Replicated list of clients on other nodes
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
      path: this.settings.path || '/',
      host: this.settings.ip || '0.0.0.0',
      port: this.settings.port,
      perMessageDeflate: this.settings.perMessageDeflate
    });

    if (_.isArray(this.settings.routes)) {
      this.settings.routes = this.settings.routes.map(route =>
        this.ProcessRoute(route)
      );
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
          if (this.heartbeatEnabled) this.heartbeatTimer.clearInterval();
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
  private StartHeartbeat(): void {
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
  private StopHeartbeat(): void {
    if (this.heartbeatEnabled) this.heartbeatTimer.clearInterval();

    this.heartbeatEnabled = false;
    this.logger.debug('Heartbeat stopped');
  }

  /**
   * Send to a client with id
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

    if (client) {
      this.logger.debug(`Sending to a client with id: ${id}`);
      client.send(event, data);
      return;
    }

    if (!isExternal) {
      const external = this.clients_external.find(c => c.id === id);

      if (!external) {
        this.logger.error(`Client ${id} not found`);
        return;
      }

      this.logger.debug(
        `Sending to a client with id: ${id} on node ${external.nodeID}`
      );

      external.send(event, data);
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

        // Let other nodes know user disconnected
        this.broker.broadcast(
          'ws.client.disconnected',
          <ExternalClient>{},
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

    this.logger.debug(`Client: ${client.id} connected`);

    // Let other nodes know about this client
    this.broker.broadcast(
      'ws.client.connected',
      {
        id: client.id,
        props: client.props
      },
      'ws'
    );

    this.Emitter.emit('connection', client);
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

    this.logger.debug(`Client: ${client.id} disconnected`);

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
            .catch(e => new Errors.DecodeError(e));
          return;
        }

        switch (this.settings.encryption) {
          case 'JSON':
            resolve(JSON.parse(message));
            break;

          default:
          case 'Binary':
            resolve(JSON.parse(Buffer.from(message).toString('utf8')));
            break;
        }
      } catch (e) {
        this.logger.fatal(e);
        reject(new Errors.DecodeError());
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
        if (
          _.isFunction(this.settings.encryption) &&
          _.isFunction(this.settings.decryption)
        ) {
          this.settings
            .encryption(packet)
            .then(resolve)
            .catch(e => new Errors.EncodeError(e));
          return;
        }

        switch (this.settings.encryption) {
          case 'JSON':
            resolve(JSON.stringify(packet));
            break;

          default:
          case 'Binary':
            resolve(new Buffer(JSON.stringify(packet)));
            break;
        }
      } catch (e) {
        this.logger.fatal(e);

        if (
          e instanceof Errors.EncodeError ||
          e instanceof Errors.DecodeError
        ) {
          return reject(e);
        }

        return reject(new Errors.EncodeError());
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

        return reject(new Errors.RouteNotFound());
      }
    });
  }

  /**
   * Call an action on the first available node
   * @Note: No native promises & async/await as it hurts performance, if you need another performance kick, consider converting all promises to callbacks.
   *
   * @param {Client} client
   * @param {string} name
   * @param {string} _action
   * @param {moleculer.ActionParams} params
   * @returns {Bluebird<any>}
   * @memberof WSGateway
   */
  @Method
  public CallAction(
    client: Client,
    name: string,
    _action: string,
    params: moleculer.ActionParams
  ): Bluebird<any> {
    return new Bluebird.Promise((resolve, reject) => {
      let ctx: moleculer.Context;

      this.FindRoute(name, _action)
        .then(({ route, action }) => {
          // client needs to authorize
          if (route.authorization && !client.authorized) {
            reject(new Errors.NotAuthorized());
          }

          this.logger.debug(`Finding endpoint for: ${action}`);
          const endpoint: any = this.broker.findNextActionEndpoint(action);

          if (endpoint instanceof moleculer.Errors.ServiceNotFoundError) {
            return reject(new Errors.EndpointNotAvailable());
          }

          // Credits Icebob
          // Action is not publishable
          if (endpoint.action && endpoint.action.publish === false) {
            return reject(new Errors.RouteNotFound());
          }

          ctx = moleculer.Context.create(
            this.broker,
            { name: this.name, handler: _.noop },
            this.broker.nodeID,
            params,
            {}
          );
          (ctx as any)._metricStart(ctx.metrics);

          ctx.meta.client = {
            id: client.id,
            props: client.props,
            authorized: client.authorized
          };

          if (route.onBeforeCall) {
            // In beforecall you can modify the params, the context and client props.
            Bluebird.Promise.resolve(
              route.onBeforeCall.call(this, ctx, <Request>{
                name,
                action,
                params
              })
            )
              .then(result => {
                if (result) {
                  // Override anything if the beforeCall returns them.
                  // Apply context
                  if (result.ctx) ctx = result.ctx;

                  // Apply params
                  if (result.params) params = result.params;
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
                      name,
                      action,
                      params
                    },
                    res
                  )
                )
                  .then(result => {
                    // Apply result
                    if (result) res = result;
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

          if (ctx) {
            (ctx as any)._metricFinish(null, ctx.metrics);
          }

          return reject(err);
        });
    });
  }

  /**
   * Client connected on another node
   *
   * @param {syncPacket} payload
   * @param {any} sender
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.connected'(payload: syncPacket, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }

    this.logger.debug(`Client: ${payload.id} connected on node: ${sender}`);

    const opts = new ExternalClient(payload, sender, this.broker);
    this.clients_external.push(opts);

    this.Emitter.emit('connection', opts);
  }

  /**
   * Client disconnected on another node
   *
   * @param {syncPacket} payload
   * @param {any} sender
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.disconnected'(payload: syncPacket, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }
    this.logger.debug(`Client: ${payload.id} disconnected on node: ${sender}`);

    const opts = { nodeID: sender, ...payload };
    this.clients_external = this.clients_external.filter(
      c => c.id !== payload.id
    );

    this.Emitter.emit('disconnected', opts);
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
   * @param {externalSendPacket} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.send'(payload: externalSendPacket, sender) {
    const id = payload.id,
      packet: EventPacket = payload.packet;

    this.logger.debug(`Sending to ${id} from node: ${sender}`);

    return this.send(id, packet.event, packet.data, true);
  }

  /**
   * Sync client properties
   *
   * @private
   * @param {syncPacket} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.sync'(payload: syncPacket, sender) {
    if (sender === this.broker.nodeID) {
      return;
    }
    this.logger.debug(`Client ${payload.id} SYNC`);
    const client = this.clients_external.find(c => c.id === payload.id);
    client.SetProperties(payload.props, payload.authorized);
  }

  /**
   * Handler for External client on another node -> .emit -> to client origin node -> .emit
   *
   * @private
   * @param {externalSendPacket} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.origin.emit'(payload: externalSendPacket, sender) {
    const client = this.clients.find(c => c.id === payload.id);
    if (sender === this.broker.nodeID || !client) {
      return;
    }

    this.logger.debug(
      `[ORIGIN] Emitting to everyone except ${
        payload.id
      } by external from ${sender}`
    );
    client.emit(payload.packet.event, payload.packet.data);
  }

  /**
   * Handler for External client on another node -> .broadcast -> to client origin node -> .broadcast
   *
   * @private
   * @param {externalSendPacket} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.origin.broadcast'(payload: externalSendPacket, sender) {
    const client = this.clients.find(c => c.id === payload.id);
    if (sender === this.broker.nodeID || !client) {
      return;
    }

    this.logger.debug(
      `[ORIGIN] Broadcasting to everyone except client ${
        payload.id
      } by external from ${sender}`
    );
    client.broadcast(payload.packet.event, payload.packet.data);
  }

  /**
   * Handler for External client on another node -> .send -> to client origin node -> .send
   *
   * @private
   * @param {externalSendPacket} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.origin.send'(payload: externalSendPacket, sender) {
    const client = this.clients.find(c => c.id === payload.id);
    if (sender === this.broker.nodeID || !client) {
      return;
    }

    this.logger.debug(
      `[ORIGIN] Sending to client ${payload.id} by external from ${sender}`
    );
    client.send(payload.packet.event, payload.packet.data);
  }

  /**
   * Handler for External client on another node setting props
   *
   * @private
   * @param {syncPacket} payload
   * @param {any} sender
   * @returns
   * @memberof WSGateway
   */
  @Event({
    group: 'ws'
  })
  private 'ws.client.origin.sync'(payload: syncPacket, sender) {
    const client = this.clients.find(c => c.id === payload.id);
    if (sender === this.broker.nodeID || !client) {
      return;
    }

    this.logger.debug(`[ORIGIN] Client ${payload.id} SYNC`);
    client.SetProperties(payload.props, payload.authorized);
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
