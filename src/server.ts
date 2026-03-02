import { loadEnv } from './config/env.js';
import { createApp } from './app.js';

const config = loadEnv();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(`bank-api listening on port ${config.port}`);
});
