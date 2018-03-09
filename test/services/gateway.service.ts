import moleculer = require('moleculer');
import { Service, Action, Method } from 'moleculer-decorators';
import { WSGateway, Settings, route, Request, BaseClass } from '../../src/index';
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
    this.on('test.respond', (data, client, respond) => {
      respond(null, data);
    });

    this.on('test.respond.emit', (data, client) => {
      this.emit('test.respond.emit', data);
    });

    this.on('test.respond.send', (data, client) => {
      this.send(client.id, 'test.respond.emit', data);
    });
  }

  @Action()
  EchoParams(ctx) {
    return Bluebird.resolve(ctx.params);
  }
}

module.exports = Gateway;