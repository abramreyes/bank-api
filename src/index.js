import { loadEnv } from './config/env.js';
import { createApp } from './app.js';

const config = loadEnv();

export default createApp(config);
