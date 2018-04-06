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
    this.on('connection', client => {
      this.logger.info(`Client ${client.id} has connected`);
    });

    this.on('disconnect', client => {
      // Client only contains "id", "props", "authorized" since we can't communicate with him anymore
      this.logger.info(`Client ${client.props.username} has disconnected`);
    });

    this.on('someEvent', (client, data, respond) => {
      // to respond to this particular request (if client wants a response)
      respond('Any error here', {
        data: 'any data here to respond with'
      });

      this.emit('eventName', { data: 'some data' }); // to send to everyone on this node
      this.broadcast('eventName', { stuff: 'some stuff' }); // to send to everyone on all nodes
      this.send(client.id, 'eventName', { foo: 'bar' }); // to send to a client with client id (will still send to the client if he's on another node)
    });
  }
}
