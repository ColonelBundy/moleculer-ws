/**
 * Moleculer-ws
 * Copyright (c) 2012 ColonelBundy (https://github.com/colonelbundy/moleculer-ws)
 * MIT Licensed
 */

import http       = require('http');
import https      = require('https');
import moleculer  = require('moleculer');
import uws        = require('uws');
import timer      = require('nanotimer');
import _          = require('lodash');
import httpStatus = require('http-status');
import nanomatch  = require('nanomatch');
import shortid    = require('shortid');
import Bluebird   = require('bluebird');
import * as async from 'async';
import { Service, Action, Event, Method } from 'moleculer-decorators';
import { EventEmitter2 } from 'eventemitter2';
import { SocketNotOpen, NotAuthorized, RouteNotFound, ClientError, EncodeError, DecodeError, EndpointNotAvailable, ServiceNotAvailable } from './errors';

interface Flags {
  binary: boolean,
  masked: boolean
}

export enum SYS {
  INTERNAL = "INTERNAL",
  ACK = "ACK",
  AUTH = "AUTH"
}

export interface Packet {
  name: string,
  action: string,
  data: any,
  ack?: number
}

export interface Settings {
  port: number,
  ip?: string,
  externalAuth?: boolean,
  heartbeat?: {
    enabled: boolean,
    interval?: number
  },
  perMessageDeflate?: boolean,
  encryption?: 'Binary' | 'JSON' | encryption,
  decryption?: decryption,
  path: string,
  routes?: route[],
  https?: {
    key: string,
    cert: string
  } 
}

export interface callOptions {
  timeout: number,
  retryCount: number,
  fallbackResponse(ctx, err): void
}

export interface aliases {
  [name: string]: string
}

export interface Request {
  action: string,
  sender: {
    socket: uws,
    props: moleculer.GenericObject
  },
  params: moleculer.ActionParams
}

export interface route {
  name: string,
  aliases?: aliases,
  whitelist?: string[],
  authorization?: boolean,
  mappingPolicy?: 'strict' | 'all',
  onAfterCall?(ctx: moleculer.Context, req: Request, res: any): Promise<moleculer.Context>,
  onBeforeCall?(ctx: moleculer.Context, req: Request): Promise<moleculer.Context>,
  callOptions?: callOptions,
  onError?(req, res, err): void
}

type encryption = (packet: Packet) => Promise<Buffer | string | any>;
type decryption = (message: Buffer | string | any) => Promise<Packet>;
type authorize = (ctx: moleculer.Context, route?: route, params?: moleculer.ActionParams) => Promise<Packet>;

class Client {
  private readonly server: WSGateway;
  private logger: moleculer.LoggerInstance;
  private readonly Emitter: EventEmitter2 = new EventEmitter2();

  public on: EventEmitter2['on'] = this.Emitter.on.bind(this.Emitter);
  public once: EventEmitter2['once'] = this.Emitter.on.bind(this.Emitter);
  public onAny: EventEmitter2['onAny'] = this.Emitter.onAny.bind(this.Emitter);
  public many: EventEmitter2['many'] = this.Emitter.many.bind(this.Emitter);
  public addListener: EventEmitter2['addListener'] = this.Emitter.addListener.bind(this.Emitter);
  public removeListener: EventEmitter2['removeListener'] = this.Emitter.removeListener.bind(this.Emitter);
  public removeAllListeners: EventEmitter2['removeAllListeners'] = this.Emitter.removeAllListeners.bind(this.Emitter);
  public readonly id: string = shortid.generate();
  public readonly socket: uws;
  public authorized: boolean = false;
  public props: moleculer.GenericObject = {}; // Store for username etc..
  public alive: boolean = true;
  public ack_id: 0;
  

  constructor(_socket: uws, _server: WSGateway) {
    this.socket = _socket;
    this.server = _server;
    this.logger = this.server.broker.logger;

    this.socket.on('message', this.messageHandler.bind(this));
    this.socket.on('pong', () => this.alive = true);
  }

  /**
   * Close
   * Close client connection
   */
  public Close() : void {
    if (this.socket.readyState === this.socket.OPEN)
      this.socket.close();
  }

  /**
   * emit
   * Send to client
   * @param packet Packet
   */
  public emit(name: string, action: string, data: moleculer.ActionParams, ack?: number) : Bluebird<{}> {
    return new Bluebird.Promise(async (resolve, reject) => {

      if (this.socket.readyState !== this.socket.OPEN) {
        reject(new SocketNotOpen());
      }

      this.server.EncodePacket({ name, action, data, ack }).then(result => this.socket.send(result)).catch(reject);
    });
  }

  /**
   * ResponseCallback
   * Send response to INTERNAL action
   * @param action 
   * @param data 
   * @param ack 
   */
  private ResponseCallback(action, data, ack?) {
    const _self = this;
    return function(err, data) {
      if (!ack) { // No need to send back a response if the clien't doesn't want one.
        return;
      }

      //@TODO return promise and reject on error
      if (err) {
        _self.SendResponse(new ClientError(err), ack).catch(e => _self.logger.error(e));
      } else {
        _self.SendResponse(data, ack).catch(e => _self.logger.error(e));
      }
    }
  }

  /**
   * messageHandler
   * Handle incomming packets
   * @param packet Buffer | string
   */
  private messageHandler(packet: Buffer | string) : void {
    let _ack: number; // To respend if client demanded an ack on their request.
    this.logger.debug('Incoming message', packet);
      this.server.DecodePacket(packet).then(({ name, action, data, ack }) => {
        _ack = ack;

        if (name === SYS.INTERNAL) {
          if (action === SYS.AUTH) {
            this.logger.debug('Internal auth');
              if (!this.authorized) {
                if (this.server.settings.externalAuth) {
                  return this.server.CallAction(this, name, action, data);
                } else {
                  return Bluebird.Promise.method(this.server.methods['authorize'](data));
                }
              }
          } else {
            this.logger.debug('Internal custom listener');

            /** 
             * Do we actually need both emitters?
            */

            // Client listener
            this.Emitter.emit(action, data, this.ResponseCallback(action, data, ack)); // Add a callback function so we can allow a response

            // Server listener
            /* Works as: 
              this.on('action_name', (data, client, respond) => {
                respond(error (can be null), data_to_respond_with) // to respond to this particular request.
                client.emit(....) // to send anything else to the client.
                this.emit(...) // to send to everyone
                this.send(id, ...) // to send to a client with id
              });
            */
            this.server.Emitter.emit(action, data, this, this.ResponseCallback(action, data, ack)); // Add a callback function so we can allow a response
            return Bluebird.Promise.resolve();
          }
        } else {
          return this.server.CallAction(this, name, action, data);
        }
      }).then((response) => {
        if (_ack && response) {
          return this.SendResponse(response, _ack);
        }
      }).catch(e => {
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
        }

        return this.SendResponse(error, _ack);
      }).catch(e => {
        this.logger.error('Failed to send response', e);
      });
  }

  /**
   * SendResponse
   * @param data 
   * @param ack 
   */
  private SendResponse(data: moleculer.GenericObject, ack?: number) : Bluebird<{}> {
    return this.emit('INTERNAL', 'ACK', data, ack);
  }
}

@Service()
export class WSGateway {
  // begin hacks (will not get assigned)
  private name: string;
  public broker: moleculer.ServiceBroker;
  public methods: any;
  public logger: moleculer.LoggerInstance;
  private authorization = (ctx: moleculer.Context, route: route) => {}
  // end hacks

  public settings: Settings = {
    port: parseInt(process.env.PORT) || 3000,
    ip: process.env.IP || "0.0.0.0",
    perMessageDeflate: false,
    path: '/',
    routes: [],
    heartbeat: {
      enabled: true,
      interval: 30000
    }
  }

  public Emitter: EventEmitter2;
  public on: EventEmitter2['on'];
  public once: EventEmitter2['once'];
  public onAny: EventEmitter2['onAny'];
  public many: EventEmitter2['many'];
  public addListener: EventEmitter2['addListener'];
  public removeListener: EventEmitter2['removeListener'];
  public removeAllListeners: EventEmitter2['removeAllListeners'];

  protected isHTTPS: boolean = false;
  protected server: uws.Server
  protected webServer: http.Server | https.Server
  protected heartbeatEnabled: boolean = false;
  protected heartbeatTimer: timer;
  public clients: Client[] = [];

  /**
   * created
   * Setup http or https server
   * Setup websocket server
   */
  created() {
    this.Emitter = new EventEmitter2();
    this.on = this.Emitter.on.bind(this.Emitter);
    this.once = this.Emitter.on.bind(this.Emitter);
    this.onAny = this.Emitter.onAny.bind(this.Emitter);
    this.many = this.Emitter.many.bind(this.Emitter);
    this.addListener = this.Emitter.addListener.bind(this.Emitter);
    this.removeListener = this.Emitter.removeListener.bind(this.Emitter);
    this.removeAllListeners = this.Emitter.removeAllListeners.bind(this.Emitter);

    if (this.settings.https && this.settings.https.key && this.settings.https.cert) {
      this.webServer = https.createServer(this.settings.https, this.httphandler);
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
      this.settings.routes = this.settings.routes.map(route => this.ProcessRoute(route));
    }
  }

  /**
   * started
   * Here we start the webserver and start to listen for connections
   */
  started() {
    this.webServer.listen(this.settings.port, this.settings.ip, err => {
      if (err)
				return this.logger.error("WS Gateway listen error!", err);

        const addr = this.webServer.address();
        this.logger.info(`WS Gateway listening on ${this.isHTTPS ? "https" : "http"}://${addr.address}:${addr.port}`);
    });

    if (this.settings.heartbeat.enabled && !this.heartbeatEnabled)
      this.StartHeartbeat();

    this.server.on('connection', this.ConnectionHandler.bind(this));
    //this.server.on('error', this.ErrorHandler.bind(this));
  }

  /**
   * stopped
   */
  stopped() {
    if (this.webServer.listening) {
      async.series([this.server.close, this.webServer.close], (err) => {
        if (err)
					return this.logger.error("WS Gateway close error!", err);

				this.logger.info("WS Gateway stopped!");
      });
		}
  }

  /**
   * @TODO
   * @param req 
   * @param res 
   */
  private httphandler(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(204, {
      "Content-Length": "0"
    });
    res.end();
  }

  /*@TODO
  @Method
  private ErrorHandler(err) {
    this.logger.error(err);
  }
  */

  /**
   * StartHeartbeat
   */
  @Method
  private StartHeartbeat() : void {
    if (!this.heartbeatEnabled)
      this.heartbeatTimer = new timer();

    this.heartbeatTimer.setInterval(this.PingClients, [], `${this.settings.heartbeat.interval | 30000}m`); // defaults to 30 seconds
    this.heartbeatEnabled = true;
    this.logger.debug('Heartbeat started');
  }

  /**
   * Stop heartbeat
   */
  @Method
  private StopHeartbeat() : void {
    if (this.heartbeatEnabled)
      this.heartbeatTimer.clearInterval();

    this.heartbeatEnabled = false;
    this.logger.debug('Heartbeat stopped');
  }

  /**
   * Send
   * Send to a specific client with id
   * @param id ClientID
   * @param action 
   * @param data 
   */
  @Method
  public send(id: string, action: string, data: moleculer.GenericObject) {
    this.logger.debug(`Sending to client with id: ${id}`);
    this.clients.find(c => c.id === id).emit(SYS.INTERNAL, action, data);
  }

  /**
   * Emit
   * Send to all clients
   * @param action string
   * @param data 
   */
  @Method
  public emit(action: string, data: moleculer.GenericObject) {
    this.logger.debug('Sending to all clients');
    for (let i = 0; i < this.clients.length; i++) {
      this.clients[i].emit(SYS.INTERNAL, action, data);
    }
  }

  /**
   * Ping clients
   */
  @Method
  private PingClients() : void {
    this.logger.debug('Pinging clients');
    for (let i = 0; i < this.clients.length; i++) {
      if (!this.clients[i].alive) { // Not alive since last ping
        this.clients[i].socket.close() // Close connection
        this.clients.splice(i, 1); // Remove client
        return;
      }

      this.clients[i].alive = false;
      this.clients[i].socket.ping(_.noop);
    }
  }

  /**
   * ConnectionHandler
   * Here we create a new client
   * @param socket 
   */
  @Method
  private ConnectionHandler(socket: uws) : void {
    this.clients.push(new Client(socket, this));
  }

  /**
   * DecodePacket
   * @param message 
   */
  @Method
  public DecodePacket(message: Buffer | string | any): Bluebird<Packet> {
    return new Bluebird.Promise((resolve, reject) => {
      try {
        if(_.isFunction(this.settings.encryption) && _.isFunction(this.settings.decryption)) {
            this.settings.decryption(message).then(resolve).catch(err => new DecodeError(err));
        } else {
          switch (this.settings.encryption) {
            case 'JSON':
                resolve(JSON.parse(message));
            break;
  
            default:
            case 'Binary':
              resolve(JSON.parse(Buffer.from(message, 'binary').toString('utf8')));
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
   * EncodePacket
   * @param packet 
   */
  @Method
  public EncodePacket(packet: Packet): Bluebird<Buffer | string> {
    return new Bluebird.Promise((resolve, reject) => {
      try {
        if(_.isFunction(this.settings.encryption)) {
          this.settings.encryption(packet).then(resolve).catch(err => new EncodeError(err));
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
   * @param route 
   * @param action 
   */
  @Method
  private checkWhitelist(route: route, action: string) : boolean {
    return route.whitelist.find((mask: string | RegExp) => {
      if (_.isString(mask)) {
        return nanomatch.isMatch(action, mask, { unixify: false });
      } else if (_.isRegExp(mask)) {
        return mask.test(action);
      }
    }) != null;
  }

  /**
   * ProcessRoute
   * Here we check if authorization method exists on
   * the route and set the default mappingPolicy
   * @param route 
   */
  @Method
  private ProcessRoute(route: route) : route {
    if(route.name === SYS.INTERNAL) {
      throw new Error(`'INTERNAL' route name is reserved, please use something else.`);
    }

    // Check if we have a valid authorization method.
    if (route.authorization) {
      if (!_.isFunction(this.authorization)) {
        this.logger.warn('No authorization method, please define one to use authorization. Route will now be unprotected.');
        route.authorization = false;
      }
    }

    if (!route.mappingPolicy)
      route.mappingPolicy = 'all';

    return route;
  }

  /**
   * FindRoute
   * @param name 
   */
  @Method
  private FindRoute(name: string, action: string) : Bluebird<{ route: route, action: string }> {
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
          if (route.whitelist && route.whitelist.length > 0 && route.mappingPolicy == 'strict') {
            if (!this.checkWhitelist(route, action))
              continue;
          }
  
          return resolve({ route, action }); // must resolve action as it could be an alias.
        }
  
        return reject(new RouteNotFound());
      }
    });
  }


  /**
   * CallAction
   * @param sender Client
   * @param name string
   * @param _action string
   * @param params ActionParams
   * @Note: No native promises & async/await as it hurts performance, if you need another performance kick, consider converting all promises to callbacks.
   */
  @Method
  public CallAction(sender: Client, name: string, _action: string, params: moleculer.ActionParams) : Bluebird<any> {
    return new Bluebird.Promise((resolve, reject) => {
      this.FindRoute(name, _action).then(({ route, action }) => {

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

        let ctx: moleculer.Context = moleculer.Context.create(this.broker, { name: this.name, handler: _.noop}, this.broker.nodeID, params, {});
        (ctx as any)._metricStart(ctx.metrics);

        if (route.onBeforeCall) {
          // In beforecall you can modify the params and the context.
          Bluebird.Promise.resolve(route.onBeforeCall.call(this, ctx, {
              action,
              sender: {
                socket: sender.socket,
                props: sender.props
              },
              params
          })).then(result => {
            if (result) { // Override anything if the beforeCall returns them.
              if (result.ctx)
                ctx = result.ctx;
  
              if (result.params)
                params = result.params
            }
          }).catch(reject);
        }

        return ctx.call(endpoint, params).then((res) => {
          // In aftercall you can modify the result.
          if (route.onAfterCall) {
            Bluebird.Promise.resolve(route.onAfterCall.call(this, ctx, {
              action,
              sender: {
                socket: sender.socket,
                props: sender.props
              },
              params
            }, res)).then((result) => {
              if (result)
                res = result;
            }).catch(reject);
          }

          (ctx as any)._metricFinish(null, ctx.metrics);
          resolve(res);
        }).catch(reject);
      }).catch(err => {
        if (!err)
          return;

        if (err.ctx) {
          err.ctx._metricFinish(null, err.ctx.metrics);
        }

        return reject(err);
      });
    });
  }
}