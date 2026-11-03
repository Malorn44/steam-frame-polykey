// Bundle entry, evaluated in Steam's SharedJSContext by the sidecar.
import { installSpike } from './spike.js';

try {
  installSpike();
} catch (error) {
  console.warn('[polykey] install failed; stock keyboard left untouched:', error instanceof Error ? error.name : typeof error);
}
