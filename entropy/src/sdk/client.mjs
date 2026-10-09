/**
 * ESM wrapper around the CommonJS Entropy SDK so `import { EntropyClient }`
 * works in modern tooling without a build step.
 */
import pkg from './client.js';

export const EntropyClient = pkg.EntropyClient;
export const EntropyApiError = pkg.EntropyApiError;
export default pkg;
