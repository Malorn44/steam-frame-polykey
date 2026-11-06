// Bundle entry, evaluated in Steam's SharedJSContext by the sidecar.
import { installPolykey } from './main.js';

try {
  installPolykey();
} catch (error) {
  console.warn(
    '[polykey] install failed; stock keyboard left untouched:',
    error instanceof Error ? error.name : typeof error,
  );
}
