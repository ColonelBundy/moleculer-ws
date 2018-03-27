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
    encryption: 'JSON',
    path: '/',
    routes: []
  }
})
class Gateway extends BaseClass {
  created() {
    this.on('callEvent', (data, client, respond) => {
      respond(null, data);
    });

    this.on('emit', (data, client) => {
      this.emit('emit', data);
    });

    this.on('send', (data, client) => {
      this.send(client.id, 'send', data);
    });
  }

  @Action()
  EchoParams(ctx) {
    return Bluebird.resolve(ctx.params);
  }

  @Method
  authorize(ctx) {}
}

module.exports = Gateway;
