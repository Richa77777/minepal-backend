import { AgentProcess } from './src/process/agent-process.js';
import settings from './settings.json' assert { type: 'json' };
import express from 'express';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { getKey } from './src/utils/keys.js';
import fs from 'fs';
import basicAuth from 'express-basic-auth';
import cors from 'cors';

const argv = yargs(hideBin(process.argv)).argv;

let profiles = settings.profiles;
let load_memory = settings.load_memory;
let init_message = settings.init_message;
let agentProcessStarted = false;
let agentProcesses = [];

if (argv.mode === 'server') {
    const app = express();
    const port = 10101;
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });

    // Configure CORS to allow credentials
    app.use(cors({
        origin: ['http://localhost', 'http://localhost:5173', 'http://localhost:4173'],
        credentials: true
    }));

    // Add HTTP Basic Auth
    app.use(basicAuth({
        users: { 'hi': 'there' },
        challenge: true,
        realm: 'MinePal'
    }));

    // Debugging middleware to log incoming requests
    app.use((req, res, next) => {
        console.log(`Incoming request: ${req.method} ${req.url}`);
        next();
    });

    const deepgramClient = createClient(getKey('DEEPGRAM_API_KEY'));
    let keepAlive;

    const setupDeepgram = (ws) => {
        const deepgram = deepgramClient.listen.live({
            language: "en",
            punctuate: true,
            smart_format: true,
            model: "nova",
        });

        if (keepAlive) clearInterval(keepAlive);
        keepAlive = setInterval(() => {
            deepgram.keepAlive();
        }, 10 * 1000);

        deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
            console.log("deepgram: connected");

            deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel.alternatives[0].transcript;
                ws.send(JSON.stringify(data));
                agentProcesses.forEach(agentProcess => {
                    if (transcript.trim() !== '') {
                        agentProcess.sendTranscription(transcript);
                    }
                });
            });

            deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
                console.log("deepgram: disconnected");
                clearInterval(keepAlive);
                deepgram.requestClose();
            });

            deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
                console.log("deepgram: error received");
                console.error(error);
            });
            deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
                console.log("deepgram: warning received");
                console.warn(warning);
            });

            deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
                ws.send(JSON.stringify({ metadata: data }));
            });
        });

        return deepgram;
    };

    wss.on("connection", (ws) => {
        console.log("socket: client connected");
        let deepgram = setupDeepgram(ws);

        ws.on("message", (message) => {
            if (deepgram.getReadyState() === 1) {
                deepgram.send(message);
            } else if (deepgram.getReadyState() >= 2) {
                console.log("socket: data couldn't be sent to deepgram");
                console.log("socket: retrying connection to deepgram");
                deepgram.requestClose();
                deepgram.removeAllListeners();
                deepgram = setupDeepgram(ws);
            } else {
                console.log("socket: data couldn't be sent to deepgram");
            }
        });

        ws.on("close", () => {
            console.log("socket: client disconnected");
            deepgram.requestClose();
            deepgram.removeAllListeners();
            deepgram = null;
        });
    });

    app.get('/settings', (req, res) => {
        console.log('API: GET /settings called');
        res.json(settings);
    });

    app.get('/agent-status', (req, res) => {
        console.log('API: GET /agent-status called');
        res.json({ agentStarted: agentProcessStarted });
    });
    
    app.post('/stop', (req, res) => {
        console.log('API: POST /stop called');
        if (!agentProcessStarted) {
            console.log('API: No agent processes running');
            return res.status(404).send('No agent processes are currently running.');
        }

        agentProcesses.forEach(agentProcess => {
            agentProcess.agentProcess.kill('SIGTERM');;
        });

        agentProcesses = [];
        agentProcessStarted = false;

        console.log('API: All agent processes stopped');
        res.send('All agent processes have been stopped.');
    });

    app.post('/start', express.json(), (req, res) => {
        console.log('API: POST /start called');
        if (agentProcessStarted) {
            console.log('API: Agent process already started');
            return res.status(409).send('Agent process already started. Restart not allowed.');
        }

        const newSettings = req.body;
        // Check for empty fields in newSettings
        const emptyFields = Object.entries(newSettings)
            .filter(([key, value]) => {
                if (key === 'profiles') return !Array.isArray(value) || value.length === 0;
                return value === "" || value === null || value === undefined;
            })
            .map(([key]) => key);
        
        if (emptyFields.length > 0) {
            return res.status(400).json({
                error: "Empty fields not allowed",
                emptyFields: emptyFields
            });
        }
        
        Object.assign(settings, newSettings);
        fs.writeFileSync('settings.json', JSON.stringify(settings, null, 4));

        profiles = settings.profiles;
        load_memory = settings.load_memory;
        init_message = settings.init_message;

        for (let profile of profiles) {
            const agentProcess = new AgentProcess();
            agentProcess.start(profile, load_memory, init_message);
            agentProcesses.push(agentProcess);
        }
        agentProcessStarted = true;
        console.log('API: Settings updated and AgentProcess started for all profiles');
        res.send('Settings updated and AgentProcess started for all profiles');
    });

    const shutdown = () => {
        console.log('Shutting down gracefully...');
        if (agentProcessStarted) {
            agentProcesses.forEach(agentProcess => {
                agentProcess.agentProcess.kill('SIGTERM');
            });
            agentProcesses = [];
            agentProcessStarted = false;
        }
        server.close(() => {
            console.log('HTTP server closed');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    server.listen(port, '0.0.0.0', () => {
        console.log(`Server running at http://0.0.0.0:${port}`);
    });
} else {
    for (let profile of profiles) {
        const agentProcess = new AgentProcess();
        agentProcess.start(profile, load_memory, init_message);
        agentProcesses.push(agentProcess);
    }
    agentProcessStarted = true;
}