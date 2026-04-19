import type { NexusApi } from '../preload/preload';

declare global {
  interface Window {
    nexus: NexusApi;
  }
}
