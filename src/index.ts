import {loadConfig} from './config.js';
import {createSetupRouter} from './web/routes/setup.js';
import {createApp} from './web/createApp.js';
export {createApp} from './web/createApp.js';
export async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config.web.frontendDistDir,[createSetupRouter(config)]);
  const server = app.listen(config.web.port,config.web.host,()=>console.log('工作台：http://'+config.web.host+':'+config.web.port));
  process.once('SIGINT',()=>server.close());
  process.once('SIGTERM',()=>server.close());
}
