import 'dotenv/config';
import { AIManager } from '../ai/index.js';
import { DreamingEngine } from '../brain/dreaming.js';
import { getDatabase } from '../memory/database.js';

// Ensure DB is initialized (runs migrations)
getDatabase();

const ai = new AIManager('anthropic');
const engine = new DreamingEngine(ai);

engine
  .runDreamCycle()
  .then((report) => {
    console.log(JSON.stringify(report));
    process.exit(0);
  })
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
