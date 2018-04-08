import moleculer = require('moleculer');
import { Service, Action, Method } from 'moleculer-decorators';
import {
  WSGateway,
  Settings,
  route,
  Request,
  BaseClass,
  Client
} from '../../src/index';
import Bluebird = require('bluebird');

@Service({
  mixins: [WSGateway],
  settings: {
    port: 3000,
    path: '/',
    routes: [
      <route>{
        name: 'test'
      }
    ]
  }
})
class Gateway extends BaseClass {
  created() {
    this.on('CallEvent', (client, data, respond) => {
      respond(null, data);
    });

    this.on('CallEventError', (client, data, respond) => {
      respond('Some error');
    });

    this.on('EmitEvent', (client, data, respond) => {
      this.send(client.id, 'EmitEvent', data);
    });

    this.on('onBeforeEvent', (client, data, respond) => {
      respond(null, data);
    });

    this.on('onAfterEvent', (client, data, respond) => {
      respond(null, data);
    });
  }

  @Method
  onBeforeEvent(client, event, data) {
    if (event === 'onBeforeEvent') {
      this.logger.warn(data);
      return {
        wrong: 'data'
      };
    }

    return data;
  }

  @Method
  onAfterEvent(
    client: Client,
    event: string,
    err: string,
    data: moleculer.GenericObject
  ) {
    if (event === 'onAfterEvent') {
      data['after'] = 'nice';
    }

    if (err) {
      return Bluebird.reject(err);
    }

    return data;
  }

  @Method
  onError(client: Client, error: Error) {
    return Bluebird.resolve(error);
  }

  @Action()
  ErrorAction(ctx: moleculer.Context) {
    return Bluebird.reject('Some error');
  }

  @Action()
  EchoParams(ctx: moleculer.Context) {
    return Bluebird.resolve(ctx.params);
  }

  @Action()
  EmitAction(ctx: moleculer.Context) {
    this.send(ctx.meta.client.id, 'EmitAction', ctx.params);
    return Bluebird.resolve();
  }

  @Method
  authorize(client: Client, params: moleculer.GenericObject) {
    if (params.username == 'test' && params.password == 'test') {
      client.props.username = 'test'; // set client prop
      return Bluebird.resolve();
    }

    return Bluebird.reject('Invalid login');
  }

  @Method
  deauthorize(client: Client, params: moleculer.GenericObject) {
    client.props = {};
    return Bluebird.resolve('Done');
  }
}

module.exports = Gateway;
