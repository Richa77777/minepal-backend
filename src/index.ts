import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import { server as WebSocketServer } from 'websocket';
import { setupDeepgram } from './deepgram';
import { ListenLiveClient } from '@deepgram/sdk';
import openaiRoutes from './routes/openai';

const isLocalTest = process.env.LOCAL_TEST === 'true';
const port = parseInt(process.env.PORT || '11111', 10);

const fastify: FastifyInstance = Fastify(); // Отключаем SSL для локальной разработки

// Регистрируем плагины
fastify.register(fastifyCors, {
    origin: '*',
    credentials: true,
});
fastify.register(openaiRoutes);

// Простая проверка соединения
fastify.get('/ping', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.send('pong');
});

const startServer = async () => {
    try {
        const address = await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`Server running at ${address}`);

        // Настроим WebSocket сервер
        const wsServer = new WebSocketServer({
            httpServer: fastify.server,
            autoAcceptConnections: false,
        });

        wsServer.on('request', (request) => {
            const connection = request.accept(null, request.origin);
            console.log('socket: client connected');

            const queryString = new URLSearchParams(request.resourceURL.query as Record<string, string>).toString();
            const urlParams = new URLSearchParams(queryString);
            const language = urlParams.get('language') || 'en';

            let deepgram: ListenLiveClient | null = setupDeepgram(connection, language);

            connection.on('message', (message) => {
                if (deepgram && message.type === 'binary' && deepgram.getReadyState() === 1) {
                    deepgram.send(message.binaryData);
                } else if (deepgram && deepgram.getReadyState() >= 2) {
                    console.log("socket: data couldn't be sent to deepgram");
                    console.log('socket: retrying connection to deepgram');
                    deepgram.requestClose();
                    deepgram.removeAllListeners();
                    deepgram = null;
                } else {
                    console.log("socket: data couldn't be sent to deepgram");
                }
            });

            connection.on('close', () => {
                console.log('socket: client disconnected');
                if (deepgram) {
                    deepgram.requestClose();
                    deepgram.removeAllListeners();
                    deepgram = null;
                }
            });
        });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

startServer();