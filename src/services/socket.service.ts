import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';

export class SocketService {
  private static io: Server;

  static initialize(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`Client connected: ${socket.id}`);
      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });
  }

  static emitProgress(jobId: string, progressData: any) {
    if (this.io) {
      this.io.emit(`progress:${jobId}`, progressData);
    }
  }
}
