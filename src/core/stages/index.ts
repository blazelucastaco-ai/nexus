// Pipeline stages barrel — re-exports all stages for ergonomic import.

export { injectionGuardStage } from './injection-guard-stage.js';
export { frustrationStage, detectFrustrationScore } from './frustration-stage.js';
export { makeSessionLoadStage, type SessionLoadDeps } from './session-load-stage.js';
