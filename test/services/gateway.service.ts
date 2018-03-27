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
    this.on('callEvent', (data, client_id, respond) => {
      respond(null, data);
    });

    this.on('emit', (data, client_id) => {
      this.emit('emit', data);
    });

    this.on('send', (data, client_id) => {
      this.send(client_id, 'send', data);
    });
  }

  @Action()
  EchoParams(ctx) {
    return Bluebird.resolve(ctx.params);
  }
}

module.exports = Gateway;
