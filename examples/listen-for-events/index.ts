import moleculer = require('moleculer');
import { Service, Action, Method } from 'moleculer-decorators';
import { WSGateway, Settings, route, Request, BaseClass } from '../../';
import Bluebird = require('bluebird');

@Service({
  mixins: [WSGateway],
  settings: <Settings>{
    port: 3000,
    path: '/',
    routes: []
  }
})
class Gateway extends BaseClass {
  created() {
    this.on('someEvent', (data, client, respond) => {
      // to respond to this particular request (if client wants a response)
      respond('Any error here', {
        data: 'any data here to respond with'
      });

      this.emit('event', { data: 'some data' }); // to send to everyone on this node
      this.broadcast('event', { data: 'some data' }); // to send to everyone on all nodes
      this.send(client.id, 'event', { data: 'some data' }); // to send to a client with client id (will still send to the client if he's on another node)
    });
  }
}
