import moleculer = require('moleculer');
import { Service, Action, Method } from 'moleculer-decorators';
import {
  WSGateway,
  Settings,
  route,
  Request,
  BaseClass
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
    this.on('CallEvent', (data, client, respond) => {
      respond(null, data);
    });

    this.on('EmitEvent', (data, client, respond) => {
      this.send(client.id, 'EmitEvent', data);
    });
  }

  @Action()
  EchoParams(ctx) {
    return Bluebird.resolve(ctx.params);
  }

  @Action()
  EmitAction(ctx) {
    this.send(ctx.meta.client.id, 'EmitAction', ctx.params);
    return Bluebird.resolve();
  }
}

module.exports = Gateway;
