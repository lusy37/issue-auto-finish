import {GitHubClient} from './clients/GitHubClient.js';
import {createGitHubRouter} from './web/routes/github.js';
import {IssueTracker} from './tracker/IssueTracker.js';
import {buildPlanModePipeline,createLifecycleManager} from './pipeline/PipelineDefinition.js';
import {resolveDataDir} from './paths.js';
import {createTaskRouter} from './web/routes/tasks.js';
import {loadConfig} from './config.js';
import {createSetupRouter} from './web/routes/setup.js';
import {createApp} from './web/createApp.js';
export {createApp} from './web/createApp.js';
export async function main(): Promise<void> {
  const config = loadConfig();
  const pipeline=buildPlanModePipeline({e2eEnabled:true});
  const tracker=new IssueTracker(resolveDataDir(),new Map([[pipeline.mode,createLifecycleManager(pipeline)]]));
  const app = createApp(config.web.frontendDistDir,[createSetupRouter(config),createGitHubRouter(new GitHubClient(config.github)),createTaskRouter(tracker,new GitHubClient(config.github),config)]);
  const server = app.listen(config.web.port,config.web.host,()=>console.log('工作台：http://'+config.web.host+':'+config.web.port));
  process.once('SIGINT',()=>server.close());
  process.once('SIGTERM',()=>server.close());
}
